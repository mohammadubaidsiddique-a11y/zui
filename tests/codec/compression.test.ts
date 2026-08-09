import { describe, expect, it, beforeAll } from "vitest";
import { registerNodeCodecAdapters } from "@codec/node-adapters";
import { encodeZui, verifyZui, ZuiDecoder, decompressChunk, compressChunk, chunkCountFor, rawSizeAt, chunkStartByte, probeCompressible } from "@codec/index";
import { randomBytes } from "node:crypto";
import { concatParts, type ByteSource } from "@codec/streams";

beforeAll(() => registerNodeCodecAdapters());

const toSource = (b: Uint8Array): ByteSource =>
  (async function* () {
    yield b;
  })();

const compressible = (n: number): Uint8Array => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) b[i] = (i % 37) + 65;
  return b;
};

describe("deflate-raw compression", () => {
  it("round-trips compressed containers with real (not fake) compression", async () => {
    const src = compressible(2 * 1024 * 1024 + 4096);
    const parts: Uint8Array[] = [];
    const meta = await encodeZui(
      () => [src],
      { fileName: "log.txt", mimeType: "text/plain", chunkSize: 1024 * 1024, compression: "deflate-raw" },
      { write: (b) => void parts.push(Uint8Array.from(b)) }
    );
    expect(meta.compression).toBe("deflate-raw");
    // Real compression must shrink a compressible stream measurably.
    expect(meta.payloadBytes).toBeLessThan(src.byteLength / 3);

    const container = concatParts(parts);
    const decoder = await ZuiDecoder.open(toSource(container));
    expect(decoder.header.compression).toBe("deflate-raw");
    const out: Uint8Array[] = [];
    for await (const chunk of decoder.reconstruct()) out.push(chunk);
    expect(concatParts(out)).toEqual(src);

    const v = await verifyZui(toSource(container));
    expect(v.valid).toBe(true);
    expect(v.compression).toBe("deflate-raw");
  });

  it("does not expand incompressible data more than a sane bound", async () => {
    const src = randomBytes(300_000);
    const parts: Uint8Array[] = [];
    const meta = await encodeZui(
      () => [src],
      { fileName: "r.bin", chunkSize: 64 * 1024, compression: "deflate-raw" },
      { write: (b) => void parts.push(Uint8Array.from(b)) }
    );
    expect(meta.payloadBytes).toBeGreaterThan(290_000);
    expect(meta.payloadBytes).toBeLessThan(310_000);
  });

  it("decompresses to the exact original bytes (deterministic)", async () => {
    const src = compressible(500_000);
    const parts: Uint8Array[] = [];
    await encodeZui(
      () => [src],
      { fileName: "x.txt", chunkSize: 64 * 1024, compression: "deflate-raw" },
      { write: (b) => void parts.push(Uint8Array.from(b)) }
    );
    const container = concatParts(parts);
    const decoder = await ZuiDecoder.open(toSource(container));
    const rebuilt: Uint8Array[] = [];
    for await (const chunk of decoder.reconstruct()) rebuilt.push(chunk);
    expect(concatParts(rebuilt)).toEqual(src);
  });

  it("probes compressibility so already-compressed media skips deflate", () => {
    const text = new TextEncoder().encode("the quick brown fox jumps over the lazy dog ".repeat(200));
    expect(probeCompressible(text)).toBe(true);
    const random = randomBytes(4096);
    expect(probeCompressible(random)).toBe(false);
    const empty = new Uint8Array(0);
    expect(probeCompressible(empty)).toBe(true);
  });

  it("exposes compress/decompress helpers", async () => {
    const raw = new TextEncoder().encode("deflate raw helper test ".repeat(100));
    const stored = await compressChunk("deflate-raw", raw);
    expect(stored.byteLength).toBeLessThan(raw.byteLength);
    const restored = await decompressChunk("deflate-raw", stored);
    expect(new Uint8Array(restored)).toEqual(raw);
  });
});

describe("chunk planning", () => {
  it("computes chunk counts correctly", () => {
    expect(chunkCountFor(0, 1024)).toBe(0);
    expect(chunkCountFor(1, 1024)).toBe(1);
    expect(chunkCountFor(1024, 1024)).toBe(1);
    expect(chunkCountFor(1025, 1024)).toBe(2);
    expect(chunkCountFor(2048, 1024)).toBe(2);
    expect(chunkCountFor(2049, 1024)).toBe(3);
  });

  it("computes raw sizes at each index", () => {
    const count = chunkCountFor(2500, 1024);
    expect(count).toBe(3);
    expect(rawSizeAt(2500, 1024, 0, count)).toBe(1024);
    expect(rawSizeAt(2500, 1024, 1, count)).toBe(1024);
    expect(rawSizeAt(2500, 1024, 2, count)).toBe(452);
    expect(() => rawSizeAt(2500, 1024, 3, count)).toThrow();
  });

  it("computes start offsets", () => {
    expect(chunkStartByte(1000, 64, 3)).toBe(192);
  });
});