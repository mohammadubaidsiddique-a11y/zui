import { ZUI_DEFAULT_CHUNK_SIZE } from "@shared/format";
import { createSha256 } from "./sha256";
import { createPayloadStore } from "./payload";
import { compressChunk, type CompressionMode } from "./compress";
import { encodeFixedPrefix, encodeHeaderBlock, FLAG_COMPRESSED, FORMAT_VERSION } from "./header";
import { SourceReopenError } from "./errors";
import { BufferedReader, type ByteSink, type ByteSource } from "./streams";

export interface ZuiEncodeOptions {
  fileName: string;
  mimeType?: string;
  chunkSize?: number;
  compression?: CompressionMode;
}

export interface ChunkRecord {
  index: number;
  storedSize: number;
  storedSha256: string;
  rawSize: number;
}

export interface ZuiEncodeResult {
  format: "zui";
  fileName: string;
  mimeType: string;
  compression: CompressionMode;
  chunkSize: number;
  chunkCount: number;
  origSize: number;
  origSha256: string;
  headerBytes: number;
  payloadBytes: number;
  trailerBytes: number;
  containerBytes: number;
  containerSha256: string;
  chunks: ChunkRecord[];
}

/** Consumes exact byte counts from a queue of source chunks (bounded by ~chunkSize). */
class Accumulator {
  private parts: Uint8Array[] = [];
  private headOffset = 0;
  len = 0;

  push(b: Uint8Array): void {
    if (b.byteLength > 0) {
      this.parts.push(b);
      this.len += b.byteLength;
    }
  }

  consume(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let o = 0;
    while (o < n) {
      const p = this.parts[0]!;
      const avail = p.length - this.headOffset;
      const take = Math.min(n - o, avail);
      out.set(p.subarray(this.headOffset, this.headOffset + take), o);
      this.headOffset += take;
      o += take;
      if (this.headOffset >= p.length) {
        this.parts.shift();
        this.headOffset = 0;
      }
    }
    this.len -= n;
    return out;
  }

  remainder(): Uint8Array {
    const out = new Uint8Array(this.len);
    let o = 0;
    while (this.parts.length > 0) {
      const p = this.parts.shift()!;
      out.set(p.subarray(this.headOffset), o);
      o += p.length - this.headOffset;
      this.headOffset = 0;
    }
    this.len = 0;
    return out;
  }
}

function u32be(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v, false);
  return b;
}

function u64be(v: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(Math.floor(v)), false);
  return b;
}

const TRAILER_MARK = new Uint8Array([0x5a, 0x54, 0x52, 0x45]); // "ZTRE"

export function buildTrailer(chunks: Array<{ storedSize: number; storedSha256: string }>): Uint8Array {
  const n = chunks.length;
  const out = new Uint8Array(4 + n * 40 + 4);
  new DataView(out.buffer).setUint32(0, n * 40, false);
  let o = 4;
  const sha = (hex: string): Uint8Array => {
    const b = new Uint8Array(32);
    for (let i = 0; i < 32; i += 1) b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return b;
  };
  for (const c of chunks) {
    out.set(u64be(c.storedSize), o);
    o += 8;
    out.set(sha(c.storedSha256), o);
    o += 32;
  }
  out.set(TRAILER_MARK, o);
  return out;
}

/**
 * Encodes a stream of bytes into the ZUI v1 container format.
 *
 * Streaming: the source is consumed once. The intermediate payload is spilled
 * to a payload store (a bounded temp file on the server; memory in the
 * browser), so memory usage stays bounded by one `chunkSize` plus metadata.
 */
export async function encodeZui(
  openSource: () => ByteSource | Promise<ByteSource>,
  options: ZuiEncodeOptions,
  sink: ByteSink
): Promise<ZuiEncodeResult> {
  const chunkSize = options.chunkSize ?? ZUI_DEFAULT_CHUNK_SIZE;
  if (chunkSize <= 0 || chunkSize > 512 * 1024 * 1024) {
    throw new Error(`invalid chunkSize ${chunkSize}`);
  }
  const mimeType = options.mimeType ?? "application/octet-stream";
  const compression = options.compression ?? "none";

  let source: ByteSource;
  try {
    source = await openSource();
  } catch (err) {
    throw new SourceReopenError(err);
  }

  // ---------- pass 1: scan, split and store payload ----------
  const store = await createPayloadStore();
  const origHasher = createSha256();
  const acc = new Accumulator();
  const chunks: ChunkRecord[] = [];
  let origSize = 0;

  const flushChunk = async (raw: Uint8Array): Promise<void> => {
    const stored = compression === "deflate-raw" ? await compressChunk(compression, raw) : raw;
    const storedSha256 = await createSha256().update(stored).digestHex();
    await store.write(stored);
    chunks.push({ index: chunks.length, storedSize: stored.byteLength, storedSha256, rawSize: raw.byteLength });
  };

  for await (const part of source) {
    origHasher.update(part);
    origSize += part.byteLength;
    acc.push(part);
    while (acc.len >= chunkSize) {
      await flushChunk(acc.consume(chunkSize));
    }
  }
  const tail = acc.remainder();
  if (tail.byteLength > 0) await flushChunk(tail);

  const origSha256 = await origHasher.digestHex();

  // ---------- pass 2: assemble container ----------
  const containerHasher = createSha256();
  const write = async (b: Uint8Array): Promise<void> => {
    containerHasher.update(b);
    await sink.write(b);
  };

  const headerSection = encodeHeaderBlock({
    version: FORMAT_VERSION,
    flags: compression === "deflate-raw" ? FLAG_COMPRESSED : 0,
    chunkSize,
    chunkCount: chunks.length,
    origSize,
    origSha256,
    fileName: options.fileName,
    mimeType,
    compression,
  });
  await write(encodeFixedPrefix(headerSection.byteLength, compression === "deflate-raw" ? FLAG_COMPRESSED : 0));
  await write(headerSection);

  const payloadReplay = new BufferedReader(store.replay());
  for (const chunk of chunks) {
    await write(u32be(chunk.storedSize));
    await write(await payloadReplay.readExactly(chunk.storedSize));
  }
  // Drain the replay reader so the payload store's source completes and
  // releases any open resources (temp file handles).
  while ((await payloadReplay.readSome(1024 * 1024)) !== null) {
    // drain
  }

  const trailer = buildTrailer(chunks);
  await write(trailer);

  const containerSha256 = await containerHasher.digestHex();
  const payloadTotal = chunks.reduce((s, c) => s + c.storedSize, 0);
  await store.dispose();

  return {
    format: "zui",
    fileName: options.fileName,
    mimeType,
    compression,
    chunkSize,
    chunkCount: chunks.length,
    origSize,
    origSha256,
    headerBytes: headerSection.byteLength,
    payloadBytes: payloadTotal,
    trailerBytes: trailer.byteLength,
    containerBytes: 16 + headerSection.byteLength + payloadTotal + chunks.length * 4 + trailer.byteLength,
    containerSha256,
    chunks,
  };
}