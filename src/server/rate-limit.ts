import { rateLimit } from "express-rate-limit";

export interface RateLimits {
  general: number;
  chunks: number;
  sessions: number;
}

function make(windowMs: number, limit: number): ReturnType<typeof rateLimit> {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.ip ?? "unknown",
    handler: (_req, res) => {
      res.status(429).json({ error: { code: "rate_limited", message: "too many requests — slow down" } });
    },
  });
}

export function createRateLimiters(limits: RateLimits) {
  return {
    general: make(15 * 60 * 1000, limits.general),
    sessions: make(60 * 1000, limits.sessions),
    chunks: make(60 * 1000, limits.chunks),
  };
}