import { Readable, PassThrough } from "node:stream";
import type { ZuiServerConfig } from "@server/config";
import { generateToken, hashToken, hashedTokensEqual, newSessionId } from "@server/crypto";
import {
  parseCompressionParam,
  sanitizeFileName,
  validateChunkSizeParam,
  validateMimeType,
  validateSessionSize,
  validateSha256Hex,
} from "@server/validate";
import {
  chunkCountFor,
  rawSizeAt,
  encodeZui,
  verifyZui,
  createSha256,
  nodeStreamToSource,
} from "@codec/index";
import { ZUI_DEFAULT_CHUNK_SIZE } from "@shared/format";
import type { CompressionMode } from "@codec/compress";
import {
  loadSession,
  saveSession,
  SESSION_DIR,
  SESSION_META_KEY,
  CHUNK_KEY,
  CHUNK_STATE_KEY,
  PACKAGE_KEY,
  isExpired,
  listSessions,
  loadChunkState,
  saveChunkState,
  type SessionStatus,
  type ZuiSession,
} from "./sessions";
import { StorageError, type ZuiStorage } from "./storage";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const bad = (message: string, code = "bad_request"): ApiError => new ApiError(message, 400, code);
const unauthorized = (message = "unauthorized"): ApiError => new ApiError(message, 401, "unauthorized");
const notFound = (message: string): ApiError => new ApiError(message, 404, "not_found");
const conflict = (message: string, code: string): ApiError => new ApiError(message, 409, code);
const tooLarge = (message: string): ApiError => new ApiError(message, 413, "payload_too_large");
const gone = (message: string): ApiError => new ApiError(message, 410, "gone");

export interface CreateSessionInput {
  fileName: string;
  mimeType?: string;
  size: number;
  sha256: string;
  chunkSize?: number;
  compression?: string;
}

export interface CreateSessionOutput {
  id: string;
  status: SessionStatus;
  expiresAt: number;
  chunkSize: number;
  chunkCount: number;
  senderToken: string;
  receiverToken: string;
  sharePath: string;
}

export interface TransferService {
  createSession(input: CreateSessionInput): Promise<CreateSessionOutput>;
  getSession(id: string, token: string, role: "sender" | "receiver"): Promise<ZuiSession>;
  uploadChunk(
    id: string,
    index: number,
    token: string,
    body: NodeJS.ReadableStream,
    contentLength: number,
    declaredSha256: string
  ): Promise<{ index: number; sha256: string; storedSize: number; resume: boolean }>;
  downloadChunk(id: string, index: number, token: string, role: "sender" | "receiver"): Promise<{ stream: Readable; size: number; sha256: string }>;
  verifySession(id: string, token: string): Promise<VerifyReport>;
  finalizeSession(id: string, token: string): Promise<{ packageSize: number; packageSha256: string; chunkCount: number }>;
  cancelSession(id: string, token: string): Promise<void>;
  deleteSession(id: string, token: string | undefined): Promise<void>;
  packageStream(id: string, token: string, range?: { start: number; end: number }): Promise<{
    stream: Readable;
    size: number;
    sha256: string;
    range: { start: number; end: number } | null;
  }>;
  packageInfo(id: string, token: string): Promise<{ size: number; sha256: string; status: SessionStatus }>;
  sweepExpired(now?: number): Promise<number>;
}

export interface VerifyReport {
  sessionId: string;
  status: SessionStatus;
  expectedChunks: number;
  present: number;
  verified: number;
  mismatches: Array<{ index: number; expected: string; got: string }>;
  missing: number[];
  ok: boolean;
  packageVerified?: boolean;
}

