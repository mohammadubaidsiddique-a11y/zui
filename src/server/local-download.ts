import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { basename, extname, join } from "node:path";
import type { Request, Response } from "express";
import { ApiError } from "@server/transfers";

const ID_RE = /^[0-9a-f]{64}$/;
const TTL_MS = 30 * 60 * 1000;

export type TranscodeMode = "compress" | "enhance";

/**
 * Staging store for browser-side downloads that cannot be delivered as Blob
 * URLs (Safari size ceilings, sandboxed/embedded contexts): the client uploads
 * the bytes here — in one POST for small files, in ordered chunks for large
 * ones — and then triggers a plain same-origin GET, which every browser
 * downloads natively via Content-Disposition. Files are deleted after being
 * served and TTL-swept regardless.
 */
export interface TempDownloadStore {
  save(req: Request, name: string, mime: string, maxBytes: number): Promise<{ id: string }>;
  createChunked(name: string, mime: string): Promise<{ id: string }>;
  append(id: string, req: Request, maxBytes: number): Promise<{ bytes: number }>;
  finalize(id: string): Promise<{ url: string; bytes: number; id: string }>;
  transcode(id: string, mode: TranscodeMode, ffmpegPath: string): Promise<{ url: string; bytes: number }>;
  serve(id: string, res: Response): Promise<void>;
}

const sanitizeName = (raw: string): string => {
  const name = raw.replace(/[\r\n"\u0000-\u001f]/g, "_").slice(0, 255).trim();
  return name || "download.bin";
};

const streamToFile = async (req: Request, filePath: string, maxBytes: number, existingBytes: number): Promise<number> => {
  let bytes = existingBytes;
  const ws = createWriteStream(filePath, { flags: "a" });
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
  return bytes;
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

  const metaPath = (id: string): string => join(dir, `${id}.json`);
  const binPath = (id: string): string => join(dir, `${id}.bin`);
  const readMeta = async (id: string): Promise<{ name: string; mime: string; bytes: number; chunked: boolean }> => {
    try {
      return JSON.parse(await readFile(metaPath(id), "utf8")) as {
        name: string;
        mime: string;
        bytes: number;
        chunked: boolean;
      };
    } catch {
      throw new ApiError("download not found or expired", 404, "not_found");
    }
  };

  return {
    async save(req, name, mime, maxBytes): Promise<{ id: string }> {
      await mkdir(dir, { recursive: true });
      const id = randomBytes(32).toString("hex");
      const filePath = binPath(id);
      try {
        const bytes = await streamToFile(req, filePath, maxBytes, 0);
        if (bytes === 0) throw new ApiError("empty payload", 400, "bad_request");
        await writeFile(
          metaPath(id),
          JSON.stringify({ name: sanitizeName(name), mime, bytes, chunked: false }),
          "utf8"
        );
        scheduleSweep(id);
        return { id };
      } catch (err) {
        await rm(filePath, { force: true }).catch(() => undefined);
        await rm(metaPath(id), { force: true }).catch(() => undefined);
        throw err;
      }
    },

    async createChunked(name, mime): Promise<{ id: string }> {
      await mkdir(dir, { recursive: true });
      const id = randomBytes(32).toString("hex");
      await writeFile(metaPath(id), JSON.stringify({ name: sanitizeName(name), mime, bytes: 0, chunked: true }), "utf8");
      scheduleSweep(id);
      return { id };
    },

    async append(id, req, maxBytes): Promise<{ bytes: number }> {
      if (!ID_RE.test(id)) throw new ApiError("invalid download id", 400, "bad_request");
      const meta = await readMeta(id);
      const bytes = await streamToFile(req, binPath(id), maxBytes, meta.bytes);
      await writeFile(metaPath(id), JSON.stringify({ ...meta, bytes }), "utf8");
      return { bytes };
    },

    async finalize(id): Promise<{ url: string; bytes: number; id: string }> {
      if (!ID_RE.test(id)) throw new ApiError("invalid download id", 400, "bad_request");
      const meta = await readMeta(id);
      if (meta.bytes === 0) throw new ApiError("empty payload", 400, "bad_request");
      return { url: `/api/v1/local-download/${id}`, bytes: meta.bytes, id };
    },

    async transcode(id, mode, ffmpegPath): Promise<{ url: string; bytes: number }> {
      if (!ID_RE.test(id)) throw new ApiError("invalid download id", 400, "bad_request");
      const meta = await readMeta(id);
      if (meta.bytes === 0) throw new ApiError("empty payload", 400, "bad_request");
      const outName = sanitizeName(
        `${basename(meta.name, extname(meta.name)) || "video"}${mode === "enhance" ? "-enhanced" : "-compressed"}.mp4`
      );
      const outId = randomBytes(32).toString("hex");
      const outPath = binPath(outId);
      const args = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        binPath(id),
        ...(mode === "enhance"
          ? ["-vf", "scale=-2:1080,hqdn3d=4:3:6:4.5", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-c:a", "aac", "-b:a", "192k"]
          : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-c:a", "aac", "-b:a", "128k"]),
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
        "-y",
        outPath,
      ];
      const stderr: string[] = [];
      const proc = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
      proc.stderr.setEncoding("utf8");
      proc.stderr.on("data", (chunk: string) => {
        stderr.push(chunk);
        if (stderr.length > 60) stderr.shift();
      });
      try {
        await new Promise<void>((resolve, reject) => {
          proc.once("error", (err) => reject(new ApiError(`ffmpeg unavailable: ${err.message}`, 500, "transcode_failed")));
          proc.once("close", (code) => {
            if (code === 0) resolve();
            else reject(new ApiError(`ffmpeg exited ${code}: ${stderr.join("").slice(-2000)}`, 422, "transcode_failed"));
          });
        });
        const size = (await stat(outPath)).size;
        await writeFile(metaPath(outId), JSON.stringify({ name: outName, mime: "video/mp4", bytes: size, chunked: false }), "utf8");
        scheduleSweep(outId);
        await rm(binPath(id), { force: true });
        await rm(metaPath(id), { force: true });
        return { url: `/api/v1/local-download/${outId}`, bytes: size };
      } catch (err) {
        await rm(outPath, { force: true }).catch(() => undefined);
        throw err;
      }
    },

    async serve(id, res): Promise<void> {
      if (!ID_RE.test(id)) throw new ApiError("invalid download id", 400, "bad_request");
      const meta = await readMeta(id);
      const filePath = binPath(id);
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
        void rm(metaPath(id), { force: true });
      });
    },
  };
}