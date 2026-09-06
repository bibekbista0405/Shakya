import { Request, Response, NextFunction } from "express";

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

export function rateLimit(options: { windowMs: number; max: number; key?: (req: Request) => string; message?: string }) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const key = options.key ? options.key(req) : `${req.ip}:${req.path}`;
    const existing = buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      return next();
    }
    existing.count += 1;
    if (existing.count > options.max) {
      res.setHeader("Retry-After", Math.ceil((existing.resetAt - now) / 1000));
      res.status(429).json({ error: options.message || "Too many requests. Please try again later." });
      return;
    }
    next();
  };
}

export function clearRateLimitKey(prefix: string): void {
  for (const key of buckets.keys()) if (key.startsWith(prefix)) buckets.delete(key);
}
