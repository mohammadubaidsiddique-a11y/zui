import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { join } from "node:path";
import type { Request, Response } from "express";
import { ApiError } from "@server/transfers";

const ID_RE = /^[0-9a-f]{64}$/;
const TTL_MS = 30 * 60 * 1000;

/**
 * Staging store for browser-side downloads that cannot be delivered as Blob
 * URLs (Safari big-blob limits, sandboxed/embedded contexts): the client POSTs
 * the bytes here and then triggers a plain same-origin GET, which every
 * browser downloads natively via Content-Disposition. Files are single-use-ish
 * (deleted after being served) and TTL-swept regardless.
 */
export interface TempDownloadStore {
  save(req: Request, name: string, mime: string, maxBytes: number): Promise<{ id: string }>;
  serve(id: string, res: Response): Promise<void>;
}

const sanitizeName = (raw: string): string => {
  const name = raw.replace(/[\r\n"\u0000-\u001f]/g, "_").slice(0, 255).trim();
  return name || "download.bin";
};

export function createTempDownloadStore(dataDir: string): TempDownloadStore {
  const dir = join(dataDir, "tmp-downloads");

  const scheduleSweep = (id: string): void => {
    const timer = setTimeout(() => {
      void rm(join(dir, `${id}.bin`), { force: true });
      void rm(join(dir, `${id}.json`), { force: true });
    }, TTL_MS);
    timer.unref();
  };

  return {
    async save(req, name, mime, maxBytes): Promise<{ id: string }> {
      await mkdir(dir, { recursive: true });
      const id = randomBytes(32).toString("hex");
      const filePath = join(dir, `${id}.bin`);
      let bytes = 0;
      try {
        const ws = createWriteStream(filePath);
        try {
          for await (const chunk of req) {
            const buf = chunk as Buffer;
            bytes += buf.byteLength;
            if (bytes > maxBytes) throw new ApiError(`payload exceeds ${maxBytes} bytes`, 413, "payload_too_large");
            if (!ws.write(buf)) await once(ws, "drain");
          }
        } catch (err) {
          ws.destroy();
          throw err;
        }
        ws.end();
        await once(ws, "close");
        if (bytes === 0) throw new ApiError("empty payload", 400, "bad_request");
        await writeFile(join(dir, `${id}.json`), JSON.stringify({ name: sanitizeName(name), mime, bytes }), "utf8");
        scheduleSweep(id);
        return { id };
      } catch (err) {
        await rm(filePath, { force: true }).catch(() => undefined);
        throw err;
      }
    },

    async serve(id, res): Promise<void> {
      if (!ID_RE.test(id)) throw new ApiError("invalid download id", 400, "bad_request");
      const metaPath = join(dir, `${id}.json`);
      const filePath = join(dir, `${id}.bin`);
      let meta: { name: string; mime: string; bytes: number };
      try {
        meta = JSON.parse(await readFile(metaPath, "utf8")) as { name: string; mime: string; bytes: number };
      } catch {
        throw new ApiError("download not found or expired", 404, "not_found");
      }
      const size = (await stat(filePath)).size;
      const asciiFallback = meta.name.replace(/[^\x20-\x7e]/g, "_");
      res.setHeader("Content-Type", meta.mime || "application/octet-stream");
      res.setHeader("Content-Length", String(size));
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(meta.name)}`
      );
      const stream = createReadStream(filePath);
      stream.pipe(res);
      res.on("close", () => {
        stream.destroy();
        void rm(filePath, { force: true });
        void rm(metaPath, { force: true });
      });
    },
  };
}