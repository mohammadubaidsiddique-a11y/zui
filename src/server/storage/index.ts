import type { ZuiServerConfig } from "@server/config";
import { LocalStorage } from "./local";
import { S3Storage } from "./s3";
import type { ZuiStorage } from "./types";

export type { ZuiStorage, StorageObject, PutResult, StatInfo } from "./types";
export { StorageError } from "./types";
export { LocalStorage } from "./local";
export { S3Storage } from "./s3";
export { MemoryStorage } from "./memory";

export function createStorage(config: ZuiServerConfig): ZuiStorage {
  if (config.storage === "s3") {
    return new S3Storage({
      bucket: config.s3.bucket,
      endpoint: config.s3.endpoint,
      region: config.s3.region,
      accessKeyId: config.s3.accessKeyId,
      secretAccessKey: config.s3.secretAccessKey,
      forcePathStyle: config.s3.forcePathStyle,
      prefix: "sessions",
    });
  }
  return new LocalStorage(config.dataDir);
}