export function createTransferService(storage: ZuiStorage, config: ZuiServerConfig): TransferService {
  const requireSender = (session: ZuiSession, token: string): void => {
    if (!hashedTokensEqual(session.senderTokenHash, hashToken(token))) throw unauthorized();
  };
  const requireReceiver = (session: ZuiSession, token: string): void => {
    if (!hashedTokensEqual(session.receiverTokenHash, hashToken(token))) throw unauthorized();
  };
  const requireRole = (session: ZuiSession, token: string, role: "sender" | "receiver"): void => {
    if (role === "sender") requireSender(session, token);
    else requireReceiver(session, token);
  };

  const assertActive = (session: ZuiSession): void => {
    if (isExpired(session)) {
      session.status = "expired";
      throw gone("session has expired");
    }
    if (session.status === "cancelled") throw gone("session was cancelled");
    if (session.status === "sealed" ) throw conflict("session already finalized", "already_sealed");
  };

  const assertUploadable = (session: ZuiSession): void => {
    assertActive(session);
    if (session.status === "sealed") throw conflict("session already finalized", "already_sealed");
    if (session.status !== "uploading") throw conflict(`session in state ${session.status} cannot accept chunks`, "state_conflict");
  };

  return {
    async createSession(input: CreateSessionInput): Promise<CreateSessionOutput> {
      if (typeof input?.fileName !== "string" || input.fileName.trim().length === 0) {
        throw bad("fileName is required");
      }
      const size = validateSessionSize(input.size, config.maxSessionBytes);
      const origSha = validateSha256Hex(input.sha256);
      const mimeType = validateMimeType(input.mimeType ?? "application/octet-stream");
      const fileName = sanitizeFileName(input.fileName);
      const defaultChunk = Math.min(ZUI_DEFAULT_CHUNK_SIZE, config.maxChunkBytes);
      const chunkSize = validateChunkSizeParam(input.chunkSize ?? defaultChunk, config.maxChunkBytes);
      const compression: CompressionMode = parseCompressionParam(input.compression);
      if (compression === "deflate-raw" && typeof (globalThis as { CompressionStream?: unknown }).CompressionStream === "undefined") {
        throw bad("deflate-raw is not supported by this server", "unsupported_compression");
      }
      const chunkCount = chunkCountFor(size, chunkSize);
      const now = Date.now();
      const id = newSessionId();
      const senderToken = generateToken();
      const receiverToken = generateToken();
      const session: ZuiSession = {
        id,
        status: "uploading",
        createdAt: now,
        updatedAt: now,
        expiresAt: now + config.sessionTtlMs,
        senderTokenHash: hashToken(senderToken),
        receiverTokenHash: hashToken(receiverToken),
        meta: { fileName, mimeType, size, sha256: origSha, chunkSize, chunkCount, compression },
      };
      await saveSession(storage, session);
      return {
        id,
        status: "uploading",
        expiresAt: session.expiresAt,
        chunkSize,
        chunkCount,
        senderToken,
        receiverToken,
        sharePath: `/receiver?zui=${id}.${receiverToken}`,
      };
    },

    async getSession(id: string, token: string, role: "sender" | "receiver"): Promise<ZuiSession> {
      const session = await loadSession(storage, id);
      if (!session) throw notFound(`session ${id} not found`);
      requireRole(session, token, role);
      if (isExpired(session)) {
        session.status = "expired";
        await saveSession(storage, session);
        throw gone("session has expired");
      }
      return session;
    },

    async uploadChunk(id, index, token, body, contentLength, declaredSha256): Promise<{ index: number; sha256: string; storedSize: number; resume: boolean }> {
      const session = await loadSession(storage, id);
      if (!session) throw notFound(`session ${id} not found`);
      requireSender(session, token);
      assertUploadable(session);
      if (index < 0 || index >= session.meta.chunkCount) {
        throw bad(`chunk index ${index} out of range (0..${session.meta.chunkCount - 1})`, "chunk_out_of_range");
      }
      const expectedSha = validateSha256Hex(declaredSha256);
      if (contentLength > config.maxChunkBytes) {
        throw tooLarge(`chunk exceeds maximum size ${config.maxChunkBytes}`);
      }
      const expectedRaw = rawSizeAt(session.meta.size, session.meta.chunkSize, index, session.meta.chunkCount);
      if (session.meta.compression === "none" && contentLength !== expectedRaw) {
        throw bad(`chunk ${index} size ${contentLength} does not match expected ${expectedRaw}`, "chunk_size_mismatch");
      }

      const existing = await loadChunkState(storage, id, index);
      if (existing && existing.sha256 === expectedSha) {
        return { index, sha256: existing.sha256, storedSize: existing.storedSize, resume: true };
      }

      try {
        const result = await storage.put(CHUNK_KEY(id, index), body, { expectedSha256: expectedSha });
        const sha256 = result.sha256 ?? expectedSha;
        await saveChunkState(storage, id, { index, sha256, storedSize: result.size, uploadedAt: Date.now() });
        return { index, sha256, storedSize: result.size, resume: false };
      } catch (err) {
        if (err instanceof StorageError && err.code === "corrupt") {
          await storage.delete(CHUNK_KEY(id, index)).catch(() => undefined);
          await storage.delete(CHUNK_STATE_KEY(id, index)).catch(() => undefined);
          throw conflict(`chunk ${index} failed SHA-256 verification`, "chunk_hash_mismatch");
        }
        throw err;
      }
    },

    async downloadChunk(id, index, token, role): Promise<{ stream: Readable; size: number; sha256: string }> {
      const session = await loadSession(storage, id);
      if (!session) throw notFound(`session ${id} not found`);
      requireRole(session, token, role);
      if (isExpired(session)) throw gone("session has expired");
      if (index < 0 || index >= session.meta.chunkCount) throw bad("chunk index out of range");
      const entry = await loadChunkState(storage, id, index);
      if (!entry) throw notFound(`chunk ${index} not yet uploaded`);
      const obj = await storage.get(CHUNK_KEY(id, index));
      return { stream: obj.stream, size: obj.size, sha256: entry.sha256 };
    },

    async verifySession(id, token): Promise<VerifyReport> {
      const session = await loadSession(storage, id);
      if (!session) throw notFound(`session ${id} not found`);
      requireSender(session, token);
      if (isExpired(session)) throw gone("session has expired");
      const report: VerifyReport = {
        sessionId: id,
        status: session.status,
        expectedChunks: session.meta.chunkCount,
        present: 0,
        verified: 0,
        mismatches: [],
        missing: [],
        ok: false,
      };
      for (let i = 0; i < session.meta.chunkCount; i += 1) {
        const entry = await loadChunkState(storage, id, i);
        if (!entry) {
          report.missing.push(i);
          continue;
        }
        report.present += 1;
        try {
          const obj = await storage.get(CHUNK_KEY(id, i));
          const hasher = createSha256();
          for await (const chunk of nodeStreamToSource(obj.stream)) hasher.update(chunk);
          const got = await hasher.digestHex();
          if (got === entry.sha256) {
            report.verified += 1;
          } else {
            report.mismatches.push({ index: i, expected: entry.sha256, got });
          }
        } catch {
          report.missing.push(i);
        }
      }
      report.ok = report.verified === report.expectedChunks && report.missing.length === 0 && report.mismatches.length === 0;
      if (report.ok && session.status === "sealed") {
        try {
          const obj = await storage.get(PACKAGE_KEY(id));
          const v = await verifyZui(nodeStreamToSource(obj.stream));
          report.packageVerified = v.valid && (v.origSize === session.meta.size && v.origSha256 === session.meta.sha256);
        } catch {
          report.packageVerified = false;
        }
      }
      return report;
    },

    async finalizeSession(id, token): Promise<{ packageSize: number; packageSha256: string; chunkCount: number }> {
      const session = await loadSession(storage, id);
      if (!session) throw notFound(`session ${id} not found`);
      requireSender(session, token);
      assertActive(session);
      if (session.status !== "uploading") throw conflict("session already finalized", "already_sealed");

      // Re-verify every stored chunk against its recorded hash (server-side).
      const report = await this.verifySession(id, token);
      if (!report.ok) {
        throw conflict(
          `cannot finalize: ${report.missing.length} missing, ${report.mismatches.length} mismatched chunk(s)`,
          "integrity_failure"
        );
      }

      const pt = new PassThrough();
      const openSource = async () => {
        return (async function* () {
          for (let i = 0; i < session.meta.chunkCount; i += 1) {
            const obj = await storage.get(CHUNK_KEY(id, i));
            for await (const chunk of nodeStreamToSource(obj.stream)) yield chunk;
          }
        })();
      };
      const sink = {
        write: (b: Uint8Array): Promise<void> =>
          new Promise<void>((resolve, reject) => {
            if (pt.write(Buffer.from(b.buffer, b.byteOffset, b.byteLength))) {
              resolve();
              return;
            }
            pt.once("drain", () => resolve());
            pt.once("error", reject);
          }),
      };

      const encodePromise = encodeZui(
        openSource,
        {
          fileName: session.meta.fileName,
          mimeType: session.meta.mimeType,
          chunkSize: session.meta.chunkSize,
          compression: session.meta.compression,
        },
        sink
      ).catch((err: unknown) => {
        pt.destroy(err as Error);
        throw err;
      });
      const putPromise = storage.put(PACKAGE_KEY(id), pt);
      await encodePromise;
      pt.end();
      await putPromise;

      const stat = await storage.stat(PACKAGE_KEY(id));
      session.status = "sealed";
      session.packageSize = stat.size;
      const obj = await storage.get(PACKAGE_KEY(id));
      const hasher = createSha256();
      for await (const chunk of nodeStreamToSource(obj.stream)) hasher.update(chunk);
      session.packageSha256 = await hasher.digestHex();
      await saveSession(storage, session);
      return { packageSize: stat.size, packageSha256: session.packageSha256, chunkCount: session.meta.chunkCount };
    },

    async cancelSession(id, token): Promise<void> {
      const session = await loadSession(storage, id);
      if (!session) throw notFound(`session ${id} not found`);
      requireSender(session, token);
      if (session.status === "cancelled" || session.status === "expired") return;
      session.status = "cancelled";
      session.cancelledAt = Date.now();
      await saveSession(storage, session);
      await deleteSessionObjects(storage, id);
    },

    async deleteSession(id, token): Promise<void> {
      const session = await loadSession(storage, id);
      if (!session) throw notFound(`session ${id} not found`);
      if (token !== undefined) {
        // optional admin token or any role token
        if (!hashedTokensEqual(session.senderTokenHash, hashToken(token)) && !hashedTokensEqual(session.receiverTokenHash, hashToken(token))) {
          throw unauthorized();
        }
      }
      await deleteSessionObjects(storage, id);
      await storage.delete(SESSION_META_KEY(id));
    },

    async packageStream(id, token, range) {
      const session = await loadSession(storage, id);
      if (!session) throw notFound(`session ${id} not found`);
      requireReceiver(session, token);
      if (isExpired(session)) throw gone("session has expired");
      if (session.status !== "sealed" || !session.packageSha256 || !session.packageSize) {
        throw conflict("package is not ready yet", "package_not_ready");
      }
      if (range) {
        const end = Math.min(range.end, session.packageSize - 1);
        const start = Math.min(range.start, end);
        const stream = await storage.range(PACKAGE_KEY(id), start, end);
        return { stream, size: session.packageSize, sha256: session.packageSha256, range: { start, end } };
      }
      const obj = await storage.get(PACKAGE_KEY(id));
      return { stream: obj.stream, size: session.packageSize, sha256: session.packageSha256, range: null };
    },

    async packageInfo(id, token): Promise<{ size: number; sha256: string; status: SessionStatus }> {
      const session = await loadSession(storage, id);
      if (!session) throw notFound(`session ${id} not found`);
      requireReceiver(session, token);
      if (isExpired(session)) throw gone("session has expired");
      if (session.status !== "sealed" || !session.packageSha256 || !session.packageSize) {
        throw conflict("package is not ready yet", "package_not_ready");
      }
      return { size: session.packageSize, sha256: session.packageSha256, status: session.status };
    },

    async sweepExpired(now = Date.now()): Promise<number> {
      const entries = await listSessions(storage);
      let removed = 0;
      for (const entry of entries) {
        if (entry.status !== "cancelled" && entry.expiresAt < now) {
          await deleteSessionObjects(storage, entry.id);
          await storage.delete(SESSION_META_KEY(entry.id));
          removed += 1;
        }
      }
      return removed;
    },
  };
}

async function deleteSessionObjects(storage: ZuiStorage, id: string): Promise<void> {
  const keys = await storage.list(SESSION_DIR(id));
  for (const key of keys) {
    await storage.delete(key);
  }
}

export function parseRangeHeader(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const m = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return null;
  const start = m[1] === "" ? undefined : Number(m[1]);
  const end = m[2] === "" ? undefined : Number(m[2]);
  if (start === undefined && end === undefined) return null;
  if (end === undefined) {
    if (start === undefined) return null;
    return { start, end: size - 1 };
  }
  if (start === undefined) {
    return { start: Math.max(0, size - end), end: size - 1 };
  }
  return { start, end };
}