import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { encodeZui, inspectZui, verifyZui, ZuiDecoder, chunkCountFor } from "@codec/index";
import { minimalPdf, makeZip } from "../util/fixtures";

/** Concatenate byte chunks. */
function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

const sourceFrom = (bytes: Uint8Array) => ({
  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    for (let o = 0; o < bytes.length; o += 256 * 1024) {
      yield bytes.subarray(o, Math.min(o + 256 * 1024, bytes.length));
    }
  },
});

function hasFfmpeg(): boolean {
  const r = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  return r.status === 0;
}

/** Creates a REAL h.264 mp4 via ffmpeg (silence + color test pattern). */
function makeRealMp4(seconds: number, width: number, height: number, bitrateKbps: number): Uint8Array | null {
  const r = spawnSync(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", `testsrc=size=${width}x${height}:rate=24:duration=${seconds}`,
      "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
      "-c:v", "libx264", "-preset", "ultrafast", "-b:v", `${bitrateKbps}k`,
      "-c:a", "aac", "-shortest",
      "-f", "mp4", "-movflags", "+faststart",
      "-",
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  if (r.status !== 0 || !r.stdout || r.stdout.length === 0) return null;
  return new Uint8Array(r.stdout);
}

interface Fixture {
  name: string;
  bytes: Uint8Array;
}

function buildFixtures(): Fixture[] {
  const fixtures: Fixture[] = [
    { name: "hello.txt", bytes: new TextEncoder().encode("Hello, ZUI!\nThis is a plain text file.\n".repeat(200)) },
    { name: "empty.bin", bytes: new Uint8Array(0) },
    { name: "doc.pdf", bytes: minimalPdf() },
    { name: "archive.zip", bytes: makeZip("readme.txt", new TextEncoder().encode("ZUI stores this inside a real ZIP.")) },
    {
      name: "random-6mib.bin",
      bytes: new Uint8Array(randomBytes(6 * 1024 * 1024 + 1234)),
    },
  ];
  if (hasFfmpeg()) {
    const small = makeRealMp4(2, 320, 240, 400);
    if (small) fixtures.push({ name: "small-video.mp4", bytes: small });
    const big = makeRealMp4(30, 640, 480, 1000);
    if (big) fixtures.push({ name: "video-30s.mp4", bytes: big });
    const png = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=64x64:d=0.1", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"], { stdio: ["ignore", "pipe", "pipe"] });
    if (png.status === 0 && png.stdout?.length) fixtures.push({ name: "pixel.png", bytes: new Uint8Array(png.stdout) });
    const jpg = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "gradients=s=128x128:d=0.1", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "2", "-"], { stdio: ["ignore", "pipe", "pipe"] });
    if (jpg.status === 0 && jpg.stdout?.length) fixtures.push({ name: "photo.jpg", bytes: new Uint8Array(jpg.stdout) });
  }
  return fixtures;
}

describe("ZUI codec — real files", () => {
  const fixtures = buildFixtures();
  const chunkSize = 2 * 1024 * 1024;

  it("generated fixtures are real, recognizable files", () => {
    const names = new Set(fixtures.map((f) => f.name));
    expect(names.has("hello.txt")).toBe(true);
    expect(names.has("empty.bin")).toBe(true);
    expect(names.has("doc.pdf")).toBe(true);
    expect(names.has("archive.zip")).toBe(true);
    const pdf = fixtures.find((f) => f.name === "doc.pdf")!;
    expect(new TextDecoder().decode(pdf.bytes.slice(0, 8))).toBe("%PDF-1.4");
    const zip = fixtures.find((f) => f.name === "archive.zip")!;
    expect(zip.bytes[0]).toBe(0x50);
    expect(zip.bytes[1]).toBe(0x4b);
    if (fixtures.some((f) => f.name === "pixel.png")) {
      const png = fixtures.find((f) => f.name === "pixel.png")!;
      expect([png.bytes[0], png.bytes[1], png.bytes[2], png.bytes[3]]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    }
    if (fixtures.some((f) => f.name === "small-video.mp4")) {
      const mp4 = fixtures.find((f) => f.name === "small-video.mp4")!;
      // ISO BMFF ftyp box
      expect(new TextDecoder().decode(mp4.bytes.slice(4, 8))).toBe("ftyp");
    }
  });

  for (const f of fixtures) {
    it(`round-trips ${f.name} (${f.bytes.byteLength} bytes) losslessly`, async () => {
      const origSha = await shaOf(f.bytes);
      const parts: Uint8Array[] = [];
      const meta = await encodeZui(
        () => sourceFrom(f.bytes),
        { fileName: f.name, mimeType: "application/octet-stream", chunkSize },
        { write: (b) => void parts.push(Uint8Array.from(b)) }
      );

      expect(meta.origSize).toBe(f.bytes.byteLength);
      expect(meta.origSha256).toBe(origSha);
      expect(meta.chunkCount).toBe(chunkCountFor(f.bytes.byteLength, chunkSize));
      expect(meta.chunkCount).toBe(meta.chunks.length);

      const container = concat(parts);
      expect(container.byteLength).toBe(meta.containerBytes);

      // inspect
      const inspected = await inspectZui(sourceFrom(container));
      expect(inspected.header.origSha256).toBe(origSha);
      expect(inspected.chunks).toHaveLength(meta.chunkCount);
      expect(inspected.trailerOk).toBe(true);

      // verify
      const v = await verifyZui(sourceFrom(container));
      expect(v.valid).toBe(true);
      expect(v.errors).toEqual([]);
      expect(v.chunksVerified).toBe(meta.chunkCount);

      // reconstruct
      const reconstructed: Uint8Array[] = [];
      const decoder = await ZuiDecoder.open(sourceFrom(container));
      for await (const raw of decoder.reconstruct()) reconstructed.push(raw);
      const got = concat(reconstructed);

      expect(got.byteLength).toBe(f.bytes.byteLength);
      expect(got).toEqual(f.bytes);
      const reconSha = await shaOf(got);
      expect(reconSha).toBe(origSha);
    });
  }

  it("detects a corrupted payload byte in a real container", async () => {
    const pdf = fixtures.find((f) => f.name === "doc.pdf")!;
    const parts: Uint8Array[] = [];
    const meta = await encodeZui(
      () => sourceFrom(pdf.bytes),
      { fileName: pdf.name, mimeType: "application/pdf", chunkSize },
      { write: (b) => void parts.push(Uint8Array.from(b)) }
    );
    const container = concat(parts);
    const bad = Uint8Array.from(container);
    bad[16 + meta.headerBytes + 3] ^= 0x40;
    const v = await verifyZui(sourceFrom(bad));
    expect(v.valid).toBe(false);
    expect(v.errors.length).toBeGreaterThan(0);
  });

  it("rejects a container with a truncated trailer", async () => {
    const f = fixtures.find((x) => x.bytes.byteLength > 0 && x.name !== "empty.bin")!;
    const parts: Uint8Array[] = [];
    await encodeZui(
      () => sourceFrom(f.bytes),
      { fileName: f.name, chunkSize },
      { write: (b) => void parts.push(Uint8Array.from(b)) }
    );
    const container = concat(parts);
    const truncated = container.subarray(0, container.byteLength - 6);
    const v = await verifyZui(sourceFrom(truncated));
    expect(v.valid).toBe(false);
  });
});

async function shaOf(bytes: Uint8Array): Promise<string> {
  const { createSha256 } = await import("@codec/index");
  const hasher = createSha256();
  for (let o = 0; o < bytes.length; o += 256 * 1024) hasher.update(bytes.subarray(o, o + 256 * 1024));
  return hasher.digestHex();
}