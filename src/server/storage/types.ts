import type { Readable } from "node:stream";

export interface PutResult {
  size: number;
  sha256: string | null;
}

export interface StorageObject {
  stream: Readable;
  size: number;
  sha256: string | null;
}

export interface StatInfo {
  size: number;
  sha256: string | null;
}

/** Backend-agnostic object storage interface (local disk, memory, S3/R2). */
export interface ZuiStorage {
  readonly kind: string;

  /** Streams `stream` into `key`, computing SHA-256 of the stored bytes. */
  put(key: string, stream: NodeJS.ReadableStream, options?: { expectedSha256?: string }): Promise<PutResult>;

  /** Returns a readable stream of the object. */
  get(key: string): Promise<StorageObject>;

  stat(key: string): Promise<StatInfo>;

  exists(key: string): Promise<boolean>;

  delete(key: string): Promise<void>;

  /** Byte range read (start/end inclusive) for resumable downloads. */
  range(key: string, start: number, end: number): Promise<Readable>;

  list(prefix: string): Promise<string[]>;

  readJson<T>(key: string): Promise<T | null>;

  writeJson(key: string, value: unknown): Promise<void>;

  dispose(): Promise<void>;
}

export class StorageError extends Error {
  constructor(message: string, public readonly code: "not_found" | "corrupt" | "write" | "backend") {
    super(message);
    this.name = "StorageError";
  }
}

export function storageNotFound(key: string): StorageError {
  return new StorageError(`object not found: ${key}`, "not_found");
}