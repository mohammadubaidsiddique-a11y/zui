import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { registerNodeCodecAdapters } from "@codec/node-adapters";
import { createHash } from "node:crypto";
import { createSha256, registerNativeSha256 } from "@codec/sha256";
import { bytesToHex } from "@shared/format";

beforeAll(() => registerNodeCodecAdapters());

describe("pure SHA-256 implementation", () => {
  beforeAll(() => registerNativeSha256(undefined));
  afterAll(() => registerNodeCodecAdapters());

  const cases: Array<[string, Uint8Array]> = [
    ["empty", new Uint8Array(0)],
    ["abc", new TextEncoder().encode("abc")],
    ["hello world", new TextEncoder().encode("hello world")],
    ["1 byte", Uint8Array.of(0x42)],
    ["63 bytes", new Uint8Array(63).fill(7)],
    ["64 bytes", new Uint8Array(64).fill(9)],
    ["65 bytes", new Uint8Array(65).fill(11)],
    ["127 bytes", new Uint8Array(127).fill(13)],
    ["1 KiB", new Uint8Array(1024).fill(3)],
    ["1 MiB random", (() => { const b = new Uint8Array(1024 * 1024); for (let i = 0; i < b.length; i += 1) b[i] = (i * 31 + 7) & 0xff; return b; })()],
  ];

  it.each(cases)("matches node:crypto for %s", async (_name, input) => {
    const pure = createSha256().update(input);
    const expected = bytesToHex(new Uint8Array(createHash("sha256").update(Buffer.from(input)).digest()));
    expect(await pure.digestHex()).toBe(expected);
  });

  it("supports incremental updates across arbitrary boundaries", async () => {
    const input = new TextEncoder().encode("incremental streaming hash boundary test 1234567890");
    const h = createSha256();
    // feed one byte at a time
    for (let i = 0; i < input.length; i += 1) h.update(input.subarray(i, i + 1));
    const expected = bytesToHex(new Uint8Array(createHash("sha256").update(Buffer.from(input)).digest()));
    expect(await h.digestHex()).toBe(expected);
  });

  it("matches native adapter output for larger inputs", async () => {
    const input = new Uint8Array(5 * 1024 * 1024);
    for (let i = 0; i < input.length; i += 1) input[i] = (i * 7 + 3) & 0xff;
    const pure = await createSha256().update(input).digestHex();
    registerNodeCodecAdapters();
    const native = await createSha256().update(input).digestHex();
    expect(pure).toBe(native);
    registerNativeSha256(undefined);
  });
});