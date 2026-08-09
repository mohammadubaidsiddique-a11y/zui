import { bytesToHex } from "@shared/format";
import { createSha256 } from "./sha256";
import { decompressChunk } from "./compress";
import { decodeHeaderBlock, readFixedPrefix, type ZuiHeader } from "./header";
import {
  ChunkIntegrityError,
  ContainerIntegrityError,
  HeaderCorruptError,
  OriginalIntegrityError,
} from "./errors";
import { BufferedReader, type ByteSource } from "./streams";
import { rawSizeAt } from "./plan";

export const TRAILER_MARK = new Uint8Array([0x5a, 0x54, 0x52, 0x45]); // "ZTRE"

export interface DecodedChunk {
  index: number;
  storedSize: number;
  storedSha256: string;
  rawSize: number;
  stored: Uint8Array;
  raw: Uint8Array;
}

export interface ZuiVerifyResult {
  valid: boolean;
  fileName: string;
  mimeType: string;
  compression: string;
  chunkSize: number;
  chunkCount: number;
  origSize: number;
  origSha256: string;
  chunksVerified: number;
  trailerOk: boolean;
  origHashOk: boolean;
  containerBytes: number;
  errors: string[];
}

/** Streaming decoder: header, per-chunk read + verification, trailer validation. */
export class ZuiDecoder {
  private reader: BufferedReader;
  header: ZuiHeader;
  private trailerChecked = false;
  trailerOk = false;

  private constructor(reader: BufferedReader, header: ZuiHeader) {
    this.reader = reader;
    this.header = header;
  }

  static async open(source: ByteSource): Promise<ZuiDecoder> {
    const reader = source instanceof BufferedReader ? source : new BufferedReader(source);
    const { headerLength, flags } = await readFixedPrefix(reader);
    const block = await reader.readExactly(headerLength);
    const fields = decodeHeaderBlock(block);
    if ((flags & 1) !== 0 && fields.compression === "none") {
      throw new HeaderCorruptError("flag says compressed but header says none");
    }
    if ((flags & 1) === 0 && fields.compression === "deflate-raw") {
      throw new HeaderCorruptError("header says deflate-raw but flag says not compressed");
    }
    const header: ZuiHeader = { ...fields, format: "zui", headerBytes: 16 + headerLength };
    return new ZuiDecoder(reader, header);
  }

  expectedRawSize(index: number): number {
    return rawSizeAt(this.header.origSize, this.header.chunkSize, index, this.header.chunkCount);
  }

  /** Total container bytes consumed from the source stream. */
  containerBytes(): number {
    return this.reader.consumedBytes();
  }

  /** Reads and verifies each chunk sequentially. Consumes exactly one pass. */
  async *chunks(): AsyncGenerator<DecodedChunk> {
    const h = this.header;
    for (let index = 0; index < h.chunkCount; index += 1) {
      const rawSize = this.expectedRawSize(index);
      const sizeBytes = await this.reader.readExactly(4);
      const storedSize = new DataView(sizeBytes.buffer, sizeBytes.byteOffset, sizeBytes.byteLength).getUint32(0, false);
      if (storedSize === 0 || storedSize > 512 * 1024 * 1024) {
        throw new ContainerIntegrityError(`chunk ${index} declares invalid stored size ${storedSize}`);
      }
      if (h.compression === "none" && storedSize !== rawSize) {
        throw new ContainerIntegrityError(
          `chunk ${index} stored size ${storedSize} does not match expected raw size ${rawSize}`
        );
      }
      const hasher = createSha256();
      const stored = new Uint8Array(storedSize);
      let filled = 0;
      while (filled < storedSize) {
        const part = await this.reader.readSome(storedSize - filled);
        if (!part) throw new ContainerIntegrityError(`chunk ${index} truncated (${filled}/${storedSize} bytes)`);
        stored.set(part, filled);
        hasher.update(part);
        filled += part.byteLength;
      }
      const storedSha256 = await hasher.digestHex();
      const raw = h.compression === "deflate-raw" ? await decompressChunk(h.compression, stored) : stored;
      if (raw.byteLength !== rawSize) {
        throw new ContainerIntegrityError(
          `chunk ${index} raw size ${raw.byteLength} does not match expected ${rawSize}`
        );
      }
      yield { index, storedSize, storedSha256, rawSize, stored, raw };
    }
  }

