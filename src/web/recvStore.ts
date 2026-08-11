export type BackendKind = "opfs-async" | "opfs-worker" | "cache";

export interface ChunkSink {
  kind: BackendKind;
  open(): Promise<void>;
  writeChunk(index: number, bytes: Uint8Array): Promise<void>;
  completedChunks(): Promise<number>;
  finish(): Promise<void>;
  reset(): Promise<void>;
  size(): Promise<number>;
  readAll(onChunk: (bytes: Uint8Array) => Promise<void>): Promise<void>;
  saveToUserFile(suggestedName: string, mime: string): Promise<boolean>;
  getFile?(): Promise<File>;
}



interface SaveHandleLike {
  createWritable(): Promise<FileSystemWritableFileStream>;
}

function dataName(fileId: string): string {
  return `zui-${fileId}.bin`;
}
function metaName(fileId: string): string {
  return `zui-${fileId}.meta.json`;
}
function manifestBlob(chunks: number): string {
  return JSON.stringify({ chunks, at: Date.now() });
}

async function readManifest(dir: FileSystemDirectoryHandle, fileId: string): Promise<number> {
  try {
    const meta = await dir.getFileHandle(metaName(fileId));
    const f = await meta.getFile();
    const parsed = JSON.parse(await f.text()) as { chunks: number };
    return typeof parsed.chunks === "number" ? parsed.chunks : 0;
  } catch {
    return 0;
  }
}

async function writeManifest(dir: FileSystemDirectoryHandle, fileId: string, chunks: number): Promise<void> {
  const meta = await dir.getFileHandle(metaName(fileId), { create: true });
  const w = await meta.createWritable();
  await w.write(manifestBlob(chunks));
  await w.close();
}
export async function detectBackendKind(): Promise<BackendKind> {
  try {
    if (typeof navigator.storage?.getDirectory === "function") {
      const root = await navigator.storage.getDirectory();
      const probe = await root.getFileHandle("__zui_probe__", { create: true });
      if (typeof probe.createWritable === "function") {
        const w = await probe.createWritable();
        await w.write("x");
        await w.close();
        await root.removeEntry("__zui_probe__");
        return "opfs-async";
      }
      await root.removeEntry("__zui_probe__").catch(() => undefined);
      if (typeof probe.createSyncAccessHandle === "function") return "opfs-worker";
    }
  } catch {
    /* fall through */
  }
  if (typeof caches !== "undefined" && typeof caches.open === "function") return "cache";
  throw new Error("no persistent streaming backend available in this browser");
}

