import { Router, Response } from "express";
import fs from "fs";
import path from "path";
import { db } from "../db";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { areFriends, isBlocked } from "../utils/helpers";

const router = Router();
const MEDIA_DIR = path.resolve(process.env.MEDIA_DIR || "./data/media");
const MAX_BYTES = Math.min(Math.max(Number(process.env.MAX_MEDIA_BYTES) || 50 * 1024 * 1024, 1 * 1024 * 1024), 50 * 1024 * 1024);
fs.mkdirSync(MEDIA_DIR, { recursive: true });

function safeId(value: string): boolean { return /^[a-zA-Z0-9_-]{16,100}$/.test(value); }
function filePath(id: string): string { return path.join(MEDIA_DIR, `${id}.bin`); }

router.post("/:mediaId", requireAuth, (req: AuthedRequest, res: Response) => {
  const userId = req.user!.userId;
  const mediaId = req.params.mediaId;
  const receiverId = typeof req.headers["x-sakhya-receiver"] === "string" ? req.headers["x-sakhya-receiver"] : "";
  if (!safeId(mediaId) || !receiverId || !areFriends(userId, receiverId) || isBlocked(userId, receiverId)) { res.status(403).json({ error: "Invalid secure media target" }); return; }
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
  if (!body.length) { res.status(400).json({ error: "Encrypted media is empty" }); return; }
  if (body.length > MAX_BYTES) { res.status(413).json({ error: "Encrypted media is too large" }); return; }

  const existing = db.prepare(`SELECT id FROM media_files WHERE id = ?`).get(mediaId);
  if (existing) { res.status(409).json({ error: "Media upload already exists" }); return; }
  fs.writeFileSync(filePath(mediaId), body, { flag: "wx" });
  db.prepare(`INSERT INTO media_files (id, senderId, receiverId, byteLength) VALUES (?, ?, ?, ?)` ).run(mediaId, userId, receiverId, body.length);
  res.status(201).json({ mediaId, bytes: body.length });
});

router.get("/:mediaId", requireAuth, (req: AuthedRequest, res: Response) => {
  const userId = req.user!.userId;
  const mediaId = req.params.mediaId;
  if (!safeId(mediaId)) { res.status(400).json({ error: "Invalid media id" }); return; }
  const media = db.prepare(`SELECT * FROM media_files WHERE id = ? AND (senderId = ? OR receiverId = ?)`).get(mediaId, userId, userId) as { id:string; senderId:string; receiverId:string; byteLength:number } | undefined;
  if (!media) { res.status(404).json({ error: "Media not found" }); return; }
  if (media.receiverId === userId && isBlocked(media.senderId, userId)) { res.status(410).json({ error: "Media access has been revoked" }); return; }
  const message = db.prepare(`SELECT viewOnce, viewedAt, deletedAt, expiresAt FROM messages WHERE mediaId = ? ORDER BY createdAt DESC LIMIT 1`).get(mediaId) as { viewOnce:number; viewedAt:string|null; deletedAt:string|null; expiresAt:string|null } | undefined;
  if (message?.deletedAt || (message?.expiresAt && message.expiresAt <= new Date().toISOString().replace("T", " ").slice(0,19))) {
    deleteMediaFile(mediaId);
    res.status(410).json({ error: "Media has expired" }); return;
  }
  if (message?.viewOnce === 1 && media.receiverId === userId) {
    const claimed = db.prepare(`UPDATE messages SET viewedAt = datetime('now') WHERE mediaId = ? AND receiverId = ? AND viewOnce = 1 AND viewedAt IS NULL AND deletedAt IS NULL`).run(mediaId, userId);
    if (claimed.changes !== 1) { res.status(410).json({ error: "View-once media has already been opened" }); return; }
  }
  const file = filePath(mediaId);
  if (!fs.existsSync(file)) { res.status(404).json({ error: "Media file is unavailable" }); return; }
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Content-Length", String(media.byteLength));
  res.sendFile(file);
});

router.delete("/:mediaId", requireAuth, (req: AuthedRequest, res: Response) => {
  const mediaId = req.params.mediaId;
  const userId = req.user!.userId;
  const media = db.prepare(`SELECT id FROM media_files WHERE id = ? AND senderId = ?`).get(mediaId, userId);
  if (!media) { res.status(404).json({ error: "Media not found" }); return; }
  try { fs.unlinkSync(filePath(mediaId)); } catch {}
  db.prepare(`DELETE FROM media_files WHERE id = ?`).run(mediaId);
  res.json({ ok: true });
});

export function deleteMediaFile(mediaId: string): void {
  if (!safeId(mediaId)) return;
  try { fs.unlinkSync(filePath(mediaId)); } catch {}
  db.prepare(`DELETE FROM media_files WHERE id = ?`).run(mediaId);
}

export default router;
