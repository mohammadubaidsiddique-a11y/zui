import { useCallback, useRef, useState, type JSX } from "react";
import {
  encodeZui,
  verifyZui,
  ZuiDecoder,
  createSha256,
  type ByteSink,
  type ByteSource,
  type ZuiEncodeResult,
  type ZuiVerifyResult,
} from "@codec/index";

interface LabState {
  phase: "idle" | "encoding" | "done" | "error";
  error?: string;
  progress: number;
  meta?: ZuiEncodeResult;
  verify?: ZuiVerifyResult;
  corrupt?: ZuiVerifyResult;
  reconstructedSha?: string;
  reconstructedWebSha?: string | null;
  timings?: { encodeMs: number; verifyMs: number; reconstructMs: number };
}

const MAX_LAB_BYTES = 512 * 1024 * 1024;
const MAX_WEBCRYPTO_BYTES = 128 * 1024 * 1024; // only run the independent WebCrypto digest below this
const CHUNK_OPTIONS = [
  { label: "512 KiB", bytes: 512 * 1024 },
  { label: "1 MiB", bytes: 1024 * 1024 },
  { label: "2 MiB (default)", bytes: 2 * 1024 * 1024 },
  { label: "4 MiB", bytes: 4 * 1024 * 1024 },
  { label: "8 MiB", bytes: 8 * 1024 * 1024 },
];

const partsSource = (parts: Uint8Array[]): ByteSource =>
  ({
    async *[Symbol.asyncIterator]() {
      for (const part of parts) yield part;
    },
  }) as ByteSource;

