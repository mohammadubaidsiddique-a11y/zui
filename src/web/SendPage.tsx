import { useCallback, useRef, useState, type JSX } from "react";
import { encodeZui, verifyZui, ZuiDecoder, probeCompressible, type ByteSink, type ByteSource } from "@codec/index";
import { ShareCard } from "./ShareCard";
import {
  downloadBlob,
  downloadFile,
  transcodeStaged,
  uploadFileChunked,
  type DownloadReport,
} from "./download";
import { cleanupStaleWrapFiles, closeOpfsOutFile, createOpfsOutFile, opfsAvailable } from "./opfs";

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

interface WrapResult {
  originalName: string;
  originalSize: number;
  containerName: string;
  containerSize: number;
  parts?: Uint8Array[];
  file?: File;
}

interface UnwrapResult {
  fileName: string;
  size: number;
  parts?: Uint8Array[];
  file?: File;
}

type JobState = "idle" | "busy" | "done" | "error";

const VIDEO_EXT = /\.(mp4|mov|m4v|avi|mkv|webm|ts|m2ts|3gp|wmv)$/i;

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
  const [dlReport, setDlReport] = useState<DownloadReport | null>(null);
  const [wrapCompress, setWrapCompress] = useState(true);
  const [wrapStep, setWrapStep] = useState("");
  const [compressedOrigSize, setCompressedOrigSize] = useState<number | null>(null);

  const [dragOver, setDragOver] = useState<"wrap" | "conv" | null>(null);
  const busy = useRef(false);
  const wrapFileRef = useRef<File | null>(null);

  const reportDownload = (r: DownloadReport): void => {
    setDlReport(r);
    if (r.ok) {
      window.setTimeout(() => setDlReport(null), 15_000);
    }
  };

  const wrap = useCallback(async (f: File | null) => {
    if (!f || busy.current) return;
    busy.current = true;
    wrapFileRef.current = f;
    setWrapState("busy");
    setWrapProgress(0);
    setWrapResult(null);
    setWrapError(undefined);
    setWrapStep("");
    setCompressedOrigSize(null);
    try {
      // Optional real compression at wrap time: videos are re-encoded to a
      // smaller H.264 on the server BEFORE packaging, so the .zui itself is
      // genuinely smaller and restore returns that compressed video. Lossless
      // wrapping remains the fallback when the server can't re-encode.
      let wrapsFile = f;
      if (wrapCompress && VIDEO_EXT.test(f.name)) {
        try {
          setWrapStep("re-encoding video to smaller H.264 on the server…");
          const { id } = await uploadFileChunked(f.name, f);
          const { url, bytes: reBytes } = await transcodeStaged(id, "compress");
          const res = await fetch(url);
          if (!res.ok) throw new Error(`server re-encode download failed (HTTP ${res.status})`);
          const blob = await res.blob();
          if (blob.size <= 0 || blob.size >= f.size) {
            throw new Error(`re-encode was not smaller (${blob.size} bytes)`);
          }
          void reBytes;
          wrapsFile = new File([blob], f.name, { type: f.type || "video/mp4" });
          setCompressedOrigSize(wrapsFile.size);
        } catch (e) {
          setWrapError(`Video re-encode failed (${(e as Error).message}) — wrapping the original losslessly instead.`);
          wrapsFile = f;
        }
      }
      // Instant path: already-compressed media (video/audio/archives) is
      // entropy-probed and packaged WITHOUT deflate — no CPU burn on 2GB,
      // and the result honestly says "stored as-is" instead of pretending.
      const probeSample = new Uint8Array(await wrapsFile.slice(0, Math.min(wrapsFile.size, 512 * 1024)).arrayBuffer());
      const compression = probeCompressible(probeSample) ? ("deflate-raw" as const) : ("none" as const);
      setWrapMode(compression);

      // Big files are built straight to disk (OPFS) and the download streams
      // from disk in slices — the container never lives in RAM, so a 2.6 GB
      // wrap can't freeze the tab. Small files stay in memory for speed.
      const memoryParts: Uint8Array[] = [];
      let total = 0;
      const diskOut =
        wrapsFile.size > 64 * 1024 * 1024 && (await opfsAvailable()) ? await createOpfsOutFile("zui-wrap") : null;
      if (diskOut) await cleanupStaleWrapFiles(diskOut.name);
      const sink: ByteSink = diskOut
        ? {
            write: (b) => {
              total += b.byteLength;
              return diskOut.writable.write(b as unknown as Uint8Array<ArrayBuffer>);
            },
          }
        : {
            write: (b) => {
              memoryParts.push(Uint8Array.from(b));
              total += b.byteLength;
              return Promise.resolve();
            },
          };

      await encodeZui(
        () => fileSource(wrapsFile, setWrapProgress),
        {
          fileName: f.name,
          mimeType: wrapsFile.type || "application/octet-stream",
          compression,
        },
        sink
      );
      if (diskOut) await closeOpfsOutFile(diskOut);
      if (total <= 0) throw new Error("empty container produced");

      // Prove the container is valid BEFORE offering the Download button —
      // a broken or zero-byte .zui must never be downloadable.
      const diskFile = diskOut ? await diskOut.handle.getFile() : null;
      const partsSource = (): ByteSource =>
        diskFile
          ? fileSource(diskFile)
          : {
              async *[Symbol.asyncIterator]() {
                for (const part of memoryParts) yield part;
              },
            };
      const check = await verifyZui(partsSource());
      if (!check.valid) {
        if (diskOut) await cleanupStaleWrapFiles(null);
        throw new Error(`container failed self-check: ${check.errors.join("; ")}`);
      }

      const containerName = `${f.name}.zui`;
      const result: WrapResult = {
        originalName: f.name,
        originalSize: f.size,
        containerName,
        containerSize: total,
        parts: diskFile ? undefined : memoryParts,
        file: diskFile ?? undefined,
      };
      setWrapResult(result);
      setWrapState("done");
    } catch (err) {
      setWrapState("error");
      setWrapError((err as Error).message);
    } finally {
      busy.current = false;
    }
  }, [wrapCompress]);

  const redownload = useCallback(() => {
    const r = wrapResult;
    if (!r) return;
    // Big containers are disk-backed: stream from disk, never through RAM.
    // Small ones use the in-memory parts. Both follow the same reliable
    // ladder: native picker → server (16 MiB slices) → anchor.
    if (r.file) {
      void downloadFile(r.containerName, r.file).then(reportDownload);
      return;
    }
    if (!r.parts) return;
    void downloadBlob(r.containerName, r.parts as unknown as BlobPart[], "application/octet-stream").then(reportDownload);
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
      if (f.size === 0) {
        setConvState("error");
        setConvError(
          `This .zui file is empty (0 bytes) — the download that produced it failed. Delete it, download the .zui again, and try restoring the new file.`
        );
        return;
      }
      const check = await verifyZui(fileSource(f, setConvProgress));
      if (!check.valid) {
        setConvState("error");
        setConvError(
          check.errors.some((e) => e.startsWith("unexpected end of stream") || /needed \d+ more bytes/.test(e))
            ? `This .zui is truncated (${formatBytes(f.size)} on disk) — it did not download completely. Delete it, download the .zui again, and try restoring the new file.`
            : `Not a valid ZUI container: ${check.errors.join("; ")}`
        );
        return;
      }
      const decoder = await ZuiDecoder.open(fileSource(f));
      // Big restores stream to disk instead of buffering in RAM (same rule
      // as wrapping) — a 3 GB video must not live in the tab's memory.
      const diskOut =
        f.size > 64 * 1024 * 1024 && (await opfsAvailable()) ? await createOpfsOutFile("zui-restore") : null;
      if (diskOut) await cleanupStaleWrapFiles(diskOut.name);
      const parts: Uint8Array[] = [];
      let size = 0;
      for await (const raw of decoder.reconstruct()) {
        size += raw.byteLength;
        if (diskOut) {
          await diskOut.writable.write(raw as unknown as Uint8Array<ArrayBuffer>);
        } else {
          parts.push(Uint8Array.from(raw));
        }
      }
      if (diskOut) await closeOpfsOutFile(diskOut);
      const fileName = decoder.header.fileName || f.name.replace(/\.zui$/, "");
      setConvResult({
        fileName,
        size,
        parts: diskOut ? undefined : parts,
        file: diskOut ? await diskOut.handle.getFile() : undefined,
      });
      setConvState("done");
      if (size <= 0) {
        setDlReport({ ok: false, via: "none", error: "restored 0 bytes — the container holds no data" });
      }
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
                {compressedOrigSize
                  ? `original ${formatBytes(wrapResult.originalSize)} → re-encoded ${formatBytes(compressedOrigSize)} (H.264) → .zui ${formatBytes(wrapResult.containerSize)}`
                  : `${formatBytes(wrapResult.originalSize)} → ${formatBytes(wrapResult.containerSize)} ${wrapMode === "deflate-raw" && wrapResult.containerSize < wrapResult.originalSize ? "(deflate-compressed)" : "(stored as-is — this data is already compressed, so lossless packaging can't shrink it)"}`}
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

        <label className="compress-opt">
          <input
            type="checkbox"
            checked={wrapCompress}
            disabled={wrapState === "busy"}
            onChange={(e) => setWrapCompress(e.target.checked)}
          />
          Compress videos while packaging — the .zui holds a smaller re-encoded H.264 video
        </label>

        {wrapState === "busy" && (
          <div className="progress-wrap">
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${wrapPct}%` }} />
            </div>
            <span className="progress-label">
              {wrapStep
                ? `${wrapStep}`
                : wrapMode === "none"
                  ? `packaging ${formatBytes(wrapBytes)} / ${formatBytes(wrapFileRef.current?.size ?? 0)} — already-compressed data can't shrink, stored raw… ${wrapPct}%`
                  : `compressing ${formatBytes(wrapBytes)} / ${formatBytes(wrapFileRef.current?.size ?? 0)}… ${wrapPct}%`}
            </span>
          </div>
        )}

        {wrapState === "error" && <p className="resume-msg">Error: {wrapError}</p>}

        {wrapState === "done" && wrapResult && (
          <div className="wrap-result">
            <p className="wrap-line">
              {compressedOrigSize
                ? `Video re-encoded ${formatBytes(wrapResult.originalSize)} → ${formatBytes(compressedOrigSize)}, then packaged → ${formatBytes(wrapResult.containerSize)}. The .zui is ready — download it:`
                : `Packaged ${formatBytes(wrapResult.originalSize)} → ${formatBytes(wrapResult.containerSize)}. The .zui is ready — download it:`}
            </p>
            <button className="btn-download" onClick={redownload}>
              Download {wrapResult.containerName}
            </button>
            {dlReport && (
              <p className={`resume-msg${dlReport.ok ? " dl-ok" : ""}`}>
                {dlReport.ok
                  ? `✓ ${wrapResult.containerName} (${formatBytes(dlReport.bytes)}) — download started via ${dlReport.via}. If nothing appears, click Download again.`
                  : `✗ download failed: ${dlReport.error}`}
              </p>
            )}
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
            <p className="wrap-line">
              Restored: <strong>{formatBytes(convResult.size)}</strong> — the original is back, byte-exact and
              SHA-256 verified. Download it as-is:
            </p>
            <button
              className="btn-download"
              onClick={() => {
                const r = convResult;
                if (!r) return;
                const report = r.file
                  ? downloadFile(r.fileName, r.file)
                  : downloadBlob(r.fileName, (r.parts ?? []) as unknown as BlobPart[], "application/octet-stream");
                void report.then(reportDownload);
              }}
            >
              Download {convResult.fileName}
            </button>
            {dlReport && (
              <p className={`resume-msg${dlReport.ok ? " dl-ok" : ""}`}>
                {dlReport.ok
                  ? `✓ ${convResult.fileName} (${formatBytes(dlReport.bytes)}) — download started via ${dlReport.via}. If nothing appears, click Download again.`
                  : `✗ download failed: ${dlReport.error}`}
              </p>
            )}
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