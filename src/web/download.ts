/* global BufferSource, Navigator */

export type DownloadReport =
  | { ok: true; via: "picker" | "server" | "anchor"; bytes: number; detail: string }
  | { ok: false; via: "picker" | "server" | "anchor" | "none"; error: string };

export type ProgressFn = (written: number, total: number) => void;

const SAFE_NAME = (name: string): string => name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_") || "download";

// Single-POST uploads below this size; chunked uploads above (any browser, any size).
const SERVER_DIRECT_MAX = 128 * 1024 * 1024;
const SERVER_CHUNK_BYTES = 16 * 1024 * 1024;
// Files above this are never read back for verification — reading a 2 GB file
// back into RAM to "check" it is exactly what used to freeze the tab.
const VERIFY_READBACK_MAX = 16 * 1024 * 1024;

function fireAnchor(href: string, downloadAttr: boolean, name: string): void {
  const a = document.createElement("a");
  a.href = href;
  a.rel = "noopener";
  a.style.display = "none";
  if (downloadAttr) a.download = SAFE_NAME(name);
  document.body.appendChild(a);
  a.click();
  // Keep the anchor in the DOM until the download starts — Safari aborts the
  // transfer if the node is removed synchronously.
  window.setTimeout(() => a.remove(), 2000);
}

/** Blob URL + DOM-appended anchor: works in Firefox, small files everywhere. */
export function triggerDownload(name: string, url: string): void {
  fireAnchor(url, true, name);
}

const nameHeader = (name: string): Record<string, string> => ({ "X-Zui-FileName": encodeURIComponent(name) });

/**
 * Batches parts into ≤SERVER_CHUNK_BYTES blobs, preserving order. Blobs are
 * read in 16 MiB slices — never the whole part at once — so a multi-GB
 * container staged through the server route can't blow the tab's RAM.
 */
async function batchParts(parts: BlobPart[], onProgress?: ProgressFn): Promise<Blob[]> {
  const CHUNK = SERVER_CHUNK_BYTES;
  let total = 0;
  for (const part of parts) {
    total += typeof part === "string" ? part.length : part instanceof Blob ? part.size : part.byteLength;
  }
  const batches: Blob[] = [];
  let current: Uint8Array[] = [];
  let currentBytes = 0;
  let staged = 0;
  const flush = (): void => {
    if (current.length > 0) {
      batches.push(new Blob(current as unknown as BlobPart[], { type: "application/octet-stream" }));
      current = [];
      currentBytes = 0;
    }
  };
  const push = (buf: Uint8Array): void => {
    current.push(buf);
    currentBytes += buf.byteLength;
    if (currentBytes >= CHUNK) flush();
  };
  for (const part of parts) {
    if (typeof part === "string") {
      const buf = new TextEncoder().encode(part);
      for (let at = 0; at < buf.byteLength; at += CHUNK) {
        push(buf.subarray(at, Math.min(at + CHUNK, buf.byteLength)));
        staged += Math.min(CHUNK, buf.byteLength - at);
        onProgress?.(staged, total);
      }
    } else if (part instanceof Blob) {
      for (let at = 0; at < part.size; at += CHUNK) {
        const slice = part.slice(at, Math.min(at + CHUNK, part.size));
        push(new Uint8Array(await slice.arrayBuffer()));
        staged += slice.size;
        onProgress?.(staged, total);
      }
    } else {
      push(part as Uint8Array<ArrayBuffer>);
      staged += part.byteLength;
      onProgress?.(staged, total);
    }
  }
  flush();
  return batches;
}

/**
 * Same-origin server-mediated download: the bytes are uploaded to the API
 * (one POST for small payloads, ordered chunks for large ones) and served
 * back with Content-Disposition: attachment, which every browser downloads
 * natively — no Blob URL, no size ceiling.
 */
