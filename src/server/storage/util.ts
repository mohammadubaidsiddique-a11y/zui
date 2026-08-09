import { Transform } from "node:stream";
import { createHash } from "node:crypto";
import { bytesToHex } from "@shared/format";

/** Transform that counts bytes and computes SHA-256 while data flows through. */
export function createHashingTransform() {
  const hasher = createHash("sha256");
  let size = 0;
  const transform = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      hasher.update(chunk);
      cb(null, chunk);
    },
  });
  const sha256 = () => Promise.resolve(bytesToHex(new Uint8Array(hasher.digest())));
  return { transform, size: () => size, sha256 };
}

/** Collects a whole stream into a Buffer (small objects only). */
export async function collectStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}