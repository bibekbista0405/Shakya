import { Router, Response } from "express";
import { db } from "../db";
import { requireAuth, AuthedRequest } from "../middleware/auth";

const router = Router();

router.get("/", requireAuth, (req: AuthedRequest, res: Response) => {
  const devices = db.prepare(`SELECT id, name, userAgent, createdAt, lastSeenAt, revokedAt FROM devices WHERE userId = ? ORDER BY revokedAt IS NULL DESC, lastSeenAt DESC`).all(req.user!.userId);
  res.json({ devices });
});

router.delete("/:deviceId", requireAuth, (req: AuthedRequest, res: Response) => {
  const result = db.prepare(`UPDATE devices SET revokedAt = datetime('now') WHERE id = ? AND userId = ? AND revokedAt IS NULL`).run(req.params.deviceId, req.user!.userId);
  db.prepare(`UPDATE sessions SET revokedAt = datetime('now') WHERE deviceId = ? AND userId = ? AND revokedAt IS NULL`).run(req.params.deviceId, req.user!.userId);
  if (!result.changes) return void res.status(404).json({ error: "Device not found or already revoked" });
  res.json({ ok: true });
});

router.post("/revoke-others", requireAuth, (req: AuthedRequest, res: Response) => {
  const current = req.user!.sessionId;
  const tx = db.transaction(() => {
    db.prepare(`UPDATE sessions SET revokedAt = datetime('now') WHERE userId = ? AND id != ? AND revokedAt IS NULL`).run(req.user!.userId, current ?? "");
    db.prepare(`UPDATE devices SET revokedAt = datetime('now') WHERE userId = ? AND id NOT IN (SELECT deviceId FROM sessions WHERE id = ? AND deviceId IS NOT NULL) AND revokedAt IS NULL`).run(req.user!.userId, current ?? "");
  });
  tx();
  res.json({ ok: true });
});

export default router;
