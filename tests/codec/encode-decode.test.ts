import { describe, expect, it, beforeAll } from "vitest";
import { registerNodeCodecAdapters } from "@codec/node-adapters";
import { encodeZui, verifyZui, verifyZuiOrThrow, ZuiDecoder, inspectZui, sha256Of } from "@codec/index";
import { concatParts, type ByteSource, type ByteSink } from "@codec/streams";

beforeAll(() => registerNodeCodecAdapters());

const randomBytes = (n: number): Uint8Array => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) b[i] = (Math.random() * 256) | 0;
  return b;
};

interface EncodeFixture {
  source: Uint8Array;
  container: Uint8Array;
  meta: Awaited<ReturnType<typeof encodeZui>>;
}

async function encode(source: Uint8Array, opts: Partial<Parameters<typeof encodeZui>[1]> = {}): Promise<EncodeFixture> {
  const parts: Uint8Array[] = [];
  const sink: ByteSink = { write: (b) => void parts.push(Uint8Array.from(b)) };
  const meta = await encodeZui(
    () => [source],
    { fileName: "test.bin", mimeType: "application/octet-stream", chunkSize: 64 * 1024, ...opts },
    sink
  );
  return { source, container: concatParts(parts), meta };
}

const toSource = (b: Uint8Array): ByteSource =>
  (async function* () {
    yield b;
  })();

describe("encodeZui", () => {
  it("encodes an empty file", async () => {
    const { container, meta } = await encode(new Uint8Array(0));
    expect(meta.chunkCount).toBe(0);
    expect(meta.origSize).toBe(0);
    const v = await verifyZui(toSource(container));
    expect(v.valid).toBe(true);
  });

  it("encodes a tiny file into one chunk", async () => {
    const src = new TextEncoder().encode("hello zui");
    const { container, meta } = await encode(src);
    expect(meta.chunkCount).toBe(1);
    expect(meta.origSize).toBe(src.byteLength);
    const v = await verifyZui(toSource(container));
    expect(v.valid).toBe(true);
  });

  it("is deterministic: identical input produces identical container bytes", async () => {
    const src = randomBytes(300_000);
    const a = await encode(src);
    const b = await encode(src);
    expect(a.container).toEqual(b.container);
    expect(a.meta.containerSha256).toBe(b.meta.containerSha256);
  });

  it("splits multi-chunk input at exactly chunkSize boundaries", async () => {
    const src = randomBytes(64 * 1024 * 3 + 1234);
    const { container, meta } = await encode(src);
    expect(meta.chunkCount).toBe(4);
    expect(meta.origSize).toBe(src.byteLength);
    const v = await verifyZui(toSource(container));
    expect(v.valid).toBe(true);
    expect(v.containerBytes).toBe(container.byteLength);
  });

  it("handles inputs that are exact multiples of chunkSize", async () => {
    const src = randomBytes(64 * 1024 * 2);
    const { container, meta } = await encode(src);
    expect(meta.chunkCount).toBe(2);
    expect(meta.origSize).toBe(src.byteLength);
    await expect(verifyZuiOrThrow(toSource(container))).resolves.toMatchObject({ valid: true });
  });

  it("streams from a fragmented source (tiny parts)", async () => {
    const src = randomBytes(200_000);
    const parts: Uint8Array[] = [];
    const meta = await encodeZui(
      (async function* () {
        for (let i = 0; i < src.length; i += 3) yield src.subarray(i, i + 3);
      }) as never,
      { fileName: "frag.bin", chunkSize: 1024 * 1024 },
      { write: (b) => void parts.push(Uint8Array.from(b)) }
    );
    const container = concatParts(parts);
    const v = await verifyZui(toSource(container));
    expect(v.valid).toBe(true);
    expect(meta.origSize).toBe(src.byteLength);
  });

  it("records expected header metadata", async () => {
    const src = randomBytes(100_000);
    const { meta } = await encode(src, { fileName: "video.mp4", mimeType: "video/mp4" });
    expect(meta.fileName).toBe("video.mp4");
    expect(meta.mimeType).toBe("video/mp4");
    expect(meta.format).toBe("zui");
    expect(meta.chunkSize).toBe(64 * 1024);
    expect(meta.headerBytes).toBeGreaterThan(0);
    expect(meta.payloadBytes + meta.trailerBytes).toBeLessThan(meta.containerBytes);
  });

  it("stores the original SHA-256 in the header", async () => {
    const src = randomBytes(250_000);
    const { meta } = await encode(src);
    const expected = await sha256Of(src);
    expect(meta.origSha256).toBe(expected);
  });
});

