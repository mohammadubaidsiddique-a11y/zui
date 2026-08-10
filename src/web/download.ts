/* global BufferSource, Navigator */

export type DownloadReport =
  | { ok: true; via: "picker" | "server" | "anchor"; bytes: number; detail: string }
  | { ok: false; via: "picker" | "server" | "anchor" | "none"; error: string };

const SAFE_NAME = (name: string): string => name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_") || "download";

// Single-POST uploads below this size; chunked uploads above (any browser, any size).
const SERVER_DIRECT_MAX = 128 * 1024 * 1024;
const SERVER_CHUNK_BYTES = 16 * 1024 * 1024;

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

/** Batches parts into ≤SERVER_CHUNK_BYTES blobs, preserving order. */
async function batchParts(parts: BlobPart[]): Promise<Blob[]> {
  const batches: Blob[] = [];
  let current: Uint8Array[] = [];
  let currentBytes = 0;
  for (const part of parts) {
    if (typeof part === "string") {
      const buf = new TextEncoder().encode(part);
      current.push(buf);
      currentBytes += buf.byteLength;
    } else if (part instanceof Blob) {
      const buf = new Uint8Array(await part.arrayBuffer());
      current.push(buf);
      currentBytes += buf.byteLength;
    } else {
      current.push(part as Uint8Array<ArrayBuffer>);
      currentBytes += part.byteLength;
    }
    if (currentBytes >= SERVER_CHUNK_BYTES) {
      batches.push(new Blob(current as unknown as BlobPart[], { type: "application/octet-stream" }));
      current = [];
      currentBytes = 0;
    }
  }
  if (current.length > 0) batches.push(new Blob(current as unknown as BlobPart[], { type: "application/octet-stream" }));
  return batches;
}

/**
 * Same-origin server-mediated download: the bytes are uploaded to the API
 * (one POST for small payloads, ordered chunks for large ones) and served
 * back with Content-Disposition: attachment, which every browser downloads
 * natively — no Blob URL, no size ceiling.
 */
export async function downloadViaServer(name: string, blobParts: BlobPart[]): Promise<DownloadReport> {
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
      if (!res.ok) return { ok: false, via: "server", error: `staging failed (HTTP ${res.status})` };
      const data = (await res.json()) as { url?: string };
      url = data.url;
    } else {
      const createRes = await fetch("/api/v1/local-download/chunked", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", ...nameHeader(name) },
      });
      if (!createRes.ok) return { ok: false, via: "server", error: `staging failed (HTTP ${createRes.status})` };
      const { id } = (await createRes.json()) as { id: string };
      for (const batch of await batchParts(blobParts)) {
        const res = await fetch(`/api/v1/local-download/chunked/${id}/chunk`, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: batch,
        });
        if (!res.ok) return { ok: false, via: "server", error: `chunk upload failed (HTTP ${res.status})` };
      }
      const finRes = await fetch(`/api/v1/local-download/chunked/${id}/finalize`, { method: "POST" });
      if (!finRes.ok) return { ok: false, via: "server", error: `finalize failed (HTTP ${finRes.status})` };
      const data = (await finRes.json()) as { url?: string };
      url = data.url;
    }
    if (!url) return { ok: false, via: "server", error: "staging returned no url" };
    fireAnchor(url, false, name);
    return { ok: true, via: "server", bytes: total, detail: `${total} bytes` };
  } catch (err) {
    return { ok: false, via: "server", error: (err as Error)?.message ?? String(err) };
  }
}

type SaveHandle = { createWritable(): Promise<FileSystemWritableFileStream> };

const STAGE_ROOT = "/api/v1/local-download";

/** Uploads a File to the staging store in 16 MiB disk slices (no RAM spike). */
export async function uploadFileChunked(name: string, file: File): Promise<{ url: string; id: string }> {
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
  }
  const finRes = await fetch(`${STAGE_ROOT}/chunked/${id}/finalize`, { method: "POST" });
  if (!finRes.ok) throw new Error(`finalize failed (HTTP ${finRes.status})`);
  const data = (await finRes.json()) as { url?: string; id?: string };
  if (!data.url) throw new Error("staging returned no url");
  return { url: data.url, id: data.id ?? id };
}

/** Asks the server to transcode a staged video with ffmpeg (compress/enhance). */
export async function transcodeStaged(id: string, mode: "compress" | "enhance"): Promise<{ url: string; bytes: number }> {
  const res = await fetch(`${STAGE_ROOT}/chunked/${id}/transcode?mode=${mode}`, { method: "POST" });
  if (!res.ok) throw new Error(`transcode failed (HTTP ${res.status})`);
  const data = (await res.json()) as { url?: string; bytes?: number };
  if (!data.url) throw new Error("transcode returned no url");
  return { url: data.url, bytes: data.bytes ?? 0 };
}

/**
 * Saves bytes to the user's disk, in order of reliability:
 *  1. Native "Save As" streamed to disk (File System Access API, Chrome/Edge)
 *     — capacity never touches a Blob, no ceilings for multi-GB files.
 *  2. Server-mediated same-origin download (all browsers) — no Blob URL at all.
 *  3. Blob URL + DOM-appended anchor (Firefox, small files, offline contexts).
 * Always returns a report so the UI can show exactly what happened.
 */
export async function downloadBlob(name: string, blobParts: BlobPart[], type: string): Promise<DownloadReport> {
  const pick = (window as { showSaveFilePicker?: (opts?: unknown) => Promise<SaveHandle> }).showSaveFilePicker;
  // Only offer the native dialog to a real user in a real browser. In
  // automated/embedded contexts showSaveFilePicker exists but rejects with
  // AbortError (silently yielding nothing) or never resolves; the server
  // route below covers those.
  const isAutomated = typeof navigator.webdriver === "boolean" ? navigator.webdriver : false;
  const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
  const activationOk = typeof activation === "undefined" ? true : activation.isActive;
  if (typeof pick === "function" && !isAutomated && activationOk) {
    try {
      const total = blobParts.reduce(
        (s, p) => s + (typeof p === "string" ? p.length : p instanceof Blob ? p.size : p.byteLength),
        0
      );
      const handle = await pick({ suggestedName: name });
      const writable = await handle.createWritable();
      for (const part of blobParts) {
        const chunk = typeof part === "string" ? part : (part as unknown as BufferSource);
        await writable.write(chunk);
      }
      await writable.close();
      return { ok: true, via: "picker", bytes: total, detail: `${total} bytes` };
    } catch (err) {
      if ((err as Error).name === "AbortError") return { ok: false, via: "picker", error: "cancelled" };
      // Picker failed for another reason — fall through to the server route.
    }
  }
  const server = await downloadViaServer(name, blobParts);
  if (server.ok) return server;
  try {
    const blob = new Blob(blobParts, { type });
    const url = URL.createObjectURL(blob);
    fireAnchor(url, true, name);
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
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