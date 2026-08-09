export class ZuiCodecError extends Error {}

export class InvalidMagicError extends ZuiCodecError {
  constructor(got: Uint8Array) {
    const hex = Array.from(got)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ");
    super(`not a ZUI file: magic mismatch (got ${hex})`);
    this.name = "InvalidMagicError";
  }
}

export class UnsupportedVersionError extends ZuiCodecError {
  constructor(version: number) {
    super(`Unsupported ZUI format version ${version}; this implementation supports v1`);
    this.name = "UnsupportedVersionError";
  }
}

export class HeaderCorruptError extends ZuiCodecError {
  constructor(message: string) {
    super(`corrupt ZUI header: ${message}`);
    this.name = "HeaderCorruptError";
  }
}

export class ChunkIntegrityError extends ZuiCodecError {
  constructor(index: number, expected: string, got: string) {
    super(`chunk ${index} failed SHA-256 verification (expected ${expected}, got ${got})`);
    this.name = "ChunkIntegrityError";
  }
}

export class ContainerIntegrityError extends ZuiCodecError {
  constructor(message: string) {
    super(`container integrity check failed: ${message}`);
    this.name = "ContainerIntegrityError";
  }
}

export class OriginalIntegrityError extends ZuiCodecError {
  constructor(expected: string, got: string) {
    super(`reconstructed original failed SHA-256 verification (expected ${expected}, got ${got})`);
    this.name = "OriginalIntegrityError";
  }
}

export class SourceReopenError extends ZuiCodecError {
  constructor(cause: unknown) {
    super(`failed to reopen source for a second pass: ${String(cause)}`);
    this.name = "SourceReopenError";
  }
}