describe("decode / reconstruct", () => {
  it("reconstructs byte-for-byte and verifies", async () => {
    for (const size of [0, 1, 1024, 64 * 1024 - 1, 64 * 1024, 64 * 1024 + 1, 1_000_000, 3 * 64 * 1024]) {
      const src = randomBytes(size);
      const { container } = await encode(src);
      const decoder = await ZuiDecoder.open(toSource(container));
      const chunks: Uint8Array[] = [];
      for await (const chunk of decoder.reconstruct()) chunks.push(chunk);
      const rebuilt = concatParts(chunks);
      expect(rebuilt.byteLength).toBe(src.byteLength);
      expect(rebuilt).toEqual(src);
    }
  });

  it("reconstruction throws on corrupted payload bytes", async () => {
    const src = randomBytes(200_000);
    const { container, meta } = await encode(src);
    const corrupt = Uint8Array.from(container);
    corrupt[meta.headerBytes + 100] ^= 0xff;
    const v = await verifyZui(toSource(corrupt));
    expect(v.valid).toBe(false);
    expect(v.errors.length).toBeGreaterThan(0);
  });

  it("rejects non-ZUI magic bytes", async () => {
    const junk = new Uint8Array(128).fill(0xab);
    const v = await verifyZui(toSource(junk));
    expect(v.valid).toBe(false);
    expect(v.errors.some((e) => e.includes("magic"))).toBe(true);
  });

  it("rejects truncated containers", async () => {
    const src = randomBytes(200_000);
    const { container } = await encode(src);
    for (const cut of [10, 100, container.byteLength - 5]) {
      const v = await verifyZui(toSource(container.subarray(0, cut)));
      expect(v.valid).toBe(false);
    }
  });

  it("rejects trailing garbage after the trailer", async () => {
    const src = randomBytes(100_000);
    const { container } = await encode(src);
    const padded = concatParts([container, new Uint8Array([1, 2, 3, 4])]);
    const v = await verifyZui(toSource(padded));
    expect(v.valid).toBe(false);
  });

  it("detects a tampered trailer hash", async () => {
    const src = randomBytes(100_000);
    const { container, meta } = await encode(src);
    const corrupt = Uint8Array.from(container);
    const trailerStart = meta.headerBytes + meta.payloadBytes + meta.chunkCount * 4;
    const firstEntry = trailerStart + 4;
    corrupt[firstEntry + 8] ^= 0xff; // first byte of first chunk sha
    const v = await verifyZui(toSource(corrupt));
    expect(v.valid).toBe(false);
    expect(v.errors.some((e) => e.includes("trailer"))).toBe(true);
  });

  it("detects a tampered original-size in the header", async () => {
    const src = randomBytes(100_000);
    const { container } = await encode(src);
    const corrupt = Uint8Array.from(container);
    // origSize is the 8 bytes after chunkSize+chunkCount (12..19 within header block)
    const dv = new DataView(corrupt.buffer, 16 + 8, 8);
    dv.setBigUint64(0, BigInt(9999999), false);
    const v = await verifyZui(toSource(corrupt));
    expect(v.valid).toBe(false);
  });
});

describe("inspectZui", () => {
  it("returns header and chunk table", async () => {
    const src = randomBytes(150_000);
    const { container, meta } = await encode(src);
    const insp = await inspectZui(toSource(container));
    expect(insp.header.fileName).toBe("test.bin");
    expect(insp.header.chunkCount).toBe(meta.chunkCount);
    expect(insp.chunks).toHaveLength(meta.chunkCount);
    expect(insp.trailerOk).toBe(true);
    expect(insp.containerBytes).toBe(container.byteLength);
    expect(insp.chunks[0]).toMatchObject({ index: 0, storedSize: 64 * 1024, rawSize: 64 * 1024 });
  });
});

describe("verifyZui", () => {
  it("returns an ok report for a valid container", async () => {
    const src = randomBytes(500_000);
    const { container } = await encode(src);
    const v = await verifyZui(toSource(container));
    expect(v.valid).toBe(true);
    expect(v.chunksVerified).toBe(8);
    expect(v.trailerOk).toBe(true);
    expect(v.origHashOk).toBe(true);
    expect(v.origSize).toBe(src.byteLength);
  });
});