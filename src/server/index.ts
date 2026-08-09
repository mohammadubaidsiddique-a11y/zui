import "dotenv/config";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { registerNodeCodecAdapters } from "@codec/node-adapters";
import { loadConfig } from "@server/config";
import { createLogger } from "@server/logger";
import { createStorage } from "@server/storage";
import { createTransferService } from "@server/transfers";
import { createApp } from "@server/app";

async function main(): Promise<void> {
  registerNodeCodecAdapters();
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const storage = createStorage(config);
  const transfers = createTransferService(storage, config);
  const app = createApp({ config, storage, transfers, logger });

  let server;
  if (config.tls.certPath && config.tls.keyPath) {
    server = createHttpsServer(
      {
        cert: readFileSync(config.tls.certPath),
        key: readFileSync(config.tls.keyPath),
      },
      app
    );
    logger.info("HTTPS enabled");
  } else {
    server = createHttpServer(app);
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => resolve());
  });

  logger.info(`ZUI server listening on http${config.tls.certPath ? "s" : ""}://${config.host}:${config.port}`);
  logger.info(`storage: ${storage.kind}${storage.kind === "local" ? ` (${config.dataDir})` : ` (bucket ${config.s3.bucket})`}`);

  const sweep = setInterval(async () => {
    try {
      const removed = await transfers.sweepExpired();
      if (removed > 0) logger.info({ removed }, "swept expired sessions");
    } catch (err) {
      logger.error({ err: (err as Error).message }, "sweep failed");
    }
  }, config.sweepIntervalMs);
  sweep.unref();

  const shutdown = (signal: string): void => {
    logger.info({ signal }, "shutting down");
    clearInterval(sweep);
    server.close(() => {
      storage.dispose().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("fatal startup error:", err);
  process.exit(1);
});