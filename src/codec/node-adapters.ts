/**
 * Node-only native adapters for the codec.
 *
 * Imported from server/CLI/bench/tests entry points. Registers:
 *  - native SHA-256 via `node:crypto`
 *  - native raw-DEFLATE via `node:zlib`
 *  - on-disk payload store (temp file) so large encodes stay memory-bounded
 */
import { createHash } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerNativeSha256, type HashLike } from "@codec/sha256";
import { registerNativeDeflater } from "@codec/compress";
import { registerFilePayloadStore, type PayloadStore } from "@codec/payload";
import type { ByteSource } from "@codec/streams";

export function registerNodeCodecAdapters(): void {
  registerNativeSha256(
    (): HashLike => {
      const h = createHash("sha256");
      return {
        update(bytes: Uint8Array): HashLike {
          h.update(bytes);
          return this;
        },
        async digest(): Promise<Uint8Array> {
          const buf = h.digest();
          return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        },
        async digestHex(): Promise<string> {
          return h.digest("hex");
        },
      };
    }
  );

  registerNativeDeflater({
    async compress(bytes: Uint8Array): Promise<Uint8Array> {
      return deflateRawSync(bytes, { level: 6 });
    },
    async inflate(bytes: Uint8Array): Promise<Uint8Array> {
      return inflateRawSync(bytes);
    },
  });

  registerFilePayloadStore(() => ({
    create(): Promise<PayloadStore> {
      return FilePayloadStore.create();
    },
  }));
}

class FilePayloadStore implements PayloadStore {
  private handle: Awaited<ReturnType<typeof open>> | null = null;
  private sizeBytes = 0;

  private constructor(private path: string) {}

  static async create(): Promise<FilePayloadStore> {
    const dir = await mkdtemp(join(tmpdir(), "zui-payload-"));
    const store = new FilePayloadStore(join(dir, "payload.bin"));
    store.handle = await open(store.path, "w");
    return store;
  }

  async write(bytes: Uint8Array): Promise<void> {
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    await this.handle!.write(buf);
    this.sizeBytes += bytes.byteLength;
  }

  replay(): ByteSource {
    const path = this.path;
    return {
      async *[Symbol.asyncIterator]() {
        const fh = await open(path, "r");
        try {
          const buf = Buffer.alloc(1024 * 1024);
          for (;;) {
            const { bytesRead } = await fh.read(buf, 0, buf.length, null);
            if (bytesRead === 0) break;
            yield new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
          }
        } finally {
          await fh.close();
        }
      },
    };
  }

  size(): number {
    return this.sizeBytes;
  }

  async dispose(): Promise<void> {
    if (this.handle) {
      await this.handle.close();
      this.handle = null;
    }
    await rm(this.path, { force: true });
    await rm(join(this.path, ".."), { force: true, recursive: true });
  }
}