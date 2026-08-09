import type { ByteSource } from "./streams";

export interface PayloadStore {
  write(bytes: Uint8Array): Promise<void>;
  /** Returns a new async iterator that replays every stored byte in order. */
  replay(): ByteSource;
  /** Total bytes written so far. */
  size(): number;
  dispose(): Promise<void>;
}

/** In-memory payload store (used for small in-browser encodes and tests). */
export class MemoryPayloadStore implements PayloadStore {
  private parts: Uint8Array[] = [];
  private total = 0;

  write(bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength > 0) {
      this.parts.push(Uint8Array.from(bytes));
      this.total += bytes.byteLength;
    }
    return Promise.resolve();
  }

  replay(): ByteSource {
    const parts = this.parts;
    let i = 0;
    return {
      async *[Symbol.asyncIterator]() {
        for (; i < parts.length; i += 1) yield parts[i]!;
      },
    };
  }

  size(): number {
    return this.total;
  }

  dispose(): Promise<void> {
    this.parts = [];
    this.total = 0;
    return Promise.resolve();
  }
}

type FileStoreFactory = () => { create(): Promise<PayloadStore> } | Promise<{ create(): Promise<PayloadStore> }>;

let fileStoreFactory: FileStoreFactory | undefined;

export function registerFilePayloadStore(factory: FileStoreFactory): void {
  fileStoreFactory = factory;
}

export async function createPayloadStore(): Promise<PayloadStore> {
  if (fileStoreFactory) {
    const ns = await fileStoreFactory();
    return ns.create();
  }
  return new MemoryPayloadStore();
}