import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { db } from "../db";
import { AuthPayload } from "../types";

const configuredSecret = process.env.JWT_SECRET?.trim();
if (process.env.NODE_ENV === "production" && (!configuredSecret || configuredSecret.length < 32)) {
  throw new Error("JWT_SECRET must be set to a random value of at least 32 characters in production");
}
const JWT_SECRET = configuredSecret || "sakhya-development-secret-change-before-production-2026";

export interface AuthedRequest extends Request { user?: AuthPayload; }

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return void res.status(401).json({ error: "Missing or invalid authorization header" });
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET) as AuthPayload;
    const session = payload.sessionId
      ? db.prepare(`SELECT s.id, s.userId, s.deviceId, s.expiresAt, s.revokedAt, d.revokedAt AS deviceRevokedAt FROM sessions s LEFT JOIN devices d ON d.id = s.deviceId WHERE s.id = ? AND s.token = ?`).get(payload.sessionId, token) as any
      : db.prepare(`SELECT id, userId, deviceId, expiresAt, revokedAt FROM sessions WHERE token = ?`).get(token) as any;
    if (!session || session.userId !== payload.userId || session.revokedAt || session.deviceRevokedAt || new Date(session.expiresAt).getTime() <= Date.now()) {
      return void res.status(401).json({ error: "Session revoked or expired" });
    }
    db.prepare(`UPDATE sessions SET lastSeenAt = datetime('now') WHERE id = ?`).run(session.id);
    if (session.deviceId) db.prepare(`UPDATE devices SET lastSeenAt = datetime('now') WHERE id = ? AND revokedAt IS NULL`).run(session.deviceId);
    req.user = { ...payload, sessionId: session.id, deviceId: session.deviceId ?? payload.deviceId };
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

export function signToken(payload: AuthPayload): string {
  const expiresIn = process.env.JWT_EXPIRES_IN || "7d";
  return jwt.sign(payload, JWT_SECRET, { expiresIn } as jwt.SignOptions);
}
export { JWT_SECRET };
