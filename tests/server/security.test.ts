import { describe, expect, it } from "vitest";
import { parseRangeHeader } from "@server/transfers";
import { generateToken, hashToken, tokensEqual, hashedTokensEqual, TOKEN_HEX_LENGTH } from "@server/crypto";
import {
  sanitizeFileName,
  validateMimeType,
  validateSha256Hex,
  assertSafeStorageKey,
  validateChunkIndex,
  parseCompressionParam,
  ValidationError,
} from "@server/validate";
import { chunkCountFor } from "@codec/index";

describe("parseRangeHeader", () => {
  it("parses inclusive byte ranges", () => {
    expect(parseRangeHeader("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRangeHeader("bytes=500-", 1000)).toEqual({ start: 500, end: 999 });
    expect(parseRangeHeader("bytes=-200", 1000)).toEqual({ start: 800, end: 999 });
    expect(parseRangeHeader(undefined, 1000)).toBeNull();
    expect(parseRangeHeader("items=0-9", 1000)).toBeNull();
    expect(parseRangeHeader("bytes=abc", 1000)).toBeNull();
  });
});

describe("tokens", () => {
  it("generates strong tokens", () => {
    const t = generateToken();
    expect(t).toHaveLength(TOKEN_HEX_LENGTH);
    const t2 = generateToken();
    expect(t2).not.toBe(t);
  });

  it("compares tokens in constant time", () => {
    expect(tokensEqual("abc", "abc")).toBe(true);
    expect(tokensEqual("abc", "abd")).toBe(false);
    expect(tokensEqual(undefined, "abc")).toBe(false);
  });

  it("compares hashed tokens", () => {
    expect(hashedTokensEqual(hashToken("abc"), hashToken("abc"))).toBe(true);
    expect(hashedTokensEqual(hashToken("abc"), hashToken("abd"))).toBe(false);
    expect(hashedTokensEqual("a", "bb")).toBe(false);
  });
});

describe("validation helpers", () => {
  it("sanitizes filenames", () => {
    expect(sanitizeFileName("report.pdf")).toBe("report.pdf");
    expect(sanitizeFileName("../evil/name.txt")).toBe("evil_name.txt");
    expect(sanitizeFileName("a\u0000b")).toBe("ab");
    expect(sanitizeFileName("..hidden")).toBe("hidden");
    expect(sanitizeFileName("")).toBe("file");
    expect(sanitizeFileName("x".repeat(500)).length).toBeLessThanOrEqual(255);
  });

  it("validates mime types", () => {
    expect(validateMimeType("text/plain")).toBe("text/plain");
    expect(validateMimeType("application/vnd.ms-excel")).toBe("application/vnd.ms-excel");
    expect(() => validateMimeType("bad")).toThrow(ValidationError);
    expect(() => validateMimeType("a/b\r\n")).toThrow(ValidationError);
    expect(() => validateMimeType("plain no slash")).toThrow(ValidationError);
  });

  it("validates sha256 hex", () => {
    expect(validateSha256Hex("a".repeat(64))).toBe("a".repeat(64));
    expect(validateSha256Hex("A".repeat(64))).toBe("a".repeat(64));
    expect(() => validateSha256Hex("a".repeat(63))).toThrow(ValidationError);
    expect(() => validateSha256Hex("zz".repeat(32))).toThrow(ValidationError);
  });

  it("guards storage keys against traversal", () => {
    expect(() => assertSafeStorageKey("sessions/aa/chunks/0")).not.toThrow();
    for (const key of ["../x", "..", "/abs", "a/b/../c", "a\\b", "a b", "a\u0000b"]) {
      expect(() => assertSafeStorageKey(key)).toThrow(ValidationError);
    }
  });

  it("parses chunk indices", () => {
    expect(validateChunkIndex("0")).toBe(0);
    expect(validateChunkIndex("42")).toBe(42);
    expect(() => validateChunkIndex("-1")).toThrow(ValidationError);
    expect(() => validateChunkIndex("abc")).toThrow(ValidationError);
    expect(() => validateChunkIndex("1e9")).toThrow(ValidationError);
  });

  it("parses compression mode safely", () => {
    expect(parseCompressionParam(undefined)).toBe("none");
    expect(parseCompressionParam("deflate-raw")).toBe("deflate-raw");
    expect(() => parseCompressionParam("zip")).toThrow(ValidationError);
  });

  it("chunk planning helper agrees with the transfer contract", () => {
    expect(chunkCountFor(0, 1024)).toBe(0);
    expect(chunkCountFor(1024, 1024)).toBe(1);
    expect(chunkCountFor(1025, 1024)).toBe(2);
  });
});