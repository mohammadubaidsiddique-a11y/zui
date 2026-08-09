/* global BufferSource, BodyInit, RequestInit, Navigator */
const SAFE_NAME = (name: string): string => name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_") || "download";

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

/**
 * Same-origin server-mediated download: the bytes are POSTed to the API and
 * served back with Content-Disposition: attachment, which every browser
 * (Safari included) downloads natively — no Blob URL, no size ceiling.
 */
export async function downloadViaServer(name: string, blobParts: BlobPart[], urlPath: string | undefined): Promise<boolean> {
  try {
    if (!urlPath) return false;
    const total = blobParts.reduce(
      (s, p) => s + (typeof p === "string" ? p.length : p instanceof Blob ? p.size : p.byteLength),
      0
    );
    // Stream the body for payloads that would exceed Safari's Blob limits;
    // small ones go as a plain Blob for maximum browser compatibility.
    const body: BodyInit =
      total > 1024 * 1024 * 1024
        ? new ReadableStream<Uint8Array>({
            start(controller) {
              for (const part of blobParts) {
                controller.enqueue(part instanceof Uint8Array ? part : new TextEncoder().encode(String(part)));
              }
              controller.close();
            },
          })
        : new Blob(blobParts, { type: blobParts.length > 0 ? undefined : undefined });
    const res = await fetch(urlPath, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Zui-FileName": encodeURIComponent(name),
      },
      body,
      ...(total > 1024 * 1024 * 1024 ? { duplex: "half" as const } : {}),
    } as RequestInit);
    if (!res.ok) return false;
    const data = (await res.json()) as { url?: string };
    if (!data.url) return false;
    fireAnchor(data.url, false, name);
    return true;
  } catch {
    return false;
  }
}

type SaveHandle = { createWritable(): Promise<FileSystemWritableFileStream> };

/**
 * Saves bytes to the user's disk, in order of reliability:
 *  1. Native "Save As" streamed to disk (File System Access API, Chrome/Edge)
 *     — capacity never touches a Blob, no ceilings for multi-GB files.
 *  2. Server-mediated same-origin download (all browsers) — no Blob URL at all.
 *  3. Blob URL + DOM-appended anchor (Firefox, small files, offline contexts).
 */
export async function downloadBlob(name: string, blobParts: BlobPart[], type: string): Promise<void> {
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
      const handle = await pick({ suggestedName: name });
      const writable = await handle.createWritable();
      for (const part of blobParts) {
        const chunk = typeof part === "string" ? part : (part as unknown as BufferSource);
        await writable.write(chunk);
      }
      await writable.close();
      return;
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      // Picker unavailable in this context — fall through to the server route.
    }
  }
  const okay = await downloadViaServer(name, blobParts, "/api/v1/local-download");
  if (okay) return;
  const blob = new Blob(blobParts, { type });
  const url = URL.createObjectURL(blob);
  triggerDownload(name, url);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}