  /** Validates the trailing chunk table against the streamed chunks. Must run after `chunks()`. */
  async finish(computed: Array<{ storedSize: number; storedSha256: string }>): Promise<void> {
    const n = this.header.chunkCount;
    const lenBytes = await this.reader.readExactly(4);
    const tableLen = new DataView(lenBytes.buffer, lenBytes.byteOffset, lenBytes.byteLength).getUint32(0, false);
    if (tableLen !== n * 40) {
      throw new ContainerIntegrityError(`trailer table length ${tableLen} does not match ${n * 40}`);
    }
    const table = await this.reader.readExactly(n * 40);
    const dv = new DataView(table.buffer, table.byteOffset, table.byteLength);
    for (let i = 0; i < n; i += 1) {
      const storedSize = Number(dv.getBigUint64(i * 40, false));
      const sha = bytesToHex(table.subarray(i * 40 + 8, i * 40 + 40));
      const got = computed[i];
      if (!got || got.storedSize !== storedSize || got.storedSha256 !== sha) {
        throw new ContainerIntegrityError(
          `trailer mismatch at chunk ${i} (expected size=${storedSize} sha=${sha}, got size=${got?.storedSize} sha=${got?.storedSha256})`
        );
      }
    }
    const mark = await this.reader.readExactly(4);
    for (let i = 0; i < 4; i += 1) {
      if (mark[i] !== TRAILER_MARK[i]) throw new ContainerIntegrityError("missing trailer footer mark");
    }
    const trailing = await this.reader.readSome(1);
    if (trailing !== null) throw new ContainerIntegrityError("unexpected trailing bytes after trailer");
    this.trailerOk = true;
    this.trailerChecked = true;
  }

  /** Verified full reconstruction of the original bytes, one chunk at a time. */
  async *reconstruct(): AsyncGenerator<Uint8Array> {
    const computed: Array<{ storedSize: number; storedSha256: string }> = [];
    const origHasher = createSha256();
    for await (const chunk of this.chunks()) {
      computed.push({ storedSize: chunk.storedSize, storedSha256: chunk.storedSha256 });
      origHasher.update(chunk.raw);
      yield chunk.raw;
    }
    await this.finish(computed);
    const origSha256 = await origHasher.digestHex();
    if (origSha256 !== this.header.origSha256) {
      throw new OriginalIntegrityError(this.header.origSha256, origSha256);
    }
  }
}

export interface ZuiInspectResult {
  header: ZuiHeader;
  chunks: Array<{ index: number; storedSize: number; rawSize: number }>;
  trailerOk: boolean;
  containerBytes: number;
}

/** Inspects a .zui container (header + chunk table) by streaming through it. */
export async function inspectZui(source: ByteSource): Promise<ZuiInspectResult> {
  const decoder = await ZuiDecoder.open(source);
  const h = decoder.header;
  const computed: Array<{ storedSize: number; storedSha256: string }> = [];
  const chunks: ZuiInspectResult["chunks"] = [];
  for await (const chunk of decoder.chunks()) {
    computed.push({ storedSize: chunk.storedSize, storedSha256: chunk.storedSha256 });
    chunks.push({ index: chunk.index, storedSize: chunk.storedSize, rawSize: chunk.rawSize });
  }
  await decoder.finish(computed);
  const containerBytes = decoder.containerBytes();
  return { header: h, chunks, trailerOk: decoder.trailerOk, containerBytes };
}

/**
 * Full integrity verification of a container. Never throws; collects all
 * detected errors. Streams the container exactly once.
 */
export async function verifyZui(source: ByteSource): Promise<ZuiVerifyResult> {
  const errors: string[] = [];
  let trailerOk = false;
  let origHashOk = false;
  let chunksVerified = 0;
  let containerBytes = 0;
  let header: ZuiHeader | undefined;

  try {
    const decoder = await ZuiDecoder.open(source);
    header = decoder.header;
    const computed: Array<{ storedSize: number; storedSha256: string }> = [];
    const origHasher = createSha256();
    for await (const chunk of decoder.chunks()) {
      computed.push({ storedSize: chunk.storedSize, storedSha256: chunk.storedSha256 });
      origHasher.update(chunk.raw);
      chunksVerified += 1;
    }
    await decoder.finish(computed);
    trailerOk = decoder.trailerOk;
    const origSha256 = await origHasher.digestHex();
    origHashOk = origSha256 === decoder.header.origSha256;
    if (!origHashOk) errors.push(`original SHA-256 mismatch (expected ${decoder.header.origSha256}, got ${origSha256})`);
    containerBytes = decoder.containerBytes();
  } catch (err) {
    if (err instanceof ChunkIntegrityError || err instanceof ContainerIntegrityError || err instanceof OriginalIntegrityError) {
      errors.push(err.message);
    } else {
      errors.push(String((err as Error)?.message ?? err));
    }
  }

  const h = header;
  return {
    valid: errors.length === 0 && trailerOk && origHashOk,
    fileName: h?.fileName ?? "",
    mimeType: h?.mimeType ?? "",
    compression: h?.compression ?? "none",
    chunkSize: h?.chunkSize ?? 0,
    chunkCount: h?.chunkCount ?? 0,
    origSize: h?.origSize ?? 0,
    origSha256: h?.origSha256 ?? "",
    chunksVerified,
    trailerOk,
    origHashOk,
    containerBytes,
    errors,
  };
}

/** Convenience: full verify + throw-first (used by tests/CLI). */
export async function verifyZuiOrThrow(source: ByteSource): Promise<ZuiVerifyResult> {
  const result = await verifyZui(source);
  if (!result.valid) throw new Error(result.errors.join("; "));
  return result;
}