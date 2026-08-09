import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { LocalStorage, StorageError } from "@server/storage";

let dir = "";
let storage: LocalStorage;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "zui-storage-test-"));
  storage = new LocalStorage(dir);
  await (storage as LocalStorage & { init(): Promise<void> }).init();
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const collect = async (stream: NodeJS.ReadableStream): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks);
};

describe("LocalStorage", () => {
  it("round-trips put/get", async () => {
    const data = Buffer.from("hello storage");
    const result = await storage.put("a/b.txt", Readable.from([data]));
    expect(result.size).toBe(data.length);
    expect(result.sha256).toHaveLength(64);
    const obj = await storage.get("a/b.txt");
    expect(obj.size).toBe(data.length);
    expect((await collect(obj.stream)).toString()).toBe("hello storage");
  });

  it("verifies expected sha256 during put", async () => {
    const data = Buffer.from("verify me");
    await storage.put("c.txt", Readable.from([data]), { expectedSha256: hashOf(data) });
    await expect(
      storage.put("d.txt", Readable.from([data]), { expectedSha256: "f".repeat(64) })
    ).rejects.toThrow(/mismatch/i);
    expect(await storage.exists("d.txt")).toBe(false);
  });

  it("supports range reads for resumable downloads", async () => {
    const data = Buffer.from("0123456789");
    await storage.put("range.bin", Readable.from([data]));
    const part = await collect(await storage.range("range.bin", 2, 5));
    expect(part.toString()).toBe("2345");
    await expect(storage.range("range.bin", 0, 99)).rejects.toThrow();
    await expect(storage.range("range.bin", 5, 2)).rejects.toThrow();
  });

  it("lists keys under a prefix", async () => {
    await storage.put("sessions/x/chunks/0", Readable.from([Buffer.from("a")]));
    await storage.put("sessions/x/chunks/1", Readable.from([Buffer.from("b")]));
    await storage.put("sessions/x/session.json", Readable.from([Buffer.from("{}")]));
    await storage.put("other/y", Readable.from([Buffer.from("z")]));
    const keys = await storage.list("sessions/x");
    expect(keys.sort()).toEqual(["sessions/x/chunks/0", "sessions/x/chunks/1", "sessions/x/session.json"]);
  });

  it("reads and writes JSON atomically", async () => {
    await storage.writeJson("meta.json", { a: 1, nested: { b: [1, 2, 3] } });
    const parsed = await storage.readJson<{ a: number }>("meta.json");
    expect(parsed?.a).toBe(1);
    expect(await storage.readJson("missing.json")).toBeNull();
  });

  it("rejects path traversal keys", async () => {
    for (const key of ["../evil", "a/../../evil", "/etc/passwd", "..", "a\\..\\b", "a\u0000b", "a/../b"]) {
      await expect(storage.put(key, Readable.from([Buffer.from("x")]))).rejects.toThrow();
    }
  });

  it("deletes objects and reports existence", async () => {
    await storage.put("gone.txt", Readable.from([Buffer.from("x")]));
    expect(await storage.exists("gone.txt")).toBe(true);
    await storage.delete("gone.txt");
    expect(await storage.exists("gone.txt")).toBe(false);
    await expect(storage.get("gone.txt")).rejects.toMatchObject({ code: "not_found" });
    await expect(storage.stat("gone.txt")).rejects.toBeInstanceOf(StorageError);
  });

  it("leaves no temp files behind", async () => {
    await storage.put("clean.txt", Readable.from([Buffer.from("x")]));
    const entries = await readdir(dir);
    expect(entries.filter((e) => e.startsWith(".tmp-"))).toEqual([]);
  });
});

const hashOf = (b: Buffer): string => createHash("sha256").update(b).digest("hex");