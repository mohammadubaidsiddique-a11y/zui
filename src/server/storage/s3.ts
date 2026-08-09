import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { bytesToHex } from "@shared/format";
import { assertSafeStorageKey } from "@server/validate";
import { StorageError, storageNotFound, type PutResult, type StorageObject, type StatInfo, type ZuiStorage } from "./types";
import { createHashingTransform, collectStream } from "./util";

export interface S3StorageOptions {
  bucket: string;
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
  prefix?: string;
}

/**
 * Production S3 / Cloudflare R2 storage adapter.
 *
 * Keys are namespaced under the configured `prefix`; every PUT streams with
 * SHA-256 verification against the client-declared hash before the object is
 * accepted. Range reads map to S3 `Range` headers, giving resumable downloads.
 */
export class S3Storage implements ZuiStorage {
  readonly kind = "s3";
  private client: S3Client;
  private bucket: string;
  private prefix: string;

  constructor(options: S3StorageOptions) {
    this.bucket = options.bucket;
    this.prefix = (options.prefix ?? "zui").replace(/\/$/, "");
    this.client = new S3Client({
      region: options.region ?? "auto",
      endpoint: options.endpoint,
      forcePathStyle: options.forcePathStyle ?? false,
      credentials:
        options.accessKeyId && options.secretAccessKey
          ? { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey }
          : undefined,
    });
  }

  private fullKey(key: string): string {
    assertSafeStorageKey(key);
    return `${this.prefix}/${key}`;
  }

  async put(key: string, stream: NodeJS.ReadableStream, options?: { expectedSha256?: string }): Promise<PutResult> {
    const fullKey = this.fullKey(key);
    const { transform, sha256, size } = createHashingTransform();
    stream.pipe(transform);
    try {
      const upload = new Upload({
        client: this.client,
        params: {
          Bucket: this.bucket,
          Key: fullKey,
          Body: transform as unknown as Readable,
        },
      });
      await upload.done();
    } catch (err) {
      await this.delete(key).catch(() => undefined);
      throw new StorageError(`s3 put failed for ${key}: ${(err as Error).message}`, "write");
    }
    const actual = await sha256();
    if (options?.expectedSha256 && actual !== options.expectedSha256.toLowerCase()) {
      await this.delete(key).catch(() => undefined);
      throw new StorageError(`sha-256 mismatch for ${key}: expected ${options.expectedSha256}, got ${actual}`, "corrupt");
    }
    return { size: size(), sha256: actual };
  }

  async get(key: string): Promise<StorageObject> {
    const fullKey = this.fullKey(key);
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: fullKey }));
      const size = Number(res.ContentLength ?? 0);
      return {
        stream: res.Body as unknown as Readable,
        size,
        sha256: res.Metadata?.["sha256"] ?? null,
      };
    } catch (err) {
      throw this.mapError(err, key);
    }
  }

  async stat(key: string): Promise<StatInfo> {
    const fullKey = this.fullKey(key);
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: fullKey }));
      return { size: Number(res.ContentLength ?? 0), sha256: res.Metadata?.["sha256"] ?? null };
    } catch (err) {
      throw this.mapError(err, key);
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
    const fullKey = this.fullKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: fullKey })).catch(() => undefined);
  }

  async range(key: string, start: number, end: number): Promise<Readable> {
    const fullKey = this.fullKey(key);
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: fullKey, Range: `bytes=${start}-${end}` })
      );
      return res.Body as unknown as Readable;
    } catch (err) {
      throw this.mapError(err, key);
    }
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    let continuation: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: this.fullKey(prefix),
          ContinuationToken: continuation,
        })
      );
      for (const obj of res.Contents ?? []) {
        out.push(obj.Key!.slice(this.prefix.length + 1));
      }
      continuation = res.NextContinuationToken;
    } while (continuation);
    return out;
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
    const fullKey = this.fullKey(key);
    const body = Buffer.from(JSON.stringify(value), "utf8");
    const sha = bytesToHex(new Uint8Array(createHash("sha256").update(body).digest()));
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: fullKey,
        Body: body,
        Metadata: { sha256: sha },
      })
    );
  }

  async dispose(): Promise<void> {
    this.client.destroy();
  }

  private mapError(err: unknown, key: string): StorageError {
    const code = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    if (code === 404 || code === 403) return storageNotFound(key);
    return new StorageError(`s3 error for ${key}: ${(err as Error).message}`, "backend");
  }
}