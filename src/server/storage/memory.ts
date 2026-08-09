import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { bytesToHex } from "@shared/format";
import { storageNotFound, type PutResult, type StorageObject, type ZuiStorage } from "./types";
import { createHashingTransform } from "./util";

/** In-memory object storage for tests and isolation. */
export class MemoryStorage implements ZuiStorage {
  readonly kind = "memory";
  private objects = new Map<string, Uint8Array>();

  private check(key: string): Uint8Array {
    const b = this.objects.get(key);
    if (!b) throw storageNotFound(key);
    return b;
  }

  async put(key: string, stream: NodeJS.ReadableStream, options?: { expectedSha256?: string }): Promise<PutResult> {
    const { transform, sha256, size } = createHashingTransform();
    stream.pipe(transform);
    const chunks: Buffer[] = [];
    for await (const chunk of transform as AsyncIterable<Buffer>) chunks.push(chunk);
    const data = Buffer.concat(chunks);
    const actual = await sha256();
    if (options?.expectedSha256 && actual !== options.expectedSha256.toLowerCase()) {
      throw new Error(`sha-256 mismatch for ${key}`);
    }
    this.objects.set(key, new Uint8Array(data));
    return { size: size(), sha256: actual };
  }

  async get(key: string): Promise<StorageObject> {
    const bytes = this.check(key);
    return { stream: Readable.from([Buffer.from(bytes)]), size: bytes.byteLength, sha256: null };
  }

  async stat(key: string): Promise<{ size: number; sha256: string | null }> {
    const bytes = this.check(key);
    return { size: bytes.byteLength, sha256: null };
  }

  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async range(key: string, start: number, end: number): Promise<Readable> {
    const bytes = this.check(key);
    if (start < 0 || end >= bytes.byteLength || end < start) throw new Error("invalid range");
    return Readable.from([Buffer.from(bytes.slice(start, end + 1))]);
  }

  async list(prefix: string): Promise<string[]> {
    const clean = prefix.replace(/\/+$/, "");
    const out: string[] = [];
    for (const key of this.objects.keys()) {
      if (key.startsWith(clean)) out.push(key);
    }
    return out.sort();
  }

  async readJson<T>(key: string): Promise<T | null> {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  }

  async writeJson(key: string, value: unknown): Promise<void> {
    this.objects.set(key, new TextEncoder().encode(JSON.stringify(value)));
  }

  async dispose(): Promise<void> {
    this.objects.clear();
  }

  sha256OfKey(key: string): string {
    return bytesToHex(new Uint8Array(createHash("sha256").update(this.check(key)).digest()));
  }
}