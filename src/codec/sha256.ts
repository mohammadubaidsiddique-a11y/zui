import { bytesToHex } from "@shared/format";

/**
 * Incremental SHA-256.
 *
 * A pure-TypeScript implementation is always available (web and Node). On
 * Node, a native `node:crypto` adapter can be registered via
 * `registerNativeSha256` for the fast path. The pure implementation is
 * verified against the native one in tests across many inputs.
 */

export interface HashLike {
  update(bytes: Uint8Array): HashLike;
  digest(): Promise<Uint8Array>;
  digestHex(): Promise<string>;
}

type Sha256Factory = () => HashLike;

let nativeFactory: Sha256Factory | undefined;

export function registerNativeSha256(factory?: Sha256Factory): void {
  nativeFactory = factory;
}

export function createSha256(): HashLike {
  if (nativeFactory) return nativeFactory();
  return new PureSha256();
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number): number => ((x >>> n) | (x << (32 - n))) >>> 0;

class PureSha256 implements HashLike {
  private state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private buf = new Uint8Array(64);
  private buflen = 0;
  private totalBytes = 0;

  update(bytes: Uint8Array): this {
    this.totalBytes += bytes.length;
    let offset = 0;
    if (this.buflen > 0) {
      const need = 64 - this.buflen;
      const take = Math.min(need, bytes.length);
      this.buf.set(bytes.subarray(offset, offset + take), this.buflen);
      this.buflen += take;
      offset += take;
      if (this.buflen === 64) {
        this.compress(this.buf);
        this.buflen = 0;
      }
    }
    while (offset + 64 <= bytes.length) {
      this.compress(bytes.subarray(offset, offset + 64));
      offset += 64;
    }
    const rest = bytes.length - offset;
    if (rest > 0) {
      this.buf.set(bytes.subarray(offset), 0);
      this.buflen = rest;
    }
    return this;
  }

  private compress(p: Uint8Array): void {
    const w = new Uint32Array(64);
    for (let i = 0; i < 16; i += 1) {
      const j = i * 4;
      w[i] = ((p[j]! << 24) | (p[j + 1]! << 16) | (p[j + 2]! << 8) | p[j + 3]!) >>> 0;
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = this.state[0]!;
    let b = this.state[1]!;
    let c = this.state[2]!;
    let d = this.state[3]!;
    let e = this.state[4]!;
    let f = this.state[5]!;
    let g = this.state[6]!;
    let h = this.state[7]!;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    this.state[0] = (this.state[0]! + a) >>> 0;
    this.state[1] = (this.state[1]! + b) >>> 0;
    this.state[2] = (this.state[2]! + c) >>> 0;
    this.state[3] = (this.state[3]! + d) >>> 0;
    this.state[4] = (this.state[4]! + e) >>> 0;
    this.state[5] = (this.state[5]! + f) >>> 0;
    this.state[6] = (this.state[6]! + g) >>> 0;
    this.state[7] = (this.state[7]! + h) >>> 0;
  }

  async digest(): Promise<Uint8Array> {
    const bitLen = this.totalBytes * 8;
    const padded = new Uint8Array(((this.buflen + 8 + 63) >> 6) * 64);
    padded.set(this.buf.subarray(0, this.buflen), 0);
    padded[this.buflen] = 0x80;
    const dv = new DataView(padded.buffer);
    dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000), false);
    dv.setUint32(padded.length - 4, bitLen >>> 0, false);
    for (let i = 0; i < padded.length; i += 64) {
      this.compress(padded.subarray(i, i + 64));
    }
    const out = new Uint8Array(32);
    const dvo = new DataView(out.buffer);
    for (let i = 0; i < 8; i += 1) {
      dvo.setUint32(i * 4, this.state[i]!, false);
    }
    return out;
  }

  async digestHex(): Promise<string> {
    return bytesToHex(await this.digest());
  }
}

export async function sha256Of(bytes: Uint8Array): Promise<string> {
  return createSha256().update(bytes).digestHex();
}