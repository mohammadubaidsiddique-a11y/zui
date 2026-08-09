import { ZUI_MAX_FILENAME_BYTES, ZUI_MAX_MIME_BYTES, bytesToHex, hexToBytes } from "@shared/format";
import { HeaderCorruptError, InvalidMagicError, UnsupportedVersionError } from "./errors";
import type { CompressionMode } from "./compress";

export const MAGIC = new Uint8Array([0x5a, 0x55, 0x49, 0x01]); // "ZUI\x01"
export const FORMAT_VERSION = 1;
export const FLAG_COMPRESSED = 0b0000_0000_0000_0001;

export interface ZuiHeaderFields {
  version: number;
  flags: number;
  chunkSize: number;
  chunkCount: number;
  origSize: number;
  origSha256: string;
  fileName: string;
  mimeType: string;
  compression: CompressionMode;
}

export interface ZuiHeader extends ZuiHeaderFields {
  format: "zui";
  headerBytes: number; // exact byte length of everything before the first chunk
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function writeStr(dv: DataView, tag: Uint8Array, o: number, s: string): number {
  const b = encoder.encode(s);
  dv.setUint16(o, b.length, false);
  o += 2;
  tag.set(b, o);
  return o + b.length;
}

function readStr(dv: DataView, view: Uint8Array, o: number): { value: string; next: number } {
  const len = dv.getUint16(o, false);
  const next = o + 2 + len;
  if (next > view.length) throw new HeaderCorruptError("truncated string field");
  const b = view.subarray(o + 2, next);
  try {
    return { value: decoder.decode(b), next };
  } catch {
    throw new HeaderCorruptError("non-UTF-8 string field");
  }
}

/** Builds the header byte-array (everything preceding the first chunk). */
export function encodeHeaderBlock(meta: ZuiHeaderFields): Uint8Array {
  const max = 2 + 4 + 8 + 32 + (2 + ZUI_MAX_FILENAME_BYTES) + (2 + ZUI_MAX_MIME_BYTES) + 2 + 16;
  const tag = new Uint8Array(max);
  const dv = new DataView(tag.buffer);
  let o = 0;

  dv.setUint32(o, meta.chunkSize, false);
  o += 4;
  dv.setUint32(o, meta.chunkCount, false);
  o += 4;
  dv.setBigUint64(o, BigInt(Math.floor(meta.origSize)), false);
  o += 8;
  const sha = hexToBytes(meta.origSha256);
  if (sha.length !== 32) throw new HeaderCorruptError("internal: origSha256 must be 32 hex bytes");
  tag.set(sha, o);
  o += 32;
  o = writeStr(dv, tag, o, meta.fileName);
  o = writeStr(dv, tag, o, meta.mimeType);
  o = writeStr(dv, tag, o, meta.compression === "deflate-raw" ? "deflate-raw" : "none");

  return tag.slice(0, o);
}

/** Parses the header block following the 16-byte fixed prefix. */
export function decodeHeaderBlock(block: Uint8Array): ZuiHeaderFields {
  const dv = new DataView(block.buffer, block.byteOffset, block.byteLength);
  const view = new Uint8Array(block.buffer, block.byteOffset, block.byteLength);
  let o = 0;

  const chunkSize = dv.getUint32(o, false);
  o += 4;
  const chunkCount = dv.getUint32(o, false);
  o += 4;
  const origSize = Number(dv.getBigUint64(o, false));
  o += 8;
  const sha = view.subarray(o, o + 32);
  o += 32;
  const fileName = readStr(dv, view, o);
  o = fileName.next;
  const mimeType = readStr(dv, view, o);
  o = mimeType.next;
  const compressionName = readStr(dv, view, o);

  if (chunkSize <= 0) throw new HeaderCorruptError("invalid chunkSize");
  if (!Number.isSafeInteger(origSize) || origSize < 0) throw new HeaderCorruptError("invalid origSize");
  if (chunkCount === 0 && origSize !== 0) throw new HeaderCorruptError("empty chunk table for non-empty file");

  let compression: CompressionMode;
  if (compressionName.value === "deflate-raw") compression = "deflate-raw";
  else if (compressionName.value === "none" || compressionName.value === "") compression = "none";
  else throw new HeaderCorruptError(`unknown compression "${compressionName.value}"`);

  return {
    version: FORMAT_VERSION,
    flags: compression === "deflate-raw" ? FLAG_COMPRESSED : 0,
    chunkSize,
    chunkCount,
    origSize,
    origSha256: bytesToHex(sha),
    fileName: fileName.value,
    mimeType: mimeType.value,
    compression,
  };
}

/** Reads and validates the 16-byte fixed prefix from an open buffered reader. */
export async function readFixedPrefix(reader: {
  readExactly(n: number): Promise<Uint8Array>;
}): Promise<{ headerLength: number; flags: number; version: number }> {
  const head = await reader.readExactly(16);
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  for (let i = 0; i < 4; i += 1) if (head[i] !== MAGIC[i]) throw new InvalidMagicError(head.subarray(0, 4));
  const version = dv.getUint16(4, false);
  if (version !== FORMAT_VERSION) throw new UnsupportedVersionError(version);
  const flags = dv.getUint16(6, false);
  const headerLength = Number(dv.getBigUint64(8, false));
  if (headerLength <= 0 || headerLength > 128 * 1024 * 1024) {
    throw new HeaderCorruptError(`header length ${headerLength} out of range`);
  }
  return { headerLength, flags, version };
}

export function encodeFixedPrefix(headerLength: number, flags: number): Uint8Array {
  const out = new Uint8Array(16);
  out.set(MAGIC, 0);
  const dv = new DataView(out.buffer);
  dv.setUint16(4, FORMAT_VERSION, false);
  dv.setUint16(6, flags, false);
  dv.setBigUint64(8, BigInt(headerLength), false);
  return out;
}