import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { createSha256, decompressChunk, rawSizeAt } from "@codec/index";
import { openRecvSink, type ChunkSink } from "./recvStore";

interface SessionMeta {
  id: string;
  status: string;
  expiresAt: number;
  fileName: string;
  mimeType: string;
  size: number;
  sha256: string;
  chunkSize: number;
  chunkCount: number;
  compression: string;
}

interface ChunkInfo {
  index: number;
  sha256: string;
  storedSize: number;
}

interface SessionInfo {
  meta: SessionMeta;
  chunks: ChunkInfo[];
}

const fmt = (n: number): string => {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function sha256Of(bytes: Uint8Array): Promise<string> {
  const h = createSha256();
  h.update(bytes);
  return h.digestHex();
}

type Stage = "authing" | "waiting" | "downloading" | "verifying" | "done" | "error";

export function ReceivePage({ share }: { share: string }): JSX.Element {
  const [stage, setStage] = useState<Stage>("authing");
  const [meta, setMeta] = useState<SessionMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [peerStatus, setPeerStatus] = useState("");
  const [complete, setComplete] = useState(0);
  const [chunkCount, setChunkCount] = useState(1);
  const [overallSha, setOverallSha] = useState("");
  const [backend, setBackend] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const sinkRef = useRef<ChunkSink | null>(null);
  const resumedRef = useRef(false);
  const metaRef = useRef<SessionMeta | null>(null);
  const stoppedRef = useRef(false);

  const [id, token] = share.includes(".") ? [share.split(".")[0], share.split(".")[1]] : ["", ""];

  const api = useCallback(
    (path: string, init?: globalThis.RequestInit): Promise<globalThis.Response> =>
      fetch(`/api/v1${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) } }),
    [token]
  );

  const fetchSession = useCallback(async (): Promise<SessionInfo> => {
    const r = await api(`/sessions/${id}?role=receiver`);
    if (r.status === 404) throw new Error("transfer link not found (expired or deleted)");
    if (r.status === 401) throw new Error("invalid transfer token");
    const j = (await r.json()) as {
      session: { meta: SessionMeta; chunks: ChunkInfo[]; status: string; expiresAt: number };
    };
    return {
      meta: { ...j.session.meta, status: j.session.status, expiresAt: j.session.expiresAt },
      chunks: j.session.chunks ?? [],
    };
  }, [api, id]);

  const downloadChunk = useCallback(
    async (index: number, meta: SessionMeta): Promise<Uint8Array | null> => {
      try {
        const r = await api(`/sessions/${id}/chunks/${index}?role=receiver`);
        if (!r.ok) return null;
        const declared = (r.headers.get("x-chunk-sha256") ?? "").toLowerCase();
        const buf = new Uint8Array(await r.arrayBuffer());
        console.debug(`[zui-hash] in ${index} len=${buf.byteLength}`);
        if (declared && (await sha256Of(buf)) !== declared) {
          console.debug(`[zui-hash] MISMATCH ${index}`);
          throw new Error(`chunk ${index} failed its SHA-256 check`);
        }
        console.debug(`[zui-hash] ok ${index}`);
        if (meta.compression !== "deflate-raw") return buf;
        // Stage 3 — enhance: bytes that travelled compressed get restored to
        // the exact original slice before being written to the file.
        const raw = await decompressChunk("deflate-raw", buf);
        const expected = rawSizeAt(meta.size, meta.chunkSize, index, meta.chunkCount);
        if (raw.byteLength !== expected) {
          throw new Error(`chunk ${index} decompressed to ${raw.byteLength} bytes, expected ${expected}`);
        }
        return raw;
      } catch {
        return null;
      }
    },
    [api, id]
  );

  // Main pull loop: poll session, download available chunks with per-chunk
  // verification, resume automatically after interruptions, then verify.
  useEffect(() => {
    let cancelled = false;
    stoppedRef.current = false;
    setPreviewUrl(null);
    (async () => {
      try {
        const first = await fetchSession();
        if (cancelled) return;
        metaRef.current = first.meta;
        setMeta(first.meta);
        setChunkCount(first.meta.chunkCount);
        setStage(first.meta.status === "sealed" ? "downloading" : "waiting");
      } catch (e) {
        if (!cancelled) {
          setStage("error");
          setError((e as Error).message);
        }
        return;
      }

      while (!cancelled && !stoppedRef.current) {
        let info: SessionInfo | null = null;
        try {
          info = await fetchSession();
        } catch {
          await sleep(1500);
          continue;
        }
        if (cancelled) return;
        const m = info.meta;
        metaRef.current = m;
        setMeta(m);
        setChunkCount(m.chunkCount);
        if (m.status === "cancelled") {
          setStage("error");
          setError("transfer was cancelled by the sender");
          return;
        }
        if (m.status === "expired") {
          setStage("error");
          setError("transfer link has expired");
          return;
        }
        if (m.status === "uploading") {
          setPeerStatus(`sender is uploading — ${info.chunks.length}/${m.chunkCount} chunks arrived`);
          setStage("waiting");
        } else {
          setPeerStatus("");
          setStage((prev) => (prev === "waiting" || prev === "downloading" ? "downloading" : prev));
        }

        if (!sinkRef.current) {
          const sink = await openRecvSink(id);
          setBackend(sink.kind);
          await sink.open();
          sinkRef.current = sink;
          const done = await sink.completedChunks();
          if (done > 0) {
            resumedRef.current = true;
            setComplete(done);
          }
        }
        const sink = sinkRef.current;
        if (!resumedRef.current) {
          resumedRef.current = true;
          const completed = await sink.completedChunks();
          setComplete(Math.min(completed, info.chunks.length));
        }

        for (const ci of info.chunks) {
          if (cancelled) return;
          const completed = await sink.completedChunks();
          if (ci.index < completed) continue;
          const buf = await downloadChunk(ci.index, m);
          if (!buf) continue;
          await sink.writeChunk(ci.index, buf);
          setComplete(completed + 1);
        }

        if ((await sink.completedChunks()) >= m.chunkCount) {
          setStage("verifying");
          break;
        }
        await sleep(1200);
      }
    })();
    return () => {
      cancelled = true;
      stoppedRef.current = true;
    };
  }, [share]);

  // Final SHA-256 verification (streaming over 2 MiB parts — no full concat)
  useEffect(() => {
    if (stage !== "verifying") return;
    let cancelled = false;
    (async () => {
      const m = metaRef.current;
      const sink = sinkRef.current;
      if (!m || !sink) return;
      try {
        await sink.finish();
        const hasher = createSha256();
        await sink.readAll(async (chunk) => {
          if (cancelled) return;
          hasher.update(chunk);
        });
        const digest = await hasher.digestHex();
        if (cancelled) return;
        setOverallSha(digest);
        if (digest !== m.sha256) {
          setStage("error");
          setError(`SHA-256 mismatch — expected ${m.sha256}, received ${digest}`);
          return;
        }
        setStage("done");
      } catch (e) {
        if (!cancelled) {
          setStage("error");
          setError((e as Error).message);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [stage, fetchSession]);

  useEffect(() => {
    if (stage !== "done" || !meta) return;
    let active = true;
    const sink = sinkRef.current;
    if (!sink) return;

    const isImage = meta.mimeType.startsWith("image/") || /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(meta.fileName);
    const isVideo = meta.mimeType.startsWith("video/") || /\.(mp4|webm|ogg|mov)$/i.test(meta.fileName);

    if (isImage || isVideo) {
      (async () => {
        try {
          let blob: Blob;
          if (sink.getFile) {
            blob = await sink.getFile();
          } else {
            const chunks: Uint8Array[] = [];
            await sink.readAll(async (chunk) => {
              chunks.push(chunk);
            });
            blob = new Blob(chunks as unknown as BlobPart[]);
          }
          if (!active) return;

          let mime = meta.mimeType;
          if (!mime || mime === "application/octet-stream" || mime === "binary") {
            if (/\.(jpg|jpeg)$/i.test(meta.fileName)) mime = "image/jpeg";
            else if (/\.png$/i.test(meta.fileName)) mime = "image/png";
            else if (/\.gif$/i.test(meta.fileName)) mime = "image/gif";
            else if (/\.webp$/i.test(meta.fileName)) mime = "image/webp";
            else if (/\.svg$/i.test(meta.fileName)) mime = "image/svg+xml";
            else if (/\.mp4$/i.test(meta.fileName)) mime = "video/mp4";
            else if (/\.webm$/i.test(meta.fileName)) mime = "video/webm";
            else if (/\.ogg$/i.test(meta.fileName)) mime = "video/ogg";
            else if (/\.mov$/i.test(meta.fileName)) mime = "video/quicktime";
          }

          const typedBlob = blob.type === mime ? blob : new Blob([blob], { type: mime });
          const url = URL.createObjectURL(typedBlob);
          if (active) {
            setPreviewUrl(url);
          }
        } catch (e) {
          console.error("Failed to generate preview URL", e);
        }
      })();
    }

    return () => {
      active = false;
    };
  }, [stage, meta]);

  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  const downloadOriginal = useCallback(() => {
    const m = metaRef.current;
    const sink = sinkRef.current;
    if (!m || !sink || stage !== "done") return;
    void sink.saveToUserFile(m.fileName, m.mimeType || "application/octet-stream");
  }, [stage]);

  return (
    <section className="receive">
      <h1>Receive a file</h1>
      <p className="description">
        Secure inbound transfer — chunks are downloaded, verified one by one, and
        the whole file is only declared ready after its SHA-256 matches the sender&apos;s.
      </p>

      {stage === "authing" && <p className="stage-line">Authenticating transfer link…</p>}

      {meta && (
        <div className="recv-card">
          <dl className="kv">
            <dt>File</dt><dd className="recv-name">{meta.fileName}</dd>
            <dt>Size</dt><dd>{fmt(meta.size)}</dd>
            <dt>Type</dt><dd>{meta.mimeType || "binary"}</dd>
            <dt>Chunks</dt><dd>{meta.chunkCount} × {fmt(meta.chunkSize)}</dd>
            <dt>Travel</dt><dd>{meta.compression === "deflate-raw" ? "compressed (deflate-raw), restored here" : "raw bytes"}</dd>
            <dt>SHA-256</dt><dd className="mono">{meta.sha256}</dd>
            <dt>Expires</dt><dd>{new Date(meta.expiresAt).toLocaleString()}</dd>
            <dt>Storage</dt><dd className="backend-line">{backend ? `disk-backed (${backend})` : "detecting…"}</dd>
          </dl>
        </div>
      )}

      {stage === "error" ? (
        <div className="error-banner">✗ {error}</div>
      ) : stage !== "authing" && meta ? (
        <>
          <div className="progress-wrap">
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${Math.round((complete / chunkCount) * 100)}%` }} />
            </div>
            <span className="progress-label">
              {stage === "waiting" && `${peerStatus || "waiting for the sender…"}`}
              {stage === "downloading" &&
                `${meta.compression === "deflate-raw" ? "downloading & decompressing (enhancing) chunks" : "downloading & verifying chunks"} — ${complete}/${chunkCount}`}
              {stage === "verifying" && "verifying SHA-256 of the full file…"}
              {stage === "done" && "verified"}
            </span>
            {stage === "waiting" && (
              <span className="progress-label waiting-note">
                0% is normal here — nothing has arrived yet. This tab retries by itself, so you can leave it open.
              </span>
            )}
          </div>

          {stage === "done" && (
            <div className="recv-done">
              <div className="success">✓ SHA-256 verified for {meta.fileName}</div>
              <div className="mono sha-line">expected: {meta.sha256}</div>
              <div className="mono sha-line">received: {overallSha}</div>
              {previewUrl && (
                <div className="recv-preview">
                  {meta.mimeType.startsWith("image/") || /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(meta.fileName) ? (
                    <img src={previewUrl} alt={meta.fileName} />
                  ) : (
                    <video src={previewUrl} controls />
                  )}
                </div>
              )}
              <button className="btn primary" onClick={downloadOriginal}>
                Download {meta.fileName}
              </button>
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}
