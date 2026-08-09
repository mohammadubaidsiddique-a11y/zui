import pino from "pino";
import pinoHttp from "pino-http";

export function createLogger(level = "info") {
  const logger = pino({
    level,
    base: { pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
  return logger;
}

export type Logger = ReturnType<typeof createLogger>;

/** HTTP request logging with token/path sanitization. */
export function httpLogger(logger: Logger) {
  return pinoHttp({
    logger,
    redact: ["req.headers.authorization", "req.headers['x-chunk-sha256']", "res.headers['content-disposition']"],
    serializers: {
      req(req) {
        const out = pino.stdSerializers.req(req);
        const url = new URL(out.url ?? "/", "http://localhost");
        url.search = "";
        return { ...out, url: url.pathname, authorization: undefined };
      },
    },
  });
}