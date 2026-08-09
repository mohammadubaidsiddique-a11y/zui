import { useCallback, useRef, useState, type JSX } from "react";
import { encodeZui, verifyZui, ZuiDecoder, probeCompressible, type ByteSink, type ByteSource } from "@codec/index";
import { ShareCard } from "./ShareCard";

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

function download(name: string, blobParts: BlobPart[], type: string): void {
  const url = URL.createObjectURL(new Blob(blobParts, { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

interface WrapResult {
  originalName: string;
  originalSize: number;
  containerName: string;
  containerSize: number;
  containerParts: Uint8Array[];
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

  const wrap = useCallback(async (f: File | null) => {
    if (!f || busy.current) return;
    busy.current = true;
    setWrapState("busy");
    setWrapProgress(0);
    setWrapResult(null);
    setWrapError(undefined);
    const parts: Uint8Array[] = [];
    let total = 0;
    const sink: ByteSink = {
      write: (b) => {
        const copy = Uint8Array.from(b);
        parts.push(copy);
        total += copy.byteLength;
      },
    };
    try {
      // Instant path: already-compressed media (video/audio/archives) is
      // entropy-probed and packaged WITHOUT deflate — no CPU burn on 2GB.
      const probeSample = new Uint8Array(await f.slice(0, Math.min(f.size, 512 * 1024)).arrayBuffer());
      const compression =
        probeCompressible(probeSample) || f.size <= 8 * 1024 * 1024 ? "deflate-raw" : ("none" as const);
      setWrapMode(compression);
      await encodeZui(
        () => fileSource(f, setWrapProgress),
        {
          fileName: f.name,
          mimeType: f.type || "application/octet-stream",
          compression,
        },
        sink
      );
      if (total <= 0 || parts.length === 0) throw new Error("empty container produced");
      setWrapResult({
        originalName: f.name,
        originalSize: f.size,
        containerName: `${f.name}.zui`,
        containerSize: total,
        containerParts: parts,
      });
      setWrapState("done");
    } catch (err) {
      setWrapState("error");
      setWrapError((err as Error).message);
    } finally {
      busy.current = false;
    }
  }, []);

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

  return (
    <section className="send">
      <h1>Make it a ZUI file</h1>
      <p className="description">
        Drop any file and get a compressed <strong>.zui</strong> container to download. Drop a{" "}
        <strong>.zui</strong> back in the box and get the exact original file. Runs in your browser.
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
          {wrapState === "busy" && (
            <div className="hash-progress">
              {wrapMode === "none"
                ? `packaging (already-compressed — deflate skipped)… ${Math.round(wrapProgress * 100)}%`
                : `compressing… ${Math.round(wrapProgress * 100)}%`}
            </div>
          )}
        </div>

        {wrapState === "error" && <p className="resume-msg">Error: {wrapError}</p>}

        {wrapState === "done" && wrapResult && (
          <div className="wrap-result">
            <p className="wrap-line">
              Compressed {formatBytes(wrapResult.originalSize)} → {formatBytes(wrapResult.containerSize)}.
              Download the container:
            </p>
            <button
              className="btn-download"
              onClick={() => download(wrapResult.containerName, wrapResult.containerParts as BlobPart[], "application/octet-stream")}
            >
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

        {convState === "error" && <p className="resume-msg">Error: {convError}</p>}

        {convState === "done" && convResult && (
          <div className="wrap-result">
            <p className="wrap-line">Original file restored with its type — download it:</p>
            <button
              className="btn-download"
              onClick={() => download(convResult.fileName, convResult.parts as BlobPart[], "application/octet-stream")}
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