export async function downloadViaServer(
  name: string,
  blobParts: BlobPart[],
  onProgress?: ProgressFn
): Promise<DownloadReport> {
  try {
    const total = blobParts.reduce(
      (s, p) => s + (typeof p === "string" ? p.length : p instanceof Blob ? p.size : p.byteLength),
      0
    );
    if (total <= 0) return { ok: false, via: "server", error: "nothing to download (0 bytes)" };

    let url: string | undefined;
    if (total <= SERVER_DIRECT_MAX) {
      const body = new Blob(blobParts, { type: "application/octet-stream" });
      const res = await fetch("/api/v1/local-download", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", ...nameHeader(name) },
        body,
      });
      onProgress?.(total, total);
      if (!res.ok) return { ok: false, via: "server", error: `staging failed (HTTP ${res.status})` };
      const data = (await res.json()) as { url?: string; bytes?: number };
      url = data.url;
      if (typeof data.bytes === "number" && data.bytes !== total) {
        return { ok: false, via: "server", error: `staging stored ${data.bytes} of ${total} bytes — try the download again` };
      }
    } else {
      const createRes = await fetch("/api/v1/local-download/chunked", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", ...nameHeader(name) },
      });
      if (!createRes.ok) return { ok: false, via: "server", error: `staging failed (HTTP ${createRes.status})` };
      const { id } = (await createRes.json()) as { id: string };
      let uploaded = 0;
      for (const batch of await batchParts(blobParts, onProgress)) {
        const res = await fetch(`/api/v1/local-download/chunked/${id}/chunk`, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: batch,
        });
        if (!res.ok) return { ok: false, via: "server", error: `chunk upload failed (HTTP ${res.status})` };
        uploaded += batch.size;
        onProgress?.(uploaded, total);
      }
      const finRes = await fetch(`/api/v1/local-download/chunked/${id}/finalize`, { method: "POST" });
      if (!finRes.ok) return { ok: false, via: "server", error: `finalize failed (HTTP ${finRes.status})` };
      const data = (await finRes.json()) as { url?: string; bytes?: number };
      url = data.url;
      if (typeof data.bytes === "number" && data.bytes !== total) {
        return { ok: false, via: "server", error: `staging stored ${data.bytes} of ${total} bytes — try the download again` };
      }
    }
    if (!url) return { ok: false, via: "server", error: "staging returned no url" };
    fireAnchor(url, false, name);
    onProgress?.(total, total);
    return { ok: true, via: "server", bytes: total, detail: `${total} bytes` };
  } catch (err) {
    return { ok: false, via: "server", error: (err as Error)?.message ?? String(err) };
  }
}

type SaveHandle = {
  createWritable(): Promise<FileSystemWritableFileStream>;
  getFile(): Promise<File>;
};

const STAGE_ROOT = "/api/v1/local-download";

/** Uploads a File to the staging store in 16 MiB disk slices (no RAM spike). */
export async function uploadFileChunked(
  name: string,
  file: File,
  onProgress?: ProgressFn
): Promise<{ url: string; id: string }> {
  const createRes = await fetch(`${STAGE_ROOT}/chunked`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", ...nameHeader(name) },
  });
  if (!createRes.ok) throw new Error(`staging failed (HTTP ${createRes.status})`);
  const { id } = (await createRes.json()) as { id: string };
  const CHUNK = SERVER_CHUNK_BYTES;
  for (let offset = 0; offset < file.size; offset += CHUNK) {
    const slice = file.slice(offset, Math.min(offset + CHUNK, file.size));
    const res = await fetch(`${STAGE_ROOT}/chunked/${id}/chunk`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: slice,
    });
    if (!res.ok) throw new Error(`chunk upload failed (HTTP ${res.status})`);
    onProgress?.(Math.min(offset + slice.size, file.size), file.size);
  }
  const finRes = await fetch(`${STAGE_ROOT}/chunked/${id}/finalize`, { method: "POST" });
  if (!finRes.ok) throw new Error(`finalize failed (HTTP ${finRes.status})`);
  const data = (await finRes.json()) as { url?: string; id?: string };
  if (!data.url) throw new Error("staging returned no url");
  return { url: data.url, id: data.id ?? id };
}

/** Asks the server to transcode a staged video with ffmpeg (compress/enhance/frame). */
export async function transcodeStaged(id: string, mode: "compress" | "enhance" | "frame"): Promise<{ url: string; bytes: number }> {
  const res = await fetch(`${STAGE_ROOT}/chunked/${id}/transcode?mode=${mode}`, { method: "POST" });
  if (!res.ok) throw new Error(`transcode failed (HTTP ${res.status})`);
  const data = (await res.json()) as { url?: string; bytes?: number };
  if (!data.url) throw new Error("transcode returned no url");
  return { url: data.url, bytes: data.bytes ?? 0 };
}

/** Writes blobParts to a native Save As stream in bounded slices. */
async function pickerWrite(handle: SaveHandle, name: string, blobParts: BlobPart[], onProgress?: ProgressFn): Promise<void> {
  const total = blobParts.reduce(
    (s, p) => s + (typeof p === "string" ? p.length : p instanceof Blob ? p.size : p.byteLength),
    0
  );
  const writable = await handle.createWritable();
  const SLICE = 4 * 1024 * 1024;
  let written = 0;
  for (const part of blobParts) {
    if (typeof part === "string") {
      await writable.write(part);
      written += part.length;
      onProgress?.(written, total);
    } else if (part instanceof Blob) {
      for (let at = 0; at < part.size; at += SLICE) {
        await writable.write(part.slice(at, Math.min(at + SLICE, part.size)));
        written += Math.min(SLICE, part.size - at);
        onProgress?.(written, total);
      }
    } else {
      await writable.write(part as unknown as BufferSource);
      written += part.byteLength;
      onProgress?.(written, total);
    }
  }
  await writable.close();
}

/**
 * Saves bytes to the user's disk, in order of reliability:
 *  1. Native "Save As" streamed to disk (File System Access API, Chrome/Edge)
 *     — capacity never touches a Blob, no ceilings for multi-GB files.
 *  2. Server-mediated same-origin download (all browsers) — no Blob URL at all.
 *  3. Blob URL + DOM-appended anchor (Firefox, small files, offline contexts).
 * Always returns a report so the UI can show exactly what happened.
 */
