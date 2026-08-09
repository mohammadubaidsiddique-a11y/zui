export const ZUI_DEFAULT_CHUNK_SIZE = 2 * 1024 * 1024; // 2 MiB
export const ZUI_MAGIC = "ZUI";
export const ZUI_VERSION = 1;
export const ZUI_MAX_FILENAME_BYTES = 1024;
export const ZUI_MAX_MIME_BYTES = 256;
export const ZUI_STORAGE_DEFAULT_CAP = 4 * 1024 * 1024; // per-chunk hard cap (bytes)

export const envValue = (name: string): string | undefined => {
  try {
    const v = globalThis.process?.env?.[name];
    return v && v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
};

export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return "-";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};

export const formatRate = (bytesPerSec: number): string => `${formatBytes(bytesPerSec)}/s`;

export const formatEta = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return "-";
  if (seconds < 1) return "<1s";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
};

export const hexToBytes = (hex: string): Uint8Array => {
  const even = hex.length % 2 === 0 ? hex : `0${hex}`;
  const out = new Uint8Array(even.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(even.slice(i * 2, i * 2 + 2), 16) & 0xff;
  }
  return out;
};

export const bytesToHex = (bytes: Uint8Array): string => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
};