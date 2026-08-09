/* global BufferSource */
import { useCallback, useRef, useState, type JSX } from "react";
import { encodeZui, verifyZui, ZuiDecoder, probeCompressible, type ByteSink, type ByteSource } from "@codec/index";
import { ShareCard } from "./ShareCard";
import { createOpfsOutFile, downloadOpfsFile, opfsAvailable, type OpfsOutFile } from "./opfs";

const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i += 1;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(1)} ${units[i]}`;
};

const fileSource = (file: File, onProgress?: (frac: number) => void): ByteSource => {
  let read = 0;
  return {
    async *[Symbol.asyncIterator]() {
      const reader = file.stream().getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value?.byteLength) {
            read += value.byteLength;
            onProgress?.(Math.min(1, read / file.size));
            yield value;
          }
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
};

function triggerDownload(name: string, url: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

type SaveHandle = { createWritable(): Promise<FileSystemWritableFileStream> };

async function downloadBlob(name: string, blobParts: BlobPart[], type: string): Promise<void> {
  const blob = new Blob(blobParts, { type });
  const pick = (window as { showSaveFilePicker?: (opts?: unknown) => Promise<SaveHandle> }).showSaveFilePicker;
  if (typeof pick === "function") {
    try {
      const handle = await pick({ suggestedName: name });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      // picker unavailable or failed — fall back to an anchor download
    }
  }
  const url = URL.createObjectURL(blob);
  triggerDownload(name, url);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

interface WrapResult {
  originalName: string;
  originalSize: number;
  containerName: string;
  containerSize: number;
  url?: string;
  opfs?: OpfsOutFile;
}

interface UnwrapResult {
  fileName: string;
  size: number;
  parts: Uint8Array[];
}

type JobState = "idle" | "busy" | "done" | "error";

export function SendPage(): JSX.Element {
  const [wrapResult, setWrapResult] = useState<WrapResult | null>(null);
  const [wrapState, setWrapState] = useState<JobState>("idle");
  const [wrapProgress, setWrapProgress] = useState(0);
  const [wrapError, setWrapError] = useState<string | undefined>();
  const [wrapMode, setWrapMode] = useState<"deflate-raw" | "none">("deflate-raw");

  const [convFile, setConvFile] = useState<File | null>(null);
  const [convResult, setConvResult] = useState<UnwrapResult | null>(null);
  const [convState, setConvState] = useState<JobState>("idle");
  const [convProgress, setConvProgress] = useState(0);
  const [convError, setConvError] = useState<string | undefined>();

  const [dragOver, setDragOver] = useState<"wrap" | "conv" | null>(null);
  const busy = useRef(false);
  const wrapFileRef = useRef<File | null>(null);

  const wrap = useCallback(async (f: File | null) => {
    if (!f || busy.current) return;
    busy.current = true;
    wrapFileRef.current = f;
    setWrapState("busy");
    setWrapProgress(0);
    setWrapResult(null);
    setWrapError(undefined);
    try {
      // Instant path: already-compressed media (video/audio/archives) is
      // entropy-probed and packaged WITHOUT deflate — no CPU burn on 2GB.
      const probeSample = new Uint8Array(await f.slice(0, Math.min(f.size, 512 * 1024)).arrayBuffer());
      const compression =
        probeCompressible(probeSample) || f.size <= 8 * 1024 * 1024 ? "deflate-raw" : ("none" as const);
      setWrapMode(compression);

      // Disk-backed output: the container streams to OPFS and the download
      // streams from there — a multi-GB wrap never lives fully in RAM.
      let total = 0;
      let opfsOut: OpfsOutFile | null = null;
      const memoryParts: Uint8Array[] = [];
      const useOpfs = await opfsAvailable();
      let sink: ByteSink;
      if (useOpfs) {
        opfsOut = await createOpfsOutFile("zui-wrap");
        sink = {
          write: (b) => {
            total += b.byteLength;
            return opfsOut!.writable.write(b as unknown as BufferSource);
          },
        };
      } else {
        sink = {
          write: (b) => {
            memoryParts.push(Uint8Array.from(b));
            total += b.byteLength;
            return Promise.resolve();
          },
        };
      }

      await encodeZui(
        () => fileSource(f, setWrapProgress),
        {
          fileName: f.name,
          mimeType: f.type || "application/octet-stream",
          compression,
        },
        sink
      );
      if (total <= 0) throw new Error("empty container produced");

      const containerName = `${f.name}.zui`;
      const result: WrapResult = {
        originalName: f.name,
        originalSize: f.size,
        containerName,
        containerSize: total,
        ...(opfsOut ? { opfs: opfsOut } : {}),
      };
      if (!opfsOut) {
        result.url = URL.createObjectURL(new Blob(memoryParts as unknown as BlobPart[], { type: "application/octet-stream" }));
      }
      setWrapResult(result);
      setWrapState("done");

      if (opfsOut) {
        // Instant download: streams from disk, no memory spike. Failure must
        // never flip the done state to error — the button stays as a fallback.
        void downloadOpfsFile(opfsOut, containerName).catch(() => undefined);
      }
    } catch (err) {
      setWrapState("error");
      setWrapError((err as Error).message);
    } finally {
      busy.current = false;
    }
  }, []);

  const redownload = useCallback(() => {
    const r = wrapResult;
    if (!r) return;
    if (r.opfs) void downloadOpfsFile(r.opfs, r.containerName);
    else if (r.url) triggerDownload(r.containerName, r.url);
  }, [wrapResult]);

  const convert = useCallback(async (f: File | null) => {
    if (!f || busy.current) return;
    busy.current = true;
    setConvFile(f);
    setConvState("busy");
    setConvProgress(0);
    setConvResult(null);
    setConvError(undefined);
    try {
      const check = await verifyZui(fileSource(f, setConvProgress));
      if (!check.valid) {
        setConvState("error");
        setConvError(`Not a valid ZUI container: ${check.errors.join("; ")}`);
        return;
      }
      const decoder = await ZuiDecoder.open(fileSource(f));
      const parts: Uint8Array[] = [];
      let size = 0;
      for await (const raw of decoder.reconstruct()) {
        const copy = Uint8Array.from(raw);
        parts.push(copy);
        size += copy.byteLength;
      }
      setConvResult({ fileName: decoder.header.fileName || f.name.replace(/\.zui$/, ""), size, parts });
      setConvState("done");
    } catch (err) {
      setConvState("error");
      setConvError((err as Error).message);
    } finally {
      busy.current = false;
    }
  }, []);

  const wrapPct = Math.round(wrapProgress * 100);
  const wrapBytes = Math.round((wrapFileRef.current?.size ?? 0) * wrapProgress);

  return (
    <section className="send">
      <h1>Make it a ZUI file</h1>
      <p className="description">
        Drop any file and get a compressed <strong>.zui</strong> container to download. Drop a{" "}
        <strong>.zui</strong> back in the box and get the exact original file. Runs in your browser and
        streams to disk — a 2&nbsp;GB file never lives fully in memory.
      </p>

      <div className="panel">
        <h2 className="send-h2">1 · Turn a file into .zui</h2>
        <div
          className={`dropzone${dragOver === "wrap" ? " drag" : ""}${wrapResult ? " has" : ""}`}
          onClick={() => document.getElementById("wrap-input")?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragOver("wrap"); }}
          onDragLeave={() => setDragOver(null)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(null);
            const f = e.dataTransfer.files?.[0];
            if (f) void wrap(f);
          }}
        >
          <input
            id="wrap-input"
            type="file"
            style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0] ?? null; e.target.value = ""; if (f) void wrap(f); }}
          />
          {wrapResult && wrapState === "done" ? (
            <>
              <div className="dropzone-title">{wrapResult.originalName}</div>
              <div className="dropzone-subtitle">
                {formatBytes(wrapResult.originalSize)} → {formatBytes(wrapResult.containerSize)} (compressed .zui)
              </div>
            </>
          ) : (
            <>
              <svg className="upload-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
              <div className="dropzone-title">Drop a file to compress into .zui</div>
              <div className="dropzone-subtitle">Drag &amp; drop or click to browse</div>
            </>
          )}
        </div>

        {wrapState === "busy" && (
          <div className="progress-wrap">
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${wrapPct}%` }} />
            </div>
            <span className="progress-label">
              {wrapMode === "none"
                ? `packaging ${formatBytes(wrapBytes)} / ${formatBytes(wrapFileRef.current?.size ?? 0)} — deflate skipped… ${wrapPct}%`
                : `compressing ${formatBytes(wrapBytes)} / ${formatBytes(wrapFileRef.current?.size ?? 0)}… ${wrapPct}%`}
            </span>
          </div>
        )}

        {wrapState === "error" && <p className="resume-msg">Error: {wrapError}</p>}

        {wrapState === "done" && wrapResult && (
          <div className="wrap-result">
            <p className="wrap-line">
              Compressed {formatBytes(wrapResult.originalSize)} → {formatBytes(wrapResult.containerSize)}.
              {wrapResult.opfs && " The download started — check your downloads folder."}
            </p>
            <button className="btn-download" onClick={redownload}>
              Download {wrapResult.containerName}
            </button>
          </div>
        )}
      </div>

      <div className="panel">
        <h2 className="send-h2">2 · restore the original from .zui</h2>
        <div
          className={`dropzone${dragOver === "conv" ? " drag" : ""}${convResult ? " has" : ""}`}
          onClick={() => document.getElementById("conv-input")?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragOver("conv"); }}
          onDragLeave={() => setDragOver(null)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(null);
            const f = e.dataTransfer.files?.[0];
            if (f) void convert(f);
          }}
        >
          <input
            id="conv-input"
            type="file"
            style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0] ?? null; e.target.value = ""; if (f) void convert(f); }}
          />
          {convState === "busy" ? (
            <>
              <div className="dropzone-title">{convFile?.name}</div>
              <div className="dropzone-subtitle">verifying &amp; restoring… {Math.round(convProgress * 100)}%</div>
            </>
          ) : convResult ? (
            <>
              <div className="dropzone-title">{convResult.fileName}</div>
              <div className="dropzone-subtitle">{formatBytes(convResult.size)} — original restored, SHA-256 verified</div>
            </>
          ) : (
            <>
              <svg className="upload-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M12 4v12m-4-4l4 4 4-4" />
              </svg>
              <div className="dropzone-title">Drop a .zui container here</div>
              <div className="dropzone-subtitle">Drag &amp; drop or click to browse</div>
            </>
          )}
        </div>

        {convState === "busy" && (
          <div className="progress-wrap">
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${Math.round(convProgress * 100)}%` }} />
            </div>
            <span className="progress-label">verifying &amp; restoring… {Math.round(convProgress * 100)}%</span>
          </div>
        )}

        {convState === "error" && <p className="resume-msg">Error: {convError}</p>}

        {convState === "done" && convResult && (
          <div className="wrap-result">
            <p className="wrap-line">Original file restored with its type — download it:</p>
            <button
              className="btn-download"
              onClick={() => void downloadBlob(convResult.fileName, convResult.parts as unknown as BlobPart[], "application/octet-stream")}
            >
              Download {convResult.fileName}
            </button>
          </div>
        )}
      </div>

      <div className="panel">
        <h2 className="send-h2">3 · send over the internet (optional)</h2>
        <ShareCard />
      </div>
    </section>
  );
}