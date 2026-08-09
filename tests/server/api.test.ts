import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { registerNodeCodecAdapters } from "@codec/node-adapters";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type ZuiServerConfig } from "@server/config";
import { createLogger } from "@server/logger";
import { createStorage, type ZuiStorage } from "@server/storage";
import { createTransferService, type TransferService } from "@server/transfers";
import { createApp } from "@server/app";
import type { Server } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { ZuiDecoder, webStreamToSource } from "@codec/index";
import { concatParts } from "@codec/streams";

interface TestServer {
  base: string;
  config: ZuiServerConfig;
  storage: ZuiStorage;
  transfers: TransferService;
  close(): Promise<void>;
}

let servers: TestServer[] = [];

async function startServer(overrides: Partial<ZuiServerConfig> = {}, storage?: ZuiStorage): Promise<TestServer> {
  const dir = await mkdtemp(join(tmpdir(), "zui-api-test-"));
  const config = loadConfig({ port: 0, host: "127.0.0.1", dataDir: dir, logLevel: "silent", ...overrides });
  const finalStorage = storage ?? createStorage(config);
  const transfers = createTransferService(finalStorage, config);
  const app = createApp({ config, storage: finalStorage, transfers, logger: createLogger("silent") });
  const server = app.listen(0, "127.0.0.1") as Server;
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const ts: TestServer = {
    base,
    config,
    storage: finalStorage,
    transfers,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
  servers.push(ts);
  return ts;
}

beforeAll(() => registerNodeCodecAdapters());
afterAll(async () => {
  for (const s of servers) await s.close();
  servers = [];
});

interface Created {
  session: {
    id: string;
    senderToken: string;
    receiverToken: string;
    sharePath: string;
    chunkSize: number;
    chunkCount: number;
    expiresAt: number;
    status: string;
  };
}

async function createSession(srv: TestServer, body: Record<string, unknown>): Promise<Created> {
  const res = await fetch(`${srv.base}/api/v1/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Created;
}

function planChunks(size: number, chunkSize: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < size; offset += chunkSize) {
    chunks.push(new Uint8Array(randomBytes(Math.min(chunkSize, size - offset))));
  }
  return chunks;
}

const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

async function uploadChunks(
  srv: TestServer,
  id: string,
  token: string,
  chunks: Uint8Array[]
): Promise<Array<{ status: number; resume: boolean }>> {
  const out: Array<{ status: number; resume: boolean }> = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const res = await fetch(`${srv.base}/api/v1/sessions/${id}/chunks/${i}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        Authorization: `Bearer ${token}`,
        "X-Chunk-Sha256": sha(chunks[i]!),
        "Content-Length": String(chunks[i]!.byteLength),
      },
      body: chunks[i],
    });
    const json = (await res.json().catch(() => ({}))) as { chunk?: { resume: boolean } };
    out.push({ status: res.status, resume: json.chunk?.resume ?? false });
  }
  return out;
}

