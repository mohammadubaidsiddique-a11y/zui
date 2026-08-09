import { mkdir, rename, readdir, rm, stat } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { join, dirname, basename } from "node:path";
import { createHash } from "node:crypto";
import { bytesToHex } from "@shared/format";
import { assertSafeStorageKey } from "@server/validate";
import { StorageError, storageNotFound, type PutResult, type StorageObject, type StatInfo, type ZuiStorage } from "./types";
import { createHashingTransform, collectStream } from "./util";

/**
 * Local-disk object storage.
 *
 * - Every key is validated against path traversal before use.
 * - Writes go to a temp file and are atomically renamed into place.
 * - PUTs compute SHA-256 while streaming; a provided expected hash is
 *   enforced before the object is visible at its final key.
 */
export class LocalStorage implements ZuiStorage {
  readonly kind = "local";
  private root: string;

  constructor(root: string) {
    this.root = root;
  }

  private resolve(key: string): string {
    assertSafeStorageKey(key);
    return join(this.root, ...key.split("/"));
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  async init(): Promise<void> {
    await this.ensureDir();
  }

  async put(key: string, stream: NodeJS.ReadableStream, options?: { expectedSha256?: string }): Promise<PutResult> {
    await this.ensureDir();
    const dest = this.resolve(key);
    await mkdir(dirname(dest), { recursive: true });
    const tmp = join(dirname(dest), `.tmp-${basename(dest)}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const { transform, sha256, size } = createHashingTransform();
    try {
      await new Promise<void>((resolve, reject) => {
        const onErr = (err: Error): void => reject(err);
        stream.on("error", onErr);
        const out = createWriteStream(tmp);
        out.on("error", onErr);
        stream.pipe(transform).pipe(out);
        out.on("close", () => {
          stream.off("error", onErr);
          resolve();
        });
      });
      const actual = await sha256();
      if (options?.expectedSha256 && actual !== options.expectedSha256.toLowerCase()) {
        await rm(tmp, { force: true });
        throw new StorageError(`sha-256 mismatch for ${key}: expected ${options.expectedSha256}, got ${actual}`, "corrupt");
      }
      await rename(tmp, dest);
      return { size: size(), sha256: actual };
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      if (err instanceof StorageError) throw err;
      throw new StorageError(`write failed for ${key}: ${(err as Error).message}`, "write");
    }
  }

  async get(key: string): Promise<StorageObject> {
    const dest = this.resolve(key);
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(dest);
    } catch {
      throw storageNotFound(key);
    }
    const stream = createReadStream(dest);
    return { stream: stream as unknown as Readable, size: info.size, sha256: null };
  }

  async stat(key: string): Promise<StatInfo> {
    const dest = this.resolve(key);
    try {
      const info = await stat(dest);
      return { size: info.size, sha256: null };
    } catch {
      throw storageNotFound(key);
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.stat(key);
      return true;
    } catch (err) {
      if (err instanceof StorageError && err.code === "not_found") return false;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  async range(key: string, start: number, end: number): Promise<Readable> {
    const dest = this.resolve(key);
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(dest);
    } catch {
      throw storageNotFound(key);
    }
    if (start < 0 || end >= info.size || end < start) {
      throw new StorageError(`invalid range ${start}-${end} for ${info.size}-byte object`, "corrupt");
    }
    const stream = createReadStream(dest, { start, end });
    return stream as unknown as Readable;
  }

  async list(prefix: string): Promise<string[]> {
    await this.ensureDir();
    const clean = prefix.replace(/\/+$/, "");
    const base = join(this.root, ...clean.split("/"));
    const out: string[] = [];
    try {
      await this.walk(base, clean, out);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return out;
  }

  private async walk(dir: string, keyPrefix: string, out: string[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const key = `${keyPrefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await this.walk(full, key, out);
      } else if (entry.name.startsWith(".tmp-")) {
        // skip temp files
      } else {
        out.push(key.replace(/^\//, ""));
      }
    }
  }

  async readJson<T>(key: string): Promise<T | null> {
    try {
      const obj = await this.get(key);
      const raw = await collectStream(obj.stream);
      return JSON.parse(raw.toString("utf8")) as T;
    } catch (err) {
      if (err instanceof StorageError && err.code === "not_found") return null;
      throw err;
    }
  }

  async writeJson(key: string, value: unknown): Promise<void> {
    const buf = Buffer.from(JSON.stringify(value), "utf8");
    await this.put(key, Readable.from([buf]));
  }

  async dispose(): Promise<void> {
    // nothing to do; data is persisted on disk
  }
}

export function sha256OfBuffer(buf: Buffer): string {
  return bytesToHex(new Uint8Array(createHash("sha256").update(buf).digest()));
}