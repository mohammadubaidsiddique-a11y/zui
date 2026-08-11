import { registerFilePayloadStore, type PayloadStore } from "@codec/payload";
import type { ByteSource } from "@codec/streams";

/* global FileSystemFileHandle, BufferSource */

/**
 * Browser adapters that keep multi-gigabyte wraps memory-flat:
 *  - an OPFS-backed payload store (the encode spool lives on disk, not RAM)
 *  - download of the finished container streams from disk via a File URL
 */

export async function opfsAvailable(): Promise<boolean> {
  try {
    const root = await navigator.storage.getDirectory();
    const probe = await root.getFileHandle("__zui_probe__", { create: true });
    if (typeof probe.createWritable !== "function") return false;
    const w = await probe.createWritable();
    await w.write("x");
    await w.close();
    await root.removeEntry("__zui_probe__");
    return true;
  } catch {
    return false;
  }
}

export class OpfsPayloadStore implements PayloadStore {
  private written = 0;

  private constructor(
    private readonly root: FileSystemDirectoryHandle,
    private readonly name: string,
    private readonly handle: FileSystemFileHandle,
    private writable: FileSystemWritableFileStream
  ) {}

  static async create(): Promise<OpfsPayloadStore> {
    const root = await navigator.storage.getDirectory();
    const name = `zui-payload-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`;
    const handle = await root.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    return new OpfsPayloadStore(root, name, handle, writable);
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength === 0) return;
    await this.writable.write(bytes as unknown as BufferSource);
    this.written += bytes.byteLength;
  }

  replay(): ByteSource {
    const writable = this.writable;
    const handle = this.handle;
    return {
      async *[Symbol.asyncIterator]() {
        try {
          await writable.close();
        } catch {
          /* already closed */
        }
        const f = await handle.getFile();
        const reader = f.stream().getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value?.byteLength) yield value;
          }
        } finally {
          reader.releaseLock();
        }
      },
    };
  }

  size(): number {
    return this.written;
  }

  async dispose(): Promise<void> {
    try {
      await this.writable.close();
    } catch {
      /* already closed */
    }
    await this.root.removeEntry(this.name).catch(() => undefined);
  }
}

export function registerWebPayloadStore(): void {
  registerFilePayloadStore(() => ({
    create(): Promise<PayloadStore> {
      return OpfsPayloadStore.create();
    },
  }));
}

export interface OpfsOutFile {
  handle: FileSystemFileHandle;
  writable: FileSystemWritableFileStream;
  name: string;
}

/** Opens a disk-backed output file for the container being built. */
export async function createOpfsOutFile(prefix: string): Promise<OpfsOutFile> {
  const root = await navigator.storage.getDirectory();
  const name = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.zui`;
  const handle = await root.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  return { handle, writable, name };
}

/** Closes the output writable so the file is safe to read afterwards. */
export async function closeOpfsOutFile(out: OpfsOutFile): Promise<void> {
  try {
    await out.writable.close();
  } catch {
    /* already closed */
  }
}

/** Reads the finished OPFS file's bytes (for the reliable download ladder). */
export async function readOpfsBytes(out: OpfsOutFile): Promise<Uint8Array> {
  await closeOpfsOutFile(out);
  const f = await out.handle.getFile();
  return new Uint8Array(await f.arrayBuffer());
}

/**
 * Deletes previously wrapped OPFS files that are no longer referenced by the
 * UI. Called when a new wrap starts — old files must not be removed on a
 * timer, because the Download button keeps referencing them (removing one
 * makes Chrome throw NotReadableError: "The requested file could not be read,
 * typically due to permission problems…").
 */
export async function cleanupStaleWrapFiles(exceptName: string | null): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    const values = (root as FileSystemDirectoryHandle & {
      values(): AsyncIterableIterator<FileSystemFileHandle>;
    }).values();
    for await (const handle of values) {
      if (handle.kind === "file" && /^zui-(wrap|restore)-.*\.zui$/.test(handle.name) && handle.name !== exceptName) {
        await root.removeEntry(handle.name).catch(() => undefined);
      }
    }
  } catch {
    /* OPFS unavailable */
  }
}