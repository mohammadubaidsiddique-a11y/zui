import { useCallback, useRef, useState, type JSX } from "react";
import { encodeZui, verifyZui, ZuiDecoder, probeCompressible, type ByteSink, type ByteSource } from "@codec/index";
import { ShareCard } from "./ShareCard";
import { downloadBlob, transcodeStaged, triggerDownload, uploadFileChunked, type DownloadReport } from "./download";

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
  parts: Uint8Array[];
}

interface UnwrapResult {
  fileName: string;
  size: number;
  parts: Uint8Array[];
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
  const [transMode, setTransMode] = useState<"compress" | "enhance" | "frame" | null>(null);
  const [transError, setTransError] = useState<string | undefined>();

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
    try {
      // Instant path: already-compressed media (video/audio/archives) is
      // entropy-probed and packaged WITHOUT deflate — no CPU burn on 2GB.
      const probeSample = new Uint8Array(await f.slice(0, Math.min(f.size, 512 * 1024)).arrayBuffer());
      const compression =
        probeCompressible(probeSample) || f.size <= 8 * 1024 * 1024 ? "deflate-raw" : ("none" as const);
      setWrapMode(compression);

      // The container is built in memory — pure JS, no OPFS, so a wrap can
      // never stall at 100% (OPFS writables deadlock Chromium at large
      // sizes). Download always streams the parts through the server in
      // 16 MiB slices, so the button can never no-op either.
      const memoryParts: Uint8Array[] = [];
      let total = 0;
      const sink: ByteSink = {
        write: (b) => {
          memoryParts.push(Uint8Array.from(b));
          total += b.byteLength;
          return Promise.resolve();
        },
      };

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

      // Prove the container is valid BEFORE offering the Download button —
      // a broken or zero-byte .zui must never be downloadable.
      const partsSource = (): ByteSource => ({
        async *[Symbol.asyncIterator]() {
          for (const part of memoryParts) yield part;
        },
      });
      const check = await verifyZui(partsSource());
      if (!check.valid) {
        throw new Error(`container failed self-check: ${check.errors.join("; ")}`);
      }

      const containerName = `${f.name}.zui`;
      const result: WrapResult = {
        originalName: f.name,
        originalSize: f.size,
        containerName,
        containerSize: total,
        parts: memoryParts,
      };
      setWrapResult(result);
      setWrapState("done");
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
    if (!r.parts) return;
    // Reliable ladder: native picker → server-mediated → anchor. Large
    // payloads go through the server in 16 MiB slices, so this never
    // no-ops and never produces a zero-byte file.
    void downloadBlob(r.containerName, r.parts as unknown as BlobPart[], "application/octet-stream").then(reportDownload);
  }, [wrapResult]);

  const transcodeVideo = useCallback((mode: "compress" | "enhance" | "frame") => {
    const r = convResult;
    if (!r || transMode) return;
    setTransMode(mode);
    setTransError(undefined);
    void (async () => {
      try {
        const file = new File(r.parts as unknown as BlobPart[], r.fileName, { type: "video/mp4" });
        const { id } = await uploadFileChunked(r.fileName, file);
        const { url, bytes } = await transcodeStaged(id, mode);
        const stem = r.fileName.replace(VIDEO_EXT, "");
        const outName =
          mode === "frame"
            ? `${stem}-frame.jpg`
            : `${stem}${mode === "enhance" ? "-enhanced" : "-compressed"}.mp4`;
        triggerDownload(outName, url);
        reportDownload({
          ok: true,
          via: "server",
          bytes,
          detail: `${mode === "frame" ? "frame exported" : `${mode} complete`} — download started via server`,
        });
      } catch (err) {
        setTransError((err as Error).message);
      } finally {
        setTransMode(null);
      }
    })();
  }, [convResult, transMode]);

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
      const parts: Uint8Array[] = [];
      let size = 0;
      for await (const raw of decoder.reconstruct()) {
        const copy = Uint8Array.from(raw);
        parts.push(copy);
        size += copy.byteLength;
      }
      setConvResult({ fileName: decoder.header.fileName || f.name.replace(/\.zui$/, ""), size, parts });
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
                ? `packaging ${formatBytes(wrapBytes)} / ${formatBytes(wrapFileRef.current?.size ?? 0)} — already-compressed data can't shrink, stored raw… ${wrapPct}%`
                : `compressing ${formatBytes(wrapBytes)} / ${formatBytes(wrapFileRef.current?.size ?? 0)}… ${wrapPct}%`}
            </span>
          </div>
        )}

        {wrapState === "error" && <p className="resume-msg">Error: {wrapError}</p>}

        {wrapState === "done" && wrapResult && (
          <div className="wrap-result">
            <p className="wrap-line">
              Compressed {formatBytes(wrapResult.originalSize)} → {formatBytes(wrapResult.containerSize)}.
              The .zui is ready — download it:
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
              onClick={() =>
                void downloadBlob(convResult.fileName, convResult.parts as unknown as BlobPart[], "application/octet-stream").then(
                  reportDownload
                )
              }
            >
              Download {convResult.fileName}
            </button>
            {VIDEO_EXT.test(convResult.fileName) && (
              <>
                <p className="wrap-line">Prefer a polished version? Restore with enhancement applied:</p>
                <div className="trans-actions">
                  <button
                    className="btn-download"
                    disabled={transMode !== null}
                    onClick={() => transcodeVideo("enhance")}
                  >
                    Restore + Enhance (1080p, denoise)
                  </button>
                  <button
                    className="btn-download"
                    disabled={transMode !== null}
                    onClick={() => transcodeVideo("compress")}
                  >
                    Restore + Compress (smaller H.264)
                  </button>
                  <button
                    className="btn-download"
                    disabled={transMode !== null}
                    onClick={() => transcodeVideo("frame")}
                  >
                    Export frame as JPEG
                  </button>
                </div>
              </>
            )}
            {transMode && (
              <p className="resume-msg">
                {transMode === "frame"
                  ? "Exporting a frame on the server (ffmpeg)…"
                  : "Enhancing on the server (ffmpeg)… this can take a while for big videos."}
              </p>
            )}
            {transError && <p className="resume-msg">✗ transcode failed: {transError}</p>}
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