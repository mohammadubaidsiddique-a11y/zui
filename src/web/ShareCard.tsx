import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { compressionSupported, compressChunk, createSha256 } from "@codec/index";

const fmt = (n: number): string => {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
};

type Phase = "idle" | "hashing" | "uploading" | "done" | "error";

interface SessionInfo {
  id: string;
  chunkSize: number;
  chunkCount: number;
  senderToken: string;
  receiverToken: string;
  sharePath: string;
}

export function ShareCard(): JSX.Element {
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [uploaded, setUploaded] = useState(0);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [link, setLink] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [compress, setCompress] = useState(true);
  const compressionSupportedHere = compressionSupported("deflate-raw");
  const abortRef = useRef(false);
  const wireRef = useRef<"none" | "deflate-raw">("none");

  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (phase !== "hashing" && phase !== "uploading") return;
    const t0 = Date.now();
    const id = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(id);
  }, [phase]);

  const streamHash = useCallback(async (f: File, onProgress: (frac: number) => void): Promise<string> => {
    const hasher = createSha256();
    let read = 0;
    const reader = f.stream().getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.byteLength) {
          read += value.byteLength;
          hasher.update(value);
          onProgress(read / f.size);
        }
      }
    } finally {
      reader.releaseLock();
    }
    return hasher.digestHex();
  }, []);

  const uploadAll = useCallback(async (f: File, s: SessionInfo, wire: "none" | "deflate-raw", onEach: (done: number, total: number) => void) => {
    const getStored = async (): Promise<Set<number>> => {
      const r = await fetch(`/api/v1/sessions/${s.id}?role=sender`, {
        headers: { Authorization: `Bearer ${s.senderToken}` },
      });
      if (!r.ok) return new Set();
      const j = (await r.json()) as { session: { chunks?: { index: number }[] } };
      return new Set((j.session.chunks ?? []).map((c) => c.index));
    };

    let stored = await getStored();
    for (let i = 0; i < s.chunkCount; i += 1) {
      if (abortRef.current) throw new Error("interrupted");
      if (stored.has(i)) {
        onEach(i + 1, s.chunkCount);
        continue;
      }
      const slice = await f.slice(i * s.chunkSize, Math.min((i + 1) * s.chunkSize, f.size)).arrayBuffer();
      const bytes = new Uint8Array(slice);
      // Stage 1 — compress: the file's bytes are deflated here, so the
      // (smaller) compressed form is what travels over the wire.
      const wireBytes = wire === "deflate-raw" ? await compressChunk(wire, bytes) : bytes;
      const sha = (await createSha256().update(wireBytes).digestHex());
      const r = await fetch(`/api/v1/sessions/${s.id}/chunks/${i}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${s.senderToken}`,
          "Content-Type": "application/octet-stream",
          "X-Chunk-Sha256": sha,
        },
        body: wireBytes as unknown as Uint8Array<ArrayBuffer>,
      });
      if (r.status === 401 || r.status === 410 || r.status === 409) {
        throw new Error(`upload rejected (${r.status}) — session may have expired`);
      }
      if (!r.ok && r.status !== 200) throw new Error(`chunk ${i} upload failed (${r.status})`);
      // A 200 (resume) or 201 (fresh) both mean the chunk is on the server —
      // track it locally instead of polling the session after every chunk.
      stored.add(i);
      onEach(i + 1, s.chunkCount);
    }
  }, []);

  const start = useCallback(async (f: File | null) => {
    if (!f) return;
    abortRef.current = false;
    setFile(f);
    setPhase("hashing");
    setProgress(0);
    setError(null);
    setSession(null);
    setLink("");
    try {
      const sha256 = await streamHash(f, (p) => setProgress(p));
      const wire: "none" | "deflate-raw" = compress && compressionSupportedHere ? "deflate-raw" : "none";
      wireRef.current = wire;
      const r = await fetch("/api/v1/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: f.name,
          size: f.size,
          sha256,
          mimeType: f.type || "application/octet-stream",
          compression: wire,
        }),
      });
      if (!r.ok) throw new Error("could not create transfer");
      const j = (await r.json()) as { session: SessionInfo };
      const s = j.session;
      setSession(s);
      setPhase("uploading");
      setUploaded(0);
      await uploadAll(f, s, wire, (done, total) => {
        setUploaded(done);
        setProgress(done / total);
      });
      if (abortRef.current) return;
      const fin = await fetch(`/api/v1/sessions/${s.id}/finalize`, {
        method: "POST",
        headers: { Authorization: `Bearer ${s.senderToken}` },
      });
      if (!fin.ok) throw new Error(`finalize failed (${fin.status})`);
      setLink(`${window.location.origin}${s.sharePath}`);
      setPhase("done");
    } catch (e) {
      setPhase("error");
      setError((e as Error).message === "interrupted" ? "Upload paused — resume any time." : (e as Error).message);
    }
  }, [streamHash, uploadAll]);

  const resume = useCallback(() => {
    if (!file || !session) return;
    setPhase("uploading");
    setError(null);
    abortRef.current = false;
    void (async () => {
      try {
        await uploadAll(file, session, wireRef.current, (done, total) => {
          setUploaded(done);
          setProgress(done / total);
        });
        const fin = await fetch(`/api/v1/sessions/${session.id}/finalize`, {
          method: "POST",
          headers: { Authorization: `Bearer ${session.senderToken}` },
        });
        if (!fin.ok) throw new Error(`finalize failed (${fin.status})`);
        setLink(`${window.location.origin}${session.sharePath}`);
        setPhase("done");
      } catch (e) {
        setPhase("error");
        setError((e as Error).message === "interrupted" ? "Upload paused — resume any time." : (e as Error).message);
      }
    })();
  }, [file, session, uploadAll]);

  const copyLink = useCallback(() => {
    void navigator.clipboard.writeText(link).then(() => setCopied(true));
    setTimeout(() => setCopied(false), 2000);
  }, [link]);

  return (
    <div className="share-card">
      <div
        className={`dropzone${file ? " has" : ""}`}
        onClick={() => document.getElementById("share-file-input")?.click()}
        onDragOver={(e) => { e.preventDefault(); e.currentTarget.style.borderColor = "#333333"; }}
        onDragLeave={(e) => { e.currentTarget.style.borderColor = "#b5b5b5"; }}
        onDrop={(e) => {
          e.preventDefault();
          e.currentTarget.style.borderColor = "#b5b5b5";
          const f = e.dataTransfer.files?.[0];
          if (f) void start(f);
        }}
      >
        <input
          id="share-file-input"
          type="file"
          style={{ display: "none" }}
          onChange={(e) => { const f = e.target.files?.[0] ?? null; e.target.value = ""; if (f) void start(f); }}
        />
        {file && phase !== "idle" ? (
          <>
            <div className="dropzone-title">{file.name}</div>
            <div className="dropzone-subtitle">{fmt(file.size)}</div>
          </>
        ) : (
          <>
            <svg className="upload-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
            <div className="dropzone-title">Choose the file to share</div>
            <div className="dropzone-subtitle">Big or small — uploaded in verified chunks, resumably</div>
          </>
        )}
      </div>

      {phase === "idle" && (
        <label className="compress-opt">
          <input
            type="checkbox"
            checked={compress}
            disabled={!compressionSupportedHere}
            onChange={(e) => setCompress(e.target.checked)}
          />
          Compress before uploading — bytes travel smaller, the receiver restores the original
        </label>
      )}

      {(phase === "hashing" || phase === "uploading") && (
        <div className="pipeline">
          <span className="pipe-step done">1 · compress</span>
          <span className={`pipe-step${phase === "hashing" ? " pending" : " active"}`}>2 · travel</span>
          <span className="pipe-step pending">3 · restore</span>
          <span className="pipe-time">{elapsed}s elapsed</span>
        </div>
      )}

      {phase === "hashing" && (
        <div className="progress-wrap">
          <div className="progress-bar"><div className="progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} /></div>
          <span className="progress-label">analyzing the file (pass 1/2 — checksum)… {Math.round(progress * 100)}%</span>
        </div>
      )}

      {phase === "uploading" && (
        <div className="progress-wrap">
          <div className="progress-bar"><div className="progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} /></div>
          <span className="progress-label">
            {wireRef.current === "deflate-raw"
              ? `compressing chunk ${uploaded}/${session?.chunkCount}, then uploading — verified at both ends`
              : `uploading chunk ${uploaded}/${session?.chunkCount} — every chunk is SHA-256 verified on the server`}
          </span>
          <div className="row">
            <button className="btn-outline" onClick={() => { abortRef.current = true; }}>pause</button>
          </div>
        </div>
      )}

      {phase === "error" && error && (
        <p className="resume-msg">
          {error}
          {file && session && (
            <button className="btn" onClick={resume}>resume</button>
          )}
        </p>
      )}

      {phase === "done" && link && (
        <div className="share-result">
          <p className="wrap-line">Upload complete. Send this link — the receiver gets the exact original file:</p>
          <div className="link-copy">
            <span className="mono link-text">{link}</span>
            <button className="btn" onClick={copyLink}>{copied ? "copied ✓" : "copy"}</button>
          </div>
        </div>
      )}
    </div>
  );
}