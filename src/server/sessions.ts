import type { CompressionMode } from "@codec/compress";
import type { ZuiStorage } from "@server/storage";

export type SessionStatus = "uploading" | "sealed" | "cancelled" | "expired";

export interface SessionChunkState {
  index: number;
  sha256: string;
  storedSize: number;
  uploadedAt: number;
}

export interface SessionMeta {
  fileName: string;
  mimeType: string;
  size: number;
  sha256: string;
  chunkSize: number;
  chunkCount: number;
  compression: CompressionMode;
}

export interface ZuiSession {
  id: string;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  senderTokenHash: string;
  receiverTokenHash: string;
  meta: SessionMeta;
  packageSha256?: string;
  packageSize?: number;
  cancelledAt?: number;
}

/**
 * Chunk state is stored per chunk (atomic single-writer files) so that
 * concurrent chunk uploads never clobber each other's progress records.
 */
export const SESSION_META_KEY = (id: string): string => `sessions/${id}/session.json`;
export const CHUNK_KEY = (id: string, index: number): string => `sessions/${id}/chunks/${index}`;
export const CHUNK_STATE_KEY = (id: string, index: number): string => `sessions/${id}/chunks/${index}.state.json`;
export const PACKAGE_KEY = (id: string): string => `sessions/${id}/package.zui`;
export const SESSION_DIR = (id: string): string => `sessions/${id}`;

export async function loadSession(storage: ZuiStorage, id: string): Promise<ZuiSession | null> {
  return storage.readJson<ZuiSession>(SESSION_META_KEY(id));
}

export async function saveSession(storage: ZuiStorage, session: ZuiSession): Promise<void> {
  session.updatedAt = Date.now();
  await storage.writeJson(SESSION_META_KEY(session.id), session);
}

export async function loadChunkState(storage: ZuiStorage, id: string, index: number): Promise<SessionChunkState | null> {
  return storage.readJson<SessionChunkState>(CHUNK_STATE_KEY(id, index));
}

export async function saveChunkState(storage: ZuiStorage, id: string, state: SessionChunkState): Promise<void> {
  await storage.writeJson(CHUNK_STATE_KEY(id, state.index), state);
}

export async function listChunkStates(storage: ZuiStorage, id: string): Promise<SessionChunkState[]> {
  const keys = await storage.list(`sessions/${id}/chunks/`);
  const out: SessionChunkState[] = [];
  for (const key of keys) {
    const m = key.match(/^sessions\/[0-9a-f]{32}\/chunks\/(\d+)\.state\.json$/);
    if (!m) continue;
    const state = await storage.readJson<SessionChunkState>(key);
    if (state) out.push(state);
  }
  return out.sort((a, b) => a.index - b.index);
}

export function isExpired(session: ZuiSession, now = Date.now()): boolean {
  return session.status !== "cancelled" && session.expiresAt < now;
}

export interface SessionListEntry {
  id: string;
  status: SessionStatus;
  createdAt: number;
  expiresAt: number;
}

export async function listSessions(storage: ZuiStorage): Promise<SessionListEntry[]> {
  const keys = await storage.list("sessions/");
  const ids = new Set<string>();
  for (const key of keys) {
    const match = key.match(/^sessions\/([0-9a-f]{32})\/session\.json$/);
    if (match) ids.add(match[1]!);
  }
  const out: SessionListEntry[] = [];
  for (const id of ids) {
    const session = await loadSession(storage, id);
    if (session) {
      out.push({
        id: session.id,
        status: session.status,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
      });
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}