describe("ZUI REST API", () => {
  it("full transfer: create → upload → finalize → verify → resumable download → reconstruction", async () => {
    const srv = await startServer();
    const size = 5 * 1024 * 1024 + 777;
    const chunkSize = 1024 * 1024;
    const chunks = planChunks(size, chunkSize);
    const origSha = sha(concatParts(chunks));

    const created = await createSession(srv, {
      fileName: "movie.mp4",
      mimeType: "video/mp4",
      size,
      sha256: origSha,
      chunkSize,
    });
    const { id, senderToken, receiverToken } = created.session;
    expect(created.session.chunkCount).toBe(6);

    const uploads = await uploadChunks(srv, id, senderToken, chunks);
    expect(uploads.every((u) => u.status === 201)).toBe(true);

    // verify endpoint
    const verifyRes = await fetch(`${srv.base}/api/v1/sessions/${id}/verify`, {
      method: "POST",
      headers: { Authorization: `Bearer ${senderToken}` },
    });
    const verifyJson = (await verifyRes.json()) as { verify: { ok: boolean; verified: number; missing: number[] } };
    expect(verifyJson.verify.ok).toBe(true);
    expect(verifyJson.verify.verified).toBe(6);
    expect(verifyJson.verify.missing).toEqual([]);

    // finalize
    const finalizeRes = await fetch(`${srv.base}/api/v1/sessions/${id}/finalize`, {
      method: "POST",
      headers: { Authorization: `Bearer ${senderToken}` },
    });
    expect(finalizeRes.status).toBe(200);
    const finalized = (await finalizeRes.json()) as { finalized: { packageSize: number; packageSha256: string } };
    expect(finalized.finalized.packageSize).toBeGreaterThan(size);

    // session lookup as receiver
    const lookup = await fetch(`${srv.base}/api/v1/sessions/${id}?role=receiver`, {
      headers: { Authorization: `Bearer ${receiverToken}` },
    });
    expect(lookup.status).toBe(200);
    const lookupJson = (await lookup.json()) as { session: { status: string; packageSha256: string } };
    expect(lookupJson.session.status).toBe("sealed");
    expect(lookupJson.session.packageSha256).toBe(finalized.finalized.packageSha256);

    // download package with a byte range (resumable download)
    const rangeRes = await fetch(`${srv.base}/api/v1/sessions/${id}/package`, {
      headers: { Authorization: `Bearer ${receiverToken}`, Range: "bytes=0-4095" },
    });
    expect(rangeRes.status).toBe(206);
    expect(rangeRes.headers.get("content-range")).toBe(`bytes 0-4095/${finalized.finalized.packageSize}`);
    const rangeBytes = new Uint8Array(await rangeRes.arrayBuffer());
    expect(rangeBytes.byteLength).toBe(4096);

    // download the whole package and reconstruct the original
    const pkgRes = await fetch(`${srv.base}/api/v1/sessions/${id}/package`, {
      headers: { Authorization: `Bearer ${receiverToken}` },
    });
    expect(pkgRes.status).toBe(200);
    expect(pkgRes.headers.get("etag")).toBe(`"${finalized.finalized.packageSha256}"`);
    const decoder = await ZuiDecoder.open(webStreamToSource(pkgRes.body!));
    const rebuiltParts: Uint8Array[] = [];
    for await (const chunk of decoder.reconstruct()) rebuiltParts.push(chunk);
    const rebuilt = concatParts(rebuiltParts);
    expect(rebuilt.byteLength).toBe(size);
    expect(sha(rebuilt)).toBe(origSha);

    // single chunk download endpoint
    const chunkRes = await fetch(`${srv.base}/api/v1/sessions/${id}/chunks/2`, {
      headers: { Authorization: `Bearer ${receiverToken}` },
    });
    expect(chunkRes.status).toBe(200);
    expect(chunkRes.headers.get("x-chunk-sha256")).toBe(sha(chunks[2]!));
    expect(new Uint8Array(await chunkRes.arrayBuffer())).toEqual(chunks[2]);
  });

  it("rejects invalid session metadata", async () => {
    const srv = await startServer();
    const cases: Array<[Record<string, unknown>, number]> = [
      [{ fileName: "x", size: -1, sha256: "a".repeat(64) }, 400],
      [{ fileName: "x", size: 10, sha256: "nothex", chunkSize: 1024 * 1024 }, 400],
      [{ fileName: "x", size: 10, sha256: "a".repeat(64), mimeType: "bad mime" }, 400],
      [{ size: 10, sha256: "a".repeat(64) }, 400],
      [{ fileName: "x", size: 10, sha256: "a".repeat(64), chunkSize: 1024 }, 400],
    ];
    for (const [body, expectedStatus] of cases) {
      const res = await fetch(`${srv.base}/api/v1/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(expectedStatus);
    }
  });

  it("rejects oversized sessions", async () => {
    const srv = await startServer({ maxSessionBytes: 1024 });
    const res = await fetch(`${srv.base}/api/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "big", size: 2048, sha256: "a".repeat(64) }),
    });
    expect(res.status).toBe(400);
  });

  it("enforces authentication on every operation", async () => {
    const srv = await startServer();
    const chunks = planChunks(1000, 1024 * 1024);
    const created = await createSession(srv, { fileName: "a.txt", size: 1000, sha256: sha(chunks[0]!), chunkSize: 1024 * 1024 });
    const { id, senderToken } = created.session;

    const noToken = await fetch(`${srv.base}/api/v1/sessions/${id}/chunks/0`, {
      method: "PUT",
      headers: { "X-Chunk-Sha256": sha(chunks[0]!), "Content-Length": "1000" },
      body: chunks[0],
    });
    expect(noToken.status).toBe(401);

    const badToken = await fetch(`${srv.base}/api/v1/sessions/${id}/chunks/0`, {
      method: "PUT",
      headers: {
        Authorization: "Bearer 0".repeat(64),
        "X-Chunk-Sha256": sha(chunks[0]!),
        "Content-Length": "1000",
      },
      body: chunks[0],
    });
    expect(badToken.status).toBe(401);

    const wrongRole = await fetch(`${srv.base}/api/v1/sessions/${id}/verify`, {
      method: "POST",
      headers: { Authorization: `Bearer ${"0".repeat(64)}` },
    });
    expect(wrongRole.status).toBe(401);

    // receiver token cannot finalize
    const receiverCannotFinalize = await fetch(`${srv.base}/api/v1/sessions/${id}/finalize`, {
      method: "POST",
      headers: { Authorization: `Bearer ${created.session.receiverToken}` },
    });
    expect(receiverCannotFinalize.status).toBe(401);

    // unknown session
    const unknown = await fetch(`${srv.base}/api/v1/sessions/${"a".repeat(32)}`, {
      headers: { Authorization: `Bearer ${senderToken}` },
    });
    expect(unknown.status).toBe(404);
  });

  it("rejects corrupted chunks and wrong chunk sizes", async () => {
    const srv = await startServer({ maxChunkBytes: 4 * 1024 * 1024 });
    const size = 3 * 1024 * 1024;
    const chunkSize = 1024 * 1024;
    const chunks = planChunks(size, chunkSize);
    const created = await createSession(srv, { fileName: "c.bin", size, sha256: sha(concatParts(chunks)), chunkSize });
    const { id, senderToken } = created.session;

    // declared sha differs from body
    const bad = await fetch(`${srv.base}/api/v1/sessions/${id}/chunks/0`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${senderToken}`,
        "X-Chunk-Sha256": "f".repeat(64),
        "Content-Length": String(chunks[0]!.byteLength),
      },
      body: chunks[0],
    });
    expect(bad.status).toBe(409);

    // wrong content length (uncompressed chunks must match expected raw size)
    const wrongLen = await fetch(`${srv.base}/api/v1/sessions/${id}/chunks/0`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${senderToken}`,
        "X-Chunk-Sha256": sha(chunks[0]!),
        "Content-Length": "100",
      },
      body: new Uint8Array(100),
    });
    expect(wrongLen.status).toBe(400);

    // out-of-range index
    const oob = await fetch(`${srv.base}/api/v1/sessions/${id}/chunks/99`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${senderToken}`,
        "X-Chunk-Sha256": sha(chunks[0]!),
        "Content-Length": String(chunks[0]!.byteLength),
      },
      body: chunks[0],
    });
    expect(oob.status).toBe(400);

    // chunk larger than maxChunkBytes
    const tooBig = await fetch(`${srv.base}/api/v1/sessions/${id}/chunks/0`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${senderToken}`,
        "X-Chunk-Sha256": sha(chunks[0]!),
        "Content-Length": String(5 * 1024 * 1024),
      },
      body: new Uint8Array(5 * 1024 * 1024),
    });
    expect(tooBig.status).toBe(413);
  });

  it("supports interrupted uploads with resume", async () => {
    const srv = await startServer();
    const size = 2 * 1024 * 1024 + 500;
    const chunkSize = 1024 * 1024;
    const chunks = planChunks(size, chunkSize);
    expect(chunks).toHaveLength(3);
    const created = await createSession(srv, { fileName: "r.bin", size, sha256: sha(concatParts(chunks)), chunkSize });
    const { id, senderToken } = created.session;

    // upload only chunks 0 and 1 (interrupted)
    await uploadChunks(srv, id, senderToken, [chunks[0]!, chunks[1]!]);

    // finalize must fail: chunk 2 missing
    const failFinalize = await fetch(`${srv.base}/api/v1/sessions/${id}/finalize`, {
      method: "POST",
      headers: { Authorization: `Bearer ${senderToken}` },
    });
    expect(failFinalize.status).toBe(409);
    expect(((await failFinalize.json()) as { error: { code: string } }).error.code).toBe("integrity_failure");

    // resume: re-upload chunk 0 (idempotent) and the missing chunk 2
    const resumeRes = await fetch(`${srv.base}/api/v1/sessions/${id}/chunks/0`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${senderToken}`,
        "X-Chunk-Sha256": sha(chunks[0]!),
        "Content-Length": String(chunks[0]!.byteLength),
      },
      body: chunks[0],
    });
    expect(resumeRes.status).toBe(200);
    const resumeJson = (await resumeRes.json()) as { chunk: { resume: boolean } };
    expect(resumeJson.chunk.resume).toBe(true);

    const uploadMissing = await fetch(`${srv.base}/api/v1/sessions/${id}/chunks/2`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        Authorization: `Bearer ${senderToken}`,
        "X-Chunk-Sha256": sha(chunks[2]!),
        "Content-Length": String(chunks[2]!.byteLength),
      },
      body: chunks[2],
    });
    expect(uploadMissing.status).toBe(201);
    const okFinalize = await fetch(`${srv.base}/api/v1/sessions/${id}/finalize`, {
      method: "POST",
      headers: { Authorization: `Bearer ${senderToken}` },
    });
    expect(okFinalize.status).toBe(200);
  });

  it("handles expired sessions", async () => {
    const srv = await startServer({ sessionTtlMs: 60 });
    const chunks = planChunks(1000, 1024 * 1024);
    const created = await createSession(srv, { fileName: "e.bin", size: 1000, sha256: sha(chunks[0]!), chunkSize: 1024 * 1024 });
    const { id, senderToken } = created.session;
    await new Promise((r) => setTimeout(r, 120));
    const res = await fetch(`${srv.base}/api/v1/sessions/${id}?role=sender`, {
      headers: { Authorization: `Bearer ${senderToken}` },
    });
    expect(res.status).toBe(410);
  });

  it("cancels sessions and cleans up objects", async () => {
    const srv = await startServer();
    const chunks = planChunks(1024 * 1024, 1024 * 1024);
    const created = await createSession(srv, { fileName: "x.bin", size: 1024 * 1024, sha256: sha(chunks[0]!), chunkSize: 1024 * 1024 });
    const { id, senderToken } = created.session;
    await uploadChunks(srv, id, senderToken, [chunks[0]!]);
    const keysBefore = await srv.storage.list(`sessions/${id}`);
    expect(keysBefore.length).toBeGreaterThan(0);

    const cancel = await fetch(`${srv.base}/api/v1/sessions/${id}/cancel`, {
      method: "POST",
      headers: { Authorization: `Bearer ${senderToken}` },
    });
    expect(cancel.status).toBe(200);
    const keysAfter = await srv.storage.list(`sessions/${id}`);
    expect(keysAfter).toEqual([]);

    // cancel deletes the session record entirely: later access is 404
    const access = await fetch(`${srv.base}/api/v1/sessions/${id}?role=sender`, {
      headers: { Authorization: `Bearer ${senderToken}` },
    });
    expect(access.status).toBe(404);

    const del = await fetch(`${srv.base}/api/v1/sessions/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${senderToken}` },
    });
    expect(del.status).toBe(404);
    expect(await srv.storage.exists(`sessions/${id}/session.json`)).toBe(false);
  });

  it("stores only hashed tokens on disk", async () => {
    const srv = await startServer();
    const chunks = planChunks(1000, 1024 * 1024);
    const created = await createSession(srv, { fileName: "t.bin", size: 1000, sha256: sha(chunks[0]!), chunkSize: 1024 * 1024 });
    const { id, senderToken, receiverToken } = created.session;
    const raw = await readFile(join(srv.config.dataDir, "sessions", id, "session.json"), "utf8");
    const session = JSON.parse(raw) as { senderTokenHash: string; receiverTokenHash: string };
    expect(session.senderTokenHash).toBe(createHash("sha256").update(senderToken).digest("hex"));
    expect(session.receiverTokenHash).toBe(createHash("sha256").update(receiverToken).digest("hex"));
    expect(raw).not.toContain(senderToken);
    expect(raw).not.toContain(receiverToken);
  });

  it("supports concurrent chunk uploads", async () => {
    const srv = await startServer();
    const chunkSize = 1024 * 1024;
    const chunks = planChunks(chunkSize * 4, chunkSize);
    const created = await createSession(srv, { fileName: "p.bin", size: chunkSize * 4, sha256: sha(concatParts(chunks)), chunkSize });
    const { id, senderToken } = created.session;
    const results = await Promise.all(
      chunks.map((c, i) =>
        fetch(`${srv.base}/api/v1/sessions/${id}/chunks/${i}`, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${senderToken}`,
            "X-Chunk-Sha256": sha(c),
            "Content-Length": String(c.byteLength),
          },
          body: c,
        })
      )
    );
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    const finalize = await fetch(`${srv.base}/api/v1/sessions/${id}/finalize`, {
      method: "POST",
      headers: { Authorization: `Bearer ${senderToken}` },
    });
    expect(finalize.status).toBe(200);
  });

  it("maps storage failures to 500", async () => {
    const inner = createStorage(loadConfig({ dataDir: await mkdtemp(join(tmpdir(), "zui-api-fail-")) }));
    const failing: ZuiStorage = {
      ...inner,
      async put(key, stream, options) {
        if (/chunks\/\d+$/.test(key)) throw new Error("disk full");
        return inner.put(key, stream, options);
      },
      async writeJson(key, value) {
        return inner.writeJson(key, value);
      },
    };
    const srv = await startServer({}, failing);
    const chunks = planChunks(1000, 1024 * 1024);
    const created = await createSession(srv, { fileName: "f.bin", size: 1000, sha256: sha(chunks[0]!), chunkSize: 1024 * 1024 });
    const res = await fetch(`${srv.base}/api/v1/sessions/${created.session.id}/chunks/0`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${created.session.senderToken}`,
        "X-Chunk-Sha256": sha(chunks[0]!),
        "Content-Length": "1000",
      },
      body: chunks[0],
    });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("internal_error");
  });

  it("applies rate limits", async () => {
    const srv = await startServer({ rateLimits: { general: 1000, sessions: 2, chunks: 1000 } });
    const chunks = planChunks(1000, 1024 * 1024);
    await createSession(srv, { fileName: "1.bin", size: 1000, sha256: sha(chunks[0]!), chunkSize: 1024 * 1024 });
    await createSession(srv, { fileName: "2.bin", size: 1000, sha256: sha(chunks[0]!), chunkSize: 1024 * 1024 });
    const third = await fetch(`${srv.base}/api/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "3.bin", size: 1000, sha256: sha(chunks[0]!), chunkSize: 1024 * 1024 }),
    });
    expect(third.status).toBe(429);
  });

  it("honors the global access token when configured", async () => {
    const srv = await startServer({ accessToken: "secret-token" });
    const chunks = planChunks(1000, 1024 * 1024);
    const denied = await fetch(`${srv.base}/api/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "a.bin", size: 1000, sha256: sha(chunks[0]!), chunkSize: 1024 * 1024 }),
    });
    expect(denied.status).toBe(401);
    const allowed = await fetch(`${srv.base}/api/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer secret-token" },
      body: JSON.stringify({ fileName: "a.bin", size: 1000, sha256: sha(chunks[0]!), chunkSize: 1024 * 1024 }),
    });
    expect(allowed.status).toBe(201);
  });

  it("cleans up expired sessions via sweep", async () => {
    const srv = await startServer({ sessionTtlMs: 50 });
    const chunks = planChunks(1000, 1024 * 1024);
    const created = await createSession(srv, { fileName: "s.bin", size: 1000, sha256: sha(chunks[0]!), chunkSize: 1024 * 1024 });
    await new Promise((r) => setTimeout(r, 120));
    const removed = await srv.transfers.sweepExpired();
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await srv.storage.exists(`sessions/${created.session.id}/session.json`)).toBe(false);
  });

  it("verifies package integrity on a sealed session", async () => {
    const srv = await startServer();
    const chunkSize = 1024 * 1024;
    const chunks = planChunks(chunkSize * 2, chunkSize);
    const origSha = sha(concatParts(chunks));
    const created = await createSession(srv, { fileName: "v.bin", size: chunkSize * 2, sha256: origSha, chunkSize });
    const { id, senderToken } = created.session;
    await uploadChunks(srv, id, senderToken, chunks);
    await fetch(`${srv.base}/api/v1/sessions/${id}/finalize`, {
      method: "POST",
      headers: { Authorization: `Bearer ${senderToken}` },
    });
    const verifyRes = await fetch(`${srv.base}/api/v1/sessions/${id}/verify`, {
      method: "POST",
      headers: { Authorization: `Bearer ${senderToken}` },
    });
    const json = (await verifyRes.json()) as { verify: { ok: boolean; packageVerified: boolean } };
    expect(json.verify.ok).toBe(true);
    expect(json.verify.packageVerified).toBe(true);
    void origSha;
  });
});