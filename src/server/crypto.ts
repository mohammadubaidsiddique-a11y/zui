import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const TOKEN_BYTES = 32;
export const TOKEN_HEX_LENGTH = TOKEN_BYTES * 2;

/** Generates a cryptographically random opaque token (hex). */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("hex");
}

/** One-way hashes a token for at-rest storage (SHA-256). */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Constant-time comparison of two hex tokens.
 * Both are hashed first so lengths are identical (defeats length leaks).
 */
export function tokensEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const ah = createHash("sha256").update(a, "utf8").digest();
  const bh = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ah, bh);
}

/** Constant-time comparison of two already-hashed token digests (hex). */
export function hashedTokensEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

export function newSessionId(): string {
  return randomBytes(16).toString("hex");
}