function openOpfsAsync(fileId: string, chunkSize: number): Promise<ChunkSink> {
  return navigator.storage.getDirectory().then(async (root) => {
    const handle = await root.getFileHandle(dataName(fileId), { create: true });
    let writable: FileSystemWritableFileStream | null = null;

    return {
      kind: "opfs-async" as const,
      async open() {
        writable = await handle.createWritable({ keepExistingData: true });
        const done = await readManifest(root, fileId);
        if (done > 0) {
          const size = (await handle.getFile()).size;
          if (size > done * chunkSize) await writable.truncate(done * chunkSize);
        }
      },
      async writeChunk(index: number, bytes: Uint8Array) {
        if (!writable) throw new Error("sink not open");
        const t0 = performance.now();
        await writable.write({ type: "write", data: new Uint8Array(bytes), position: index * chunkSize });
        console.debug("[zui-sink] wrote", index, `${(performance.now() - t0).toFixed(1)}ms`);
        const t1 = performance.now();
        await writeManifest(root, fileId, index + 1);
        console.debug("[zui-sink] manifest", index, `${(performance.now() - t1).toFixed(1)}ms`);
      },
      async completedChunks() {
        return readManifest(root, fileId);
      },
      async finish() {
        if (writable) {
          await writable.close();
          writable = null;
        }
      },
      async reset() {
        if (writable) {
          await writable.close().catch(() => undefined);
          writable = null;
        }
        await root.removeEntry(dataName(fileId)).catch(() => undefined);
        await root.removeEntry(metaName(fileId)).catch(() => undefined);
      },
      async size() {
        const f = await handle.getFile();
        return f.size;
      },
      async readAll(onChunk) {
        const f = await handle.getFile();
        const total = f.size;
        for (let at = 0; at < total; at += chunkSize) {
          const len = Math.min(chunkSize, total - at);
          const raw = await f.slice(at, at + len).arrayBuffer();
          await onChunk(new Uint8Array(raw));
        }
      },
      async getFile() {
        return handle.getFile();
      },
      async saveToUserFile(suggestedName: string, _mime: string) {
        let f: File;
        try {
          f = await handle.getFile();
        } catch {
          const fresh = await navigator.storage.getDirectory();
          f = await (await fresh.getFileHandle(dataName(fileId))).getFile();
        }
        const picker = (
          globalThis as unknown as { showSaveFilePicker?: (o?: { suggestedName?: string }) => Promise<SaveHandleLike> }
        ).showSaveFilePicker;
        if (typeof picker === "function") {
          try {
            const target = await picker({ suggestedName });
            const out = await target.createWritable();
            const total = f.size;
            for (let at = 0; at < total; at += 4 * 1024 * 1024) {
              const raw = await f.slice(at, Math.min(at + 4 * 1024 * 1024, total)).arrayBuffer();
              await out.write(new Uint8Array(raw));
            }
            await out.close();
            return true;
          } catch {
            /* picker rejected — fall back to blob download */
          }
        }
        const blob = new Blob([f], { type: _mime || "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = suggestedName;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
        return false;
      },
    };
  });
}
function workerSource(): string {
  return [
    "let s=null,fileId,chunkSize,offset=0;",
    "self.onmessage=async(ev)=>{",
    "const m=ev.data;",
    "try{",
    "if(m.op==='init'){",
    "fileId=m.fileId;chunkSize=m.chunkSize;",
    "const root=await navigator.storage.getDirectory();",
    "const h=await root.getFileHandle('zui-'+fileId+'.bin',{create:true});",
    "s=await h.createSyncAccessHandle();",
    "offset=await s.getSize();",
    "self.postMessage({id:m.id,op:'ready',offset});",
    "}else if(m.op==='put'){",
    "const pos=m.index*chunkSize;",
    "await s.write(new Uint8Array(m.data),{at:pos});",
    "if(offset<pos+m.data.byteLength)offset=pos+m.data.byteLength;",
    "self.postMessage({id:m.id,op:'ok'});",
    "}else if(m.op==='flush'){",
    "await s.flush();",
    "self.postMessage({id:m.id,op:'ok'});",
    "}else if(m.op==='size'){",
    "self.postMessage({id:m.id,op:'size',size:offset});",
    "}else if(m.op==='read'){",
    "const len=Math.min(m.length,offset-m.at);",
    "if(len<=0){",
    "self.postMessage({id:m.id,op:'eof'});",
    "}else{",
    "const b=new Uint8Array(len);",
    "await s.read(b,{at:m.at});",
    "self.postMessage({id:m.id,op:'data',data:b.buffer},[b.buffer]);",
    "}",
    "}else if(m.op==='close'){",
    "await s.flush();",
    "self.postMessage({id:m.id,op:'ok'});",
    "}",
    "}catch(e){",
    "self.postMessage({id:m.id,op:'error',message:String(e&&e.message?e.message:e)});",
    "}",
    "};",
  ].join("\n");
}

interface WorkerReply {
  op: string;
  data?: ArrayBuffer;
  offset?: number;
  size?: number;
  message?: string;
}

function openOpfsWorker(fileId: string, chunkSize: number): Promise<ChunkSink> {
  const url = URL.createObjectURL(new Blob([workerSource()], { type: "text/javascript" }));
  const worker = new Worker(url);
  const pending = new Map<number, (msg: WorkerReply) => void>();
  let seq = 0;

  const call = (op: string, payload: Record<string, unknown> = {}, transfer?: Transferable[]): Promise<WorkerReply> =>
    new Promise((resolve) => {
      const id = seq++;
      pending.set(id, resolve);
      worker.postMessage({ id, op, ...payload }, transfer ?? []);
    });

  worker.onmessage = (ev: MessageEvent) => {
    const m = ev.data as WorkerReply & { id: number };
    const p = pending.get(m.id);
    if (p) {
      pending.delete(m.id);
      p(m);
    }
  };

  return call("init", { fileId, chunkSize }).then(() => {
    const sink: ChunkSink = {
      kind: "opfs-worker" as const,
      async open() {
        await call("init", { fileId, chunkSize });
      },
      async writeChunk(index: number, bytes: Uint8Array) {
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        const r = await call("put", { index, data: copy.buffer }, [copy.buffer]);
        if (r.op === "error") throw new Error(r.message ?? "worker write failed");
      },
      async completedChunks() {
        return 0;
      },
      async finish() {
        await call("flush");
      },
      async reset() {
        worker.terminate();
      },
      async size() {
        const r = await call("size");
        return r.size ?? 0;
      },
      async readAll(onChunk) {
        const total = (await call("size")).size ?? 0;
        for (let at = 0; at < total; at += chunkSize) {
          const r = await call("read", { at, length: chunkSize });
          if (r.op === "data") await onChunk(new Uint8Array(r.data ?? new ArrayBuffer(0)));
          else break;
        }
      },
      async saveToUserFile(suggestedName: string, mime: string) {
        const picker = (
          globalThis as unknown as { showSaveFilePicker?: (o?: { suggestedName?: string }) => Promise<SaveHandleLike> }
        ).showSaveFilePicker;
        if (typeof picker === "function") {
          try {
            const target = await picker({ suggestedName });
            const out = await target.createWritable();
            await sink.readAll(async (chunk) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              await out.write(chunk as any);
            });
            await out.close();
            return true;
          } catch {
            /* picker rejected — fall back */
          }
        }
        const chunks: Uint8Array[] = [];
        await sink.readAll(async (chunk) => {
          chunks.push(chunk);
        });
        const blob = new Blob(chunks as unknown as BlobPart[], { type: mime || "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = suggestedName;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
        return false;
      },
    };
    return sink;
  });
}
function openCacheBackend(fileId: string, chunkSize: number): Promise<ChunkSink> {
  return caches.open(`zui-${fileId}`).then(async (cache) => {
    const chunkCount = async (): Promise<number> => {
      const meta = await cache.match("zui-manifest");
      if (!meta) return 0;
      try {
        const parsed = (await meta.json()) as { chunks: number };
        return parsed.chunks ?? 0;
      } catch {
        return 0;
      }
    };
    const sink: ChunkSink = {
      kind: "cache" as const,
      async open() {
        await chunkCount();
      },
      async writeChunk(index: number, bytes: Uint8Array) {
        await cache.put(`chunk-${index}`, new Response(new Uint8Array(bytes)));
        await cache.put("zui-manifest", new Response(manifestBlob(index + 1)));
      },
      async completedChunks() {
        return chunkCount();
      },
      async finish() {},
      async reset() {
        await caches.delete(`zui-${fileId}`);
      },
      async size() {
        const n = await chunkCount();
        if (n === 0) return 0;
        const last = await cache.match(`chunk-${n - 1}`);
        if (!last) return (n - 1) * chunkSize;
        const tail = await last.arrayBuffer();
        return (n - 1) * chunkSize + tail.byteLength;
      },
      async readAll(onChunk) {
        const n = await chunkCount();
        for (let i = 0; i < n; i += 1) {
          const r = await cache.match(`chunk-${i}`);
          if (!r) continue;
          const raw = await r.arrayBuffer();
          await onChunk(new Uint8Array(raw));
        }
      },
      async saveToUserFile(suggestedName: string, mime: string) {
        const picker = (
          globalThis as unknown as { showSaveFilePicker?: (o?: { suggestedName?: string }) => Promise<SaveHandleLike> }
        ).showSaveFilePicker;
        if (typeof picker === "function") {
          try {
            const target = await picker({ suggestedName });
            const out = await target.createWritable();
            await sink.readAll(async (chunk) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              await out.write(chunk as any);
            });
            await out.close();
            return true;
          } catch {
            /* picker rejected — fall back */
          }
        }
        const chunks: Uint8Array[] = [];
        await sink.readAll(async (chunk) => {
          chunks.push(chunk);
        });
        const blob = new Blob(chunks as unknown as BlobPart[], { type: mime || "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = suggestedName;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
        return false;
      },
    };
    return sink;
  });
}

export async function openRecvSink(fileId: string, chunkSize = 2 * 1024 * 1024): Promise<ChunkSink> {
  const kind = await detectBackendKind();
  if (kind === "opfs-async") return openOpfsAsync(fileId, chunkSize);
  if (kind === "opfs-worker") return openOpfsWorker(fileId, chunkSize);
  return openCacheBackend(fileId, chunkSize);
}
