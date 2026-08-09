import express, { type NextFunction, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import type { ZuiServerConfig } from "@server/config";
import type { ZuiStorage } from "@server/storage";
import {
  ApiError,
  parseRangeHeader,
  type TransferService,
} from "@server/transfers";
import { ValidationError, validateChunkIndex, validateTokenFormat } from "@server/validate";
import { hashedTokensEqual, hashToken } from "@server/crypto";
import { createRateLimiters } from "@server/rate-limit";
import { listChunkStates } from "@server/sessions";
import { createTempDownloadStore } from "@server/local-download";
import type { Logger } from "@server/logger";
import { httpLogger } from "@server/logger";

export interface ZuiAppContext {
  config: ZuiServerConfig;
  storage: ZuiStorage;
  transfers: TransferService;
  logger: Logger;
}

function bearerToken(req: Request): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  if (typeof req.query.zui === "string") return req.query.zui;
  const header = req.headers["x-zui-token"];
  if (typeof header === "string") return header;
  return undefined;
}

function requireToken(req: Request, res: Response, next: NextFunction): void {
  const token = bearerToken(req);
  try {
    validateTokenFormat(token);
    (req as Request & { zuiToken?: string }).zuiToken = token;
    next();
  } catch (err) {
    res.status(401).json({ error: { code: "unauthorized", message: "missing or malformed token" } });
    void err;
  }
}

