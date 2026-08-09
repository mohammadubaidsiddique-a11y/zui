/**
 * Input validation: safe filenames, MIME sanity, size limits, token format.
 */

export class ValidationError extends Error {}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const PATH_CHARS = /[/\\]/g;

export function sanitizeFileName(raw: string, fallback = "file"): string {
  if (typeof raw !== "string") throw new ValidationError("fileName must be a string");
  let name = raw.normalize("NFKC").trim();
  name = name.replace(CONTROL_CHARS, "").replace(PATH_CHARS, "_");
  name = name.replace(/^[._]+/, "");
  if (name.length === 0) name = fallback;
  if (name.length > 255) name = name.slice(0, 255);
  return name;
}

export function validateMimeType(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 256) {
    throw new ValidationError("mimeType must be a non-empty string of at most 256 chars");
  }
  if (CONTROL_CHARS.test(raw) || /[\r\n]/g.test(raw)) {
    throw new ValidationError("mimeType contains forbidden characters");
  }
  const [type, subtype] = raw.split("/");
  if (!type || !subtype || !/^[a-zA-Z0-9!#$&^_.+-]+$/.test(type) || !/^[a-zA-Z0-9!#$&^_.+-]+$/.test(subtype)) {
    throw new ValidationError(`mimeType "${raw}" is not a well-formed media type`);
  }
  return raw;
}

export function validateSha256Hex(raw: string): string {
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new ValidationError("sha256 must be a 64-character hex string");
  }
  return raw.toLowerCase();
}

export function validateTokenFormat(raw: string | undefined): void {
  if (!raw) throw new ValidationError("missing token");
  if (!/^[0-9a-f]{64}$/.test(raw)) throw new ValidationError("malformed token");
}

export function validateChunkIndex(index: string): number {
  if (!/^\d+$/.test(index)) throw new ValidationError("chunk index must be an integer");
  const n = Number.parseInt(index, 10);
  if (!Number.isSafeInteger(n) || n < 0) throw new ValidationError("chunk index out of range");
  return n;
}

export function assertSafeStorageKey(key: string): void {
  if (!key || key.length > 1024) throw new ValidationError("invalid storage key");
  if (key.startsWith("/") || key.includes("..") || /[\u0000-\u001f\u007f]/.test(key)) {
    throw new ValidationError("invalid storage key (traversal attempt)");
  }
  if (!/^[a-z0-9][a-z0-9\-._/]*$/i.test(key)) {
    throw new ValidationError("invalid storage key characters");
  }
}

/** Validates the declared original size for a session. */
export function validateSessionSize(size: unknown, maxSessionBytes: number): number {
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
    throw new ValidationError("size must be a non-negative integer");
  }
  if (size > maxSessionBytes) {
    throw new ValidationError(`file exceeds maximum session size (${size} > ${maxSessionBytes})`);
  }
  return size;
}

export function validateChunkSizeParam(chunkSize: unknown, maxChunkBytes: number): number {
  if (typeof chunkSize !== "number" || !Number.isSafeInteger(chunkSize)) {
    throw new ValidationError("chunkSize must be an integer");
  }
  if (chunkSize < 64 * 1024 || chunkSize > maxChunkBytes) {
    throw new ValidationError(`chunkSize must be between 64 KiB and ${maxChunkBytes} bytes`);
  }
  return chunkSize;
}

export function parseCompressionParam(value: unknown): "none" | "deflate-raw" {
  if (value === undefined || value === null || value === "") return "none";
  if (value === "none" || value === "deflate-raw") return value;
  throw new ValidationError(`unsupported compression "${String(value)}"`);
}