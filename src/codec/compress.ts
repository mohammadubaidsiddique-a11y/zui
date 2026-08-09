/**
 * Optional per-chunk compression.
 *
 * Only real compression is supported: mode "none" stores raw bytes; mode
 * "deflate-raw" applies raw DEFLATE (RFC 1951) to each chunk. A native `zlib`
 * adapter is registered on Node (server/CLI). Web environments use the
 * platform `CompressionStream`/`DecompressionStream` implementation.
 */

import { concatParts } from "./streams";

export type CompressionMode = "none" | "deflate-raw";

export function parseCompressionName(name: string): CompressionMode {
  if (name === "deflate-raw") return "deflate-raw";
  if (name === "none" || name === "") return "none";
  throw new Error(`unsupported compression mode "${name}"`);
}

const ENTROPY_CUTOFF = 7.4; // bits per byte; above ~this deflate gains nothing

/**
 * Cheap compressibility probe: byte-entropy over a sample. Already-compressed
 * media (video, audio, JPEG, PNG, archives) is ~8 bits/byte — deflating it
 * costs CPU and memory for a fraction of a percent. Text and logs (~4-6
 * bits/byte) get a big win. Used to skip compression on files where it can't
 * help, so huge media files package instantly.
 */
export function probeCompressible(sample: Uint8Array): boolean {
  if (sample.byteLength === 0) return true;
  const freq = new Uint32Array(256);
  for (let i = 0; i < sample.byteLength; i += 1) freq[sample[i]!]! += 1;
  let entropy = 0;
  for (let i = 0; i < 256; i += 1) {
    const c = freq[i]!;
    if (c === 0) continue;
    const p = c / sample.byteLength;
    entropy -= p * Math.log2(p);
  }
  return entropy <= ENTROPY_CUTOFF;
}

interface NativeDeflater {
  compress(bytes: Uint8Array): Promise<Uint8Array>;
  inflate(bytes: Uint8Array): Promise<Uint8Array>;
}

let nativeDeflater: NativeDeflater | undefined;

export function registerNativeDeflater(d: NativeDeflater): void {
  nativeDeflater = d;
}

export function compressionSupported(mode: CompressionMode): boolean {
  if (mode === "none") return true;
  if (mode === "deflate-raw") {
    return !!nativeDeflater || typeof CompressionStream !== "undefined";
  }
  return false;
}

export async function compressChunk(mode: CompressionMode, raw: Uint8Array): Promise<Uint8Array> {
  if (mode === "none") return raw;
  if (mode === "deflate-raw") {
    if (nativeDeflater) return nativeDeflater.compress(raw);
    return webDeflateRaw(raw);
  }
  throw new Error("unreachable compression mode");
}

export async function decompressChunk(mode: CompressionMode, stored: Uint8Array): Promise<Uint8Array> {
  if (mode === "none") return stored;
  if (mode === "deflate-raw") {
    if (nativeDeflater) return nativeDeflater.inflate(stored);
    return webInflateRaw(stored);
  }
  throw new Error("unreachable compression mode");
}

async function webDeflateRaw(input: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === "undefined") {
    throw new Error("deflate-raw compression requires a native zlib adapter in this environment");
  }
  const cs = new CompressionStream("deflate-raw");
  const writer = cs.writable.getWriter();
  const readPromise = webCollectAll(cs.readable);
  await writer.write(Uint8Array.from(input));
  await writer.close();
  return readPromise;
}

async function webInflateRaw(input: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("deflate-raw decompression requires a native zlib adapter in this environment");
  }
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  const readPromise = webCollectAll(ds.readable);
  await writer.write(Uint8Array.from(input));
  await writer.close();
  return readPromise;
}

async function webCollectAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.byteLength) parts.push(Uint8Array.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return concatParts(parts);
}