export function createApp(ctx: ZuiAppContext): express.Express {
  const { config, storage, transfers, logger } = ctx;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use(httpLogger(logger));
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && config.corsOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Chunk-Sha256,X-Zui-Token");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  const limits = createRateLimiters(config.rateLimits);
  const tempDownloads = createTempDownloadStore(config.dataDir);

  const globalAccessToken = config.accessToken;
  const guardMutation = (req: Request, res: Response, next: NextFunction): void => {
    if (!globalAccessToken) {
      next();
      return;
    }
    const auth = req.headers.authorization;
    const ok = !!auth?.startsWith("Bearer ") && hashedTokensEqual(hashToken(auth.slice(7)), hashToken(globalAccessToken));
    if (!ok) {
      res.status(401).json({ error: { code: "unauthorized", message: "invalid access token" } });
      return;
    }
    next();
  };

  const api = express.Router();
  api.use(express.json({ limit: "1mb" }));

  api.get("/health", (_req, res) => {
    res.json({ ok: true, service: "zui", storage: storage.kind, time: new Date().toISOString() });
  });

  api.post("/sessions", limits.sessions, guardMutation, async (req, res, next) => {
    try {
      const out = await transfers.createSession(req.body ?? {});
      res.status(201).json({ session: out });
    } catch (err) {
      next(err);
    }
  });

  api.get("/sessions/:id", limits.general, requireToken, async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const role = req.query.role === "sender" ? "sender" : "receiver";
      const session = await transfers.getSession(id, (req as Request & { zuiToken: string }).zuiToken, role);
      const chunkStates = await listChunkStates(storage, id);
      res.json({
        session: {
          id: session.id,
          status: session.status,
          createdAt: session.createdAt,
          expiresAt: session.expiresAt,
          meta: session.meta,
          chunks: chunkStates.map((c) => ({ index: c.index, sha256: c.sha256, storedSize: c.storedSize })),
          packageSha256: session.packageSha256 ?? null,
          packageSize: session.packageSize ?? null,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  api.put("/sessions/:id/chunks/:index", requireToken, limits.chunks, async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const index = validateChunkIndex(req.params.index as string);
      const token = (req as Request & { zuiToken: string }).zuiToken;
      const declaredSha = (req.headers["x-chunk-sha256"] as string | undefined) ?? "";
      if (!/^[0-9a-fA-F]{64}$/.test(declaredSha)) {
        throw new ApiError("X-Chunk-Sha256 header must be a 64-char hex digest", 400, "bad_request");
      }
      const contentLength = Number(req.headers["content-length"]);
      if (!Number.isFinite(contentLength) || contentLength < 0) {
        throw new ApiError("Content-Length header required", 411, "length_required");
      }
      const result = await transfers.uploadChunk(id, index, token, req, contentLength, declaredSha.toLowerCase());
      res.status(result.resume ? 200 : 201).json({ chunk: result });
    } catch (err) {
      next(err);
    }
  });

  api.get("/sessions/:id/chunks/:index", limits.chunks, requireToken, async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const index = validateChunkIndex(req.params.index as string);
      const token = (req as Request & { zuiToken: string }).zuiToken;
      const role = req.query.role === "sender" ? "sender" : "receiver";
      const { stream, size, sha256 } = await transfers.downloadChunk(id, index, token, role);
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Length", String(size));
      res.setHeader("X-Chunk-Sha256", sha256);
      stream.pipe(res);
    } catch (err) {
      next(err);
    }
  });

  api.post("/sessions/:id/verify", limits.general, requireToken, async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const token = (req as Request & { zuiToken: string }).zuiToken;
      const report = await transfers.verifySession(id, token);
      res.json({ verify: report });
    } catch (err) {
      next(err);
    }
  });

  api.post("/sessions/:id/finalize", limits.general, requireToken, async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const token = (req as Request & { zuiToken: string }).zuiToken;
      const result = await transfers.finalizeSession(id, token);
      res.json({ finalized: result });
    } catch (err) {
      next(err);
    }
  });

  api.get("/sessions/:id/package", limits.general, requireToken, async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const token = (req as Request & { zuiToken: string }).zuiToken;
      const info = await transfers.packageInfo(id, token);
      const size = info.size;
      const range = req.headers.range ? parseRangeHeader(req.headers.range as string, size) : null;
      if (req.headers.range && !range) {
        res.status(416).setHeader("Content-Range", `bytes */${size}`).end();
        return;
      }
      const { stream, sha256, range: servedRange } = await transfers.packageStream(id, token, range ?? undefined);
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("ETag", `"${sha256}"`);
      res.setHeader("Content-Disposition", `attachment; filename="transfer.zui"`);
      if (servedRange) {
        res.status(206);
        res.setHeader("Content-Range", `bytes ${servedRange.start}-${servedRange.end}/${size}`);
        res.setHeader("Content-Length", String(servedRange.end - servedRange.start + 1));
      } else {
        res.setHeader("Content-Length", String(size));
      }
      stream.pipe(res);
    } catch (err) {
      next(err);
    }
  });

  api.post("/sessions/:id/cancel", limits.general, requireToken, async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const token = (req as Request & { zuiToken: string }).zuiToken;
      await transfers.cancelSession(id, token);
      res.json({ cancelled: true });
    } catch (err) {
      next(err);
    }
  });

  api.delete("/sessions/:id", limits.general, requireToken, async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const token = (req as Request & { zuiToken: string }).zuiToken;
      await transfers.deleteSession(id, token);
      res.json({ deleted: true });
    } catch (err) {
      next(err);
    }
  });

  app.use("/api/v1", api);

  // Local browser-side downloads that can't be Blob URLs (Safari limits,
  // embedded contexts): stage the bytes server-side, then the client issues a
  // plain same-origin GET that browsers download natively. Temp files are
  // deleted after being served and TTL-swept regardless.
  api.post("/local-download", limits.general, async (req, res, next) => {
    try {
      if (req.headers["content-type"] && !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:\s*;\s*charset=[\w-]+)?$/i.test(req.headers["content-type"])) {
        throw new ApiError("invalid content type", 400, "bad_request");
      }
      let rawName = "";
      try {
        rawName = typeof req.headers["x-zui-filename"] === "string" ? decodeURIComponent(req.headers["x-zui-filename"]) : "";
      } catch {
        rawName = "";
      }
      if (rawName.length > 512) throw new ApiError("file name too long", 400, "bad_request");
      const mime = (req.headers["content-type"] ?? "application/octet-stream").split(";")[0].trim();
      const { id } = await tempDownloads.save(req, rawName, mime, config.maxSessionBytes);
      res.status(201).json({ url: `/api/v1/local-download/${id}` });
    } catch (err) {
      next(err);
    }
  });

  api.get("/local-download/:id", limits.general, async (req, res, next) => {
    try {
      await tempDownloads.serve(req.params.id as string, res);
    } catch (err) {
      next(err);
    }
  });

  // Chunked staging for large payloads (every browser, any size): create →
  // ordered chunk uploads → finalize → same-origin GET.
  api.post("/local-download/chunked", limits.general, async (req, res, next) => {
    try {
      let rawName = "";
      try {
        rawName = typeof req.headers["x-zui-filename"] === "string" ? decodeURIComponent(req.headers["x-zui-filename"]) : "";
      } catch {
        rawName = "";
      }
      if (rawName.length > 512) throw new ApiError("file name too long", 400, "bad_request");
      const mime = (req.headers["content-type"] ?? "application/octet-stream").split(";")[0].trim();
      const { id } = await tempDownloads.createChunked(rawName, mime);
      res.status(201).json({ id });
    } catch (err) {
      next(err);
    }
  });

  api.post("/local-download/chunked/:id/chunk", limits.chunks, async (req, res, next) => {
    try {
      const { bytes } = await tempDownloads.append(req.params.id as string, req, config.maxSessionBytes);
      res.json({ bytes });
    } catch (err) {
      next(err);
    }
  });

  api.post("/local-download/chunked/:id/finalize", limits.general, async (req, res, next) => {
    try {
      const { url, bytes } = await tempDownloads.finalize(req.params.id as string);
      res.json({ url, bytes });
    } catch (err) {
      next(err);
    }
  });
  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "zui", storage: storage.kind, time: new Date().toISOString() });
  });

  // Serve the built web app (one port, production mode). Falls through to
  // the JSON 404 handler when the build is not present.
  const webDist = resolve(config.webDist);
  if (existsSync(webDist)) {
    app.use(
      express.static(webDist, {
        index: "index.html",
        maxAge: "1h",
        setHeaders: (res, filePath) => {
          if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
        },
      })
    );
    app.use((req, res, next) => {
      if (req.method !== "GET" || req.path.startsWith("/api") || req.path === "/health") {
        next();
        return;
      }
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(join(webDist, "index.html"));
    });
  }

  app.use((_req, res) => {
    res.status(404).json({ error: { code: "not_found", message: "endpoint not found" } });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof ApiError ? err.status : err instanceof ValidationError ? 400 : 500;
    if (status === 500) {
      logger.error({ err: (err as Error).message }, "unhandled error");
    }
    res.status(status).json({
      error: {
        code: err instanceof ApiError ? err.code : "internal_error",
        message: status === 500 ? "internal server error" : (err as Error).message,
      },
    });
  });

  return app;
}