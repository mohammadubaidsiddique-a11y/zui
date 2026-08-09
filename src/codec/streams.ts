/**
 * Environment-agnostic byte streaming primitives.
 *
 * The codec library itself only depends on async iteration over `Uint8Array`;
 * adapters convert Node streams and web `ReadableStream`s into that shape.
 */

export type ByteSource = Iterable<Uint8Array<ArrayBufferLike>> | AsyncIterable<Uint8Array<ArrayBufferLike>>;

export interface ByteSink {
  write(bytes: Uint8Array<ArrayBufferLike>): Promise<void> | void;
}

export async function* nodeStreamToSource(stream: import("node:stream").Readable): ByteSource {
  for await (const chunk of stream) {
    yield chunk as Uint8Array;
  }
}

export async function* webStreamToSource(stream: ReadableStream<Uint8Array>): ByteSource {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Pulls exact byte counts from a `ByteSource` without buffering the whole file. */
export class BufferedReader {
  private queue: Uint8Array[] = [];
  private offset = 0;
  private eof = false;
  private iterator: AsyncIterator<Uint8Array>;
  private consumedCount = 0;

  constructor(source: ByteSource) {
    const asyncOf = (source as { [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array> })[Symbol.asyncIterator];
    const asyncIter = asyncOf?.call(source);
    if (asyncIter) {
      this.iterator = asyncIter;
    } else {
      this.iterator = (source as Iterable<Uint8Array>)[Symbol.iterator]() as unknown as AsyncIterator<Uint8Array>;
    }
  }

  /** Total bytes pulled out of this reader so far. */
  consumedBytes(): number {
    return this.consumedCount;
  }

  private async pull(): Promise<boolean> {
    if (this.eof) return false;
    const { done, value } = await this.iterator.next();
    if (done) {
      this.eof = true;
      return false;
    }
    this.queue.push(value as Uint8Array);
    return true;
  }

  private top(): Uint8Array | undefined {
    while (this.queue.length > 0 && this.offset >= this.queue[0]!.length) {
      this.queue.shift();
      this.offset = 0;
    }
    return this.queue[0];
  }

  /** Read exactly `n` bytes or throw if the source ends first. */
  async readExactly(n: number): Promise<Uint8Array> {
    if (n === 0) return new Uint8Array(0);
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const top = this.top();
      if (!top) {
        if (!(await this.pull())) throw new UnexpectedEofError(n, filled);
        continue;
      }
      const take = Math.min(n - filled, top.length - this.offset);
      out.set(top.subarray(this.offset, this.offset + take), filled);
      this.offset += take;
      filled += take;
    }
    this.consumedCount += n;
    return out;
  }

  /** Reads up to `n` bytes; returns `null` at clean EOF with nothing cached. */
  async readSome(n: number): Promise<Uint8Array | null> {
    if (n === 0) return new Uint8Array(0);
    while (!this.top()) {
      if (!(await this.pull())) return null;
    }
    const top = this.top()!;
    const take = Math.min(n, top.length - this.offset);
    const out = Uint8Array.from(top.subarray(this.offset, this.offset + take));
    this.offset += take;
    this.consumedCount += out.byteLength;
    return out;
  }
}

export class UnexpectedEofError extends Error {
  constructor(need: number, hadChunks: number) {
    super(`unexpected end of stream (needed ${need} more bytes, finished after ${hadChunks} chunks)`);
    this.name = "UnexpectedEofError";
  }
}

export function concatParts(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}