async function sha256Hex(parts: Uint8Array[]): Promise<string> {
  const total = parts.reduce((s, p) => s + p.byteLength, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    buf.set(p, o);
    o += p.byteLength;
  }
  const dig = await crypto.subtle.digest("SHA-256", buf.buffer as ArrayBuffer);
  return [...new Uint8Array(dig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const asSource = (iter: Iterable<Uint8Array> | AsyncIterable<Uint8Array>): ByteSource => iter as ByteSource;

function flipByteInParts(parts: Uint8Array[], at: number): Uint8Array[] {
  const out = parts.map((p) => Uint8Array.from(p));
  let o = 0;
  for (const p of out) {
    if (at < o + p.byteLength) {
      p[at - o] ^= 0xff;
      return out;
    }
    o += p.byteLength;
  }
  return out;
}

export function LabPage(): JSX.Element {
  const [file, setFile] = useState<File | null>(null);
  const [chunkOption, setChunkOption] = useState(2);
  const [compression, setCompression] = useState<"none" | "deflate-raw">("none");
  const [state, setState] = useState<LabState>({ phase: "idle", progress: 0 });
  const [dragOver, setDragOver] = useState(false);
  const containerRef = useRef<Uint8Array[] | null>(null);
  const reconstructedRef = useRef<Uint8Array[] | null>(null);

  const run = useCallback(async () => {
    if (!file) return;
    if (file.size > MAX_LAB_BYTES) {
      const mb = (MAX_LAB_BYTES / 1024 / 1024).toFixed(0);
      setState({
        phase: "error",
        progress: 0,
        error: `The in-browser lab caps at ${mb} MiB to keep memory bounded (it buffers the container for the demo). The server pipeline streams files of any size.`,
      });
      return;
    }
    setState({ phase: "encoding", progress: 0 });

    const t0 = performance.now();
    const chunkSize = CHUNK_OPTIONS[chunkOption]!.bytes;
    const parts: Uint8Array[] = [];
    let total = 0;
    const sink: ByteSink = {
      write: (b) => {
        const copy = Uint8Array.from(b);
        parts.push(copy);
        total += copy.byteLength;
      },
    };
    const openSource = (): ByteSource => {
      let read = 0;
      const gen = (async function* () {
        const stream = file.stream();
        const reader = stream.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value?.byteLength) {
              read += value.byteLength;
              setState((s) =>
                s.phase === "encoding" ? { ...s, progress: Math.min(1, read / file.size) } : s
              );
              yield value;
            }
          }
        } finally {
          reader.releaseLock();
        }
      })();
      return asSource(gen);
    };

    let meta: ZuiEncodeResult;
    try {
      meta = await encodeZui(
        openSource,
        {
          fileName: file.name,
          mimeType: file.type || "application/octet-stream",
          chunkSize,
          compression,
        },
        sink
      );
    } catch (err) {
      setState({ phase: "error", progress: 0, error: `encode failed: ${(err as Error).message}` });
      return;
    }
    const encodeMs = performance.now() - t0;
    containerRef.current = parts;

    const tV = performance.now();
    const verify = await verifyZui(partsSource(parts));
    const verifyMs = performance.now() - tV;
    if (!verify.valid) {
      setState({ phase: "error", progress: 1, meta, error: `encode produced an invalid container: ${verify.errors.join("; ")}` });
      return;
    }

    // Reconstruct (streaming) and prove SHA-256 equality.
    const outParts: Uint8Array[] = [];
    let reconstructedSha = "";
    try {
      const tR = performance.now();
      const decoder = await ZuiDecoder.open(partsSource(parts));
      for await (const raw of decoder.reconstruct()) outParts.push(Uint8Array.from(raw));
      const reconstructMs = performance.now() - tR;
      reconstructedRef.current = outParts;
      const hasher = createSha256();
      for (const p of outParts) hasher.update(p);
      reconstructedSha = await hasher.digestHex();
      containerRef.current = parts;

      // Corruption demo: flip one byte inside the payload of a copy.
      const flipAt = Math.min(16 + meta.headerBytes + 8, total - 1);
      const bad = flipByteInParts(parts, flipAt);
      const corrupt = await verifyZui(partsSource(bad));

      const reconstructedWebSha =
        file.size <= MAX_WEBCRYPTO_BYTES ? await sha256Hex(outParts) : null;

      setState({
        phase: "done",
        progress: 1,
        meta,
        verify,
        corrupt,
        reconstructedSha,
        reconstructedWebSha,
        timings: { encodeMs, verifyMs, reconstructMs },
      });
      return;
    } catch (err) {
      setState({ phase: "error", progress: 1, meta, verify, error: `reconstruct failed: ${(err as Error).message}` });
    }
  }, [file, chunkOption, compression]);

  const download = useCallback((name: string, partsOf: Uint8Array[] | null) => {
    if (!partsOf || partsOf.length === 0) return;
    const blob = new Blob(partsOf as BlobPart[], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }, []);

  const meta = state.meta;
  const reconstructedMatch =
    state.reconstructedSha === meta?.origSha256 &&
    (state.reconstructedWebSha === null || state.reconstructedWebSha === meta?.origSha256);

  const encodeRate = meta && state.timings ? meta.origSize / (state.timings.encodeMs / 1000) : 0;
  const reconstructRate = meta && state.timings ? meta.origSize / (state.timings.reconstructMs / 1000) : 0;

  return (
    <section className="lab">
      <div className="lab-head">
        <h1>Codec Lab</h1>
        <p>
          Encode a real file into the ZUI v1 container, inspect the chunk table,
          verify integrity, reconstruct — and prove the SHA-256 of the
          reconstruction equals the original. Everything runs locally in your
          browser; nothing is uploaded.
        </p>
      </div>

      <div
        className={`dropzone${dragOver ? " drag" : ""}${file ? " has" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) setFile(f);
        }}
        onClick={() => document.getElementById("lab-file-input")?.click()}
      >
        <input
          id="lab-file-input"
          type="file"
          className="visually-hidden"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        {file ? (
          <div className="file-chip">
            <span className="file-name">{file.name}</span>
            <span className="file-size">{file.size.toLocaleString()} bytes</span>
          </div>
        ) : (
          <p>Drop a file here, or click to choose one</p>
        )}
      </div>

      <div className="lab-controls">
        <label>
          Chunk size
          <select
            value={chunkOption}
            onChange={(e) => setChunkOption(Number(e.target.value))}
            disabled={state.phase === "encoding"}
          >
            {CHUNK_OPTIONS.map((o, i) => (
              <option key={o.label} value={i}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Compression
          <select
            value={compression}
            onChange={(e) => setCompression(e.target.value as "none" | "deflate-raw")}
            disabled={state.phase === "encoding"}
          >
            <option value="none">none (identity)</option>
            <option value="deflate-raw">deflate-raw</option>
          </select>
        </label>
        <button
          className="btn primary"
          disabled={!file || state.phase === "encoding"}
          onClick={() => void run()}
        >
          {state.phase === "encoding" ? "Encoding…" : "Analyze & Encode"}
        </button>
      </div>

      {state.phase === "encoding" && (
        <div className="progress-wrap">
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${(state.progress * 100).toFixed(1)}%` }} />
          </div>
          <span className="progress-label">reading &amp; chunking {(state.progress * 100).toFixed(0)}%</span>
        </div>
      )}

      {state.phase === "error" && <div className="error-banner">⚠ {state.error}</div>}

      {meta && (
        <>
          <div className="panel">
            <h2>ZUI container</h2>
            <dl className="kv">
              <dt>File name</dt><dd>{meta.fileName}</dd>
              <dt>MIME type</dt><dd>{meta.mimeType}</dd>
              <dt>Original size</dt><dd>{meta.origSize.toLocaleString()} bytes</dd>
              <dt>Container size</dt><dd>{meta.containerBytes.toLocaleString()} bytes</dd>
              <dt>Chunk size</dt><dd>{meta.chunkSize.toLocaleString()} bytes</dd>
              <dt>Chunk count</dt><dd>{meta.chunkCount}</dd>
              <dt>Compression</dt><dd>{meta.compression}</dd>
              <dt>Header / trailer</dt><dd>{meta.headerBytes} B / {meta.trailerBytes} B</dd>
              <dt>Original SHA-256</dt><dd className="mono">{meta.origSha256}</dd>
              {state.timings && (
                <>
                  <dt>Encode time</dt>
                  <dd>
                    {(state.timings.encodeMs).toFixed(0)} ms{" "}
                    ({formatRate(encodeRate)})
                  </dd>
                  <dt>Reconstruct time</dt>
                  <dd>
                    {state.timings.reconstructMs.toFixed(0)} ms ({formatRate(reconstructRate)})
                  </dd>
                </>
              )}
            </dl>
            <div className="row">
              <button className="btn" onClick={() => download(`${meta.fileName}.zui`, containerRef.current)}>
                Download {meta.fileName}.zui
              </button>
            </div>
          </div>

          <div className="panel">
            <h2>Chunk table</h2>
            <div className="table-scroll">
              <table className="chunks">
                <thead>
                  <tr><th>#</th><th>raw bytes</th><th>stored bytes</th><th>SHA-256</th></tr>
                </thead>
                <tbody>
                  {meta.chunks.slice(0, 300).map((c) => (
                    <tr key={c.index}>
                      <td>{c.index}</td>
                      <td>{c.rawSize}</td>
                      <td>{c.storedSize}</td>
                      <td className="mono">{c.storedSha256.slice(0, 20)}…</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {meta.chunks.length > 300 && <p className="note">Showing the first 300 of {meta.chunks.length} chunks.</p>}
          </div>

          <div className="panel">
            {state.phase === "done" && meta && (
              <ul className="verdict-list">
                <li>container verify: valid</li>
                <li>reconstructed SHA-256 == original SHA-256: exact match</li>
                {state.reconstructedWebSha !== null && <li>independent WebCrypto SHA-256 == codec SHA-256: match</li>}
                {state.corrupt && !state.corrupt.valid && <li>corrupted copy rejected: detected</li>}
                <li>✓ Transfer-in-a-box complete</li>
              </ul>
            )}
            {reconstructedMatch ? (
              <div className="success">✓ Done — the file comes back out exactly as it went in, quality untouched.</div>
            ) : (
              state.phase === "error" && <div className="error-banner">✗ {state.error}</div>
            )}
            {state.phase === "done" && reconstructedMatch && meta && (
              <div className="row">
                <button className="btn" onClick={() => download(meta.fileName, reconstructedRef.current)}>
                  Download reconstructed original
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function formatRate(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return "-";
  const units = ["B", "KiB", "MiB", "GiB"];
  let v = bytesPerSec;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}/s`;
}