export async function downloadBlob(
  name: string,
  blobParts: BlobPart[],
  type: string,
  onProgress?: ProgressFn
): Promise<DownloadReport> {
  const pick = (window as { showSaveFilePicker?: (opts?: unknown) => Promise<SaveHandle> }).showSaveFilePicker;
  const total = blobParts.reduce(
    (s, p) => s + (typeof p === "string" ? p.length : p instanceof Blob ? p.size : p.byteLength),
    0
  );
  if (total <= 0) return { ok: false, via: "none", error: "nothing to download (0 bytes)" };
  // Only offer the native dialog to a real user in a real browser. In
  // automated/embedded contexts showSaveFilePicker exists but rejects with
  // AbortError (silently yielding nothing) or never resolves; the server
  // route below covers those.
  const isAutomated = typeof navigator.webdriver === "boolean" ? navigator.webdriver : false;
  const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
  const activationOk = typeof activation === "undefined" ? true : activation.isActive;
  if (typeof pick === "function" && !isAutomated && activationOk) {
    try {
      const handle = await pick({ suggestedName: name });
      await pickerWrite(handle, name, blobParts, onProgress);
      // Read-back only for small files — verifying a multi-GB save would
      // itself load the whole file into RAM and freeze the tab.
      if (total <= VERIFY_READBACK_MAX) {
        const written = await handle.getFile();
        if (written.size !== total) {
          throw new Error(
            `selected file only received ${written.size} of ${total} bytes — saving was interrupted; trying the server route`
          );
        }
      }
      return { ok: true, via: "picker", bytes: total, detail: `${total} bytes` };
    } catch (err) {
      if ((err as Error).name === "AbortError") return { ok: false, via: "picker", error: "cancelled" };
      // Picker failed for another reason — fall through to the server route.
    }
  }
  const server = await downloadViaServer(name, blobParts, onProgress);
  if (server.ok) return server;
  try {
    const blob = new Blob(blobParts, { type });
    const url = URL.createObjectURL(blob);
    fireAnchor(url, true, name);
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    onProgress?.(total, total);
    return {
      ok: true,
      via: "anchor",
      bytes: blob.size,
      detail: `${blob.size} bytes (server route unavailable: ${server.error})`,
    };
  } catch (err) {
    return { ok: false, via: "anchor", error: `${server.error}; anchor failed: ${(err as Error)?.message ?? err}` };
  }
}

/**
 * Streams a File (disk-backed container, e.g. from OPFS) to the user's disk
 * without ever loading it into RAM: picker writes in 4 MiB slices, server
 * path uploads 16 MiB slices, anchor falls back to a blob URL of the File.
 */
export async function downloadFile(
  name: string,
  file: File,
  onProgress?: ProgressFn
): Promise<DownloadReport> {
  const total = file.size;
  if (total <= 0) return { ok: false, via: "none", error: "nothing to download (0 bytes)" };
  const pick = (window as { showSaveFilePicker?: (opts?: unknown) => Promise<SaveHandle> }).showSaveFilePicker;
  const isAutomated = typeof navigator.webdriver === "boolean" ? navigator.webdriver : false;
  const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
  const activationOk = typeof activation === "undefined" ? true : activation.isActive;
  if (typeof pick === "function" && !isAutomated && activationOk) {
    try {
      const handle = await pick({ suggestedName: name });
      await pickerWrite(handle, name, [file], onProgress);
      // Read-back only for small files — verifying a multi-GB save would
      // itself load the whole file into RAM and freeze the tab.
      if (total <= VERIFY_READBACK_MAX) {
        const written = await handle.getFile();
        if (written.size !== total) {
          throw new Error(`selected file only received ${written.size} of ${total} bytes — saving was interrupted`);
        }
      }
      return { ok: true, via: "picker", bytes: total, detail: `${total} bytes streamed from disk` };
    } catch (err) {
      if ((err as Error).name === "AbortError") return { ok: false, via: "picker", error: "cancelled" };
      // Picker failed for another reason — fall through to the server route.
    }
  }
  try {
    const { url } = await uploadFileChunked(name, file, onProgress);
    fireAnchor(url, false, name);
    onProgress?.(total, total);
    return { ok: true, via: "server", bytes: total, detail: `${total} bytes streamed via server` };
  } catch (err) {
    const serverError = (err as Error)?.message ?? String(err);
    try {
      const url = URL.createObjectURL(file);
      fireAnchor(url, true, name);
      onProgress?.(total, total);
      return {
        ok: true,
        via: "anchor",
        bytes: total,
        detail: `${total} bytes (server route unavailable: ${serverError})`,
      };
    } catch (err2) {
      return { ok: false, via: "anchor", error: `${serverError}; anchor failed: ${(err2 as Error)?.message ?? err2}` };
    }
  }
}
