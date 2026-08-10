import { ZUI_DEFAULT_CHUNK_SIZE } from "@shared/format";

export interface ZuiServerConfig {
  host: string;
  port: number;
  corsOrigins: string[];
  dataDir: string;
  webDist: string;
  storage: "local" | "s3";
  maxSessionBytes: number;
  maxChunkBytes: number;
  sessionTtlMs: number;
  sweepIntervalMs: number;
  accessToken: string | undefined;
  ffmpeg: string;
  rateLimits: {
    general: number;
    chunks: number;
    sessions: number;
  };
  s3: {
    endpoint: string | undefined;
    region: string;
    bucket: string;
    accessKeyId: string | undefined;
    secretAccessKey: string | undefined;
    forcePathStyle: boolean;
  };
  tls: {
    certPath: string | undefined;
    keyPath: string | undefined;
  };
  logLevel: string;
}

const intEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const v = Number.parseInt(raw, 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

const strEnv = (name: string, fallback: string): string => process.env[name]?.trim() || fallback;

export function loadConfig(overrides: Partial<ZuiServerConfig> = {}): ZuiServerConfig {
  const base: ZuiServerConfig = {
    host: strEnv("ZUI_HOST", "0.0.0.0"),
    port: intEnv("ZUI_PORT", Number.parseInt(process.env.PORT ?? "", 10) || 3000),
    corsOrigins: (process.env.ZUI_CORS_ORIGINS ?? "http://127.0.0.1:5173,http://localhost:5173")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    dataDir: strEnv("ZUI_DATA_DIR", ".zui-data"),
    webDist: strEnv("ZUI_WEB_DIST", "dist/web"),
    storage: (process.env.ZUI_STORAGE ?? "local") === "s3" ? "s3" : "local",
    maxSessionBytes: intEnv("ZUI_MAX_SESSION_BYTES", 16 * 1024 * 1024 * 1024),
    maxChunkBytes: intEnv("ZUI_MAX_CHUNK_BYTES", 64 * 1024 * 1024),
    sessionTtlMs: intEnv("ZUI_SESSION_TTL_MS", 24 * 60 * 60 * 1000),
    sweepIntervalMs: intEnv("ZUI_SWEEP_INTERVAL_MS", 10 * 60 * 1000),
    accessToken: process.env.ZUI_ACCESS_TOKEN?.trim() || undefined,
    ffmpeg: strEnv("ZUI_FFMPEG", "ffmpeg"),
    rateLimits: {
      general: intEnv("ZUI_RATE_LIMIT_GENERAL", 5000),
      chunks: intEnv("ZUI_RATE_LIMIT_CHUNKS", 6000),
      sessions: intEnv("ZUI_RATE_LIMIT_SESSIONS", 40),
    },
    s3: {
      endpoint: process.env.ZUI_S3_ENDPOINT?.trim() || undefined,
      region: strEnv("ZUI_S3_REGION", "auto"),
      bucket: strEnv("ZUI_S3_BUCKET", "zui"),
      accessKeyId: process.env.ZUI_S3_ACCESS_KEY_ID?.trim() || undefined,
      secretAccessKey: process.env.ZUI_S3_SECRET_ACCESS_KEY?.trim() || undefined,
      forcePathStyle: (process.env.ZUI_S3_FORCE_PATH_STYLE ?? "false") === "true",
    },
    tls: {
      certPath: process.env.ZUI_TLS_CERT_PATH?.trim() || undefined,
      keyPath: process.env.ZUI_TLS_KEY_PATH?.trim() || undefined,
    },
    logLevel: strEnv("ZUI_LOG_LEVEL", "info"),
  };
  return { ...base, ...overrides };
}

export function defaultChunkSize(): number {
  return ZUI_DEFAULT_CHUNK_SIZE;
}