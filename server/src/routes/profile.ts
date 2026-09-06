import { Router, Response } from "express";
import bcrypt from "bcryptjs";
import { db } from "../db";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { UserRow } from "../types";
import { rateLimit } from "../middleware/rateLimit";
import { toSelfUser, sanitizeString } from "../utils/helpers";
import fs from "fs";
import path from "path";

const router = Router();

router.put("/", requireAuth, (req: AuthedRequest, res: Response) => {
  const userId = req.user!.userId;
  const bio = sanitizeString(req.body?.bio, 300);
  const avatar = sanitizeString(req.body?.avatar, 500);
  const usernameRaw = req.body?.username;

  const existing = db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId) as
    | UserRow
    | undefined;
  if (!existing) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  let username = existing.username;
  if (typeof usernameRaw === "string" && usernameRaw.trim() && usernameRaw.trim() !== existing.username) {
    const candidate = sanitizeString(usernameRaw, 20);
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(candidate)) {
      res.status(400).json({ error: "Invalid username format" });
      return;
    }
    const clash = db
      .prepare(`SELECT id FROM users WHERE username = ? AND id != ?`)
      .get(candidate, userId);
    if (clash) {
      res.status(409).json({ error: "Username already taken" });
      return;
    }
    username = candidate;
  }

  const firstName =
    typeof req.body?.firstName === "string" && req.body.firstName.trim()
      ? sanitizeString(req.body.firstName, 50)
      : existing.firstName;
  const lastName =
    typeof req.body?.lastName === "string" && req.body.lastName.trim()
      ? sanitizeString(req.body.lastName, 50)
      : existing.lastName;

  db.prepare(
    `UPDATE users SET bio = ?, avatar = COALESCE(NULLIF(?, ''), avatar), username = ?, firstName = ?, lastName = ? WHERE id = ?`
  ).run(bio, avatar, username, firstName, lastName, userId);

  const updated = db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId) as UserRow;
  res.json({ user: toSelfUser(updated) });
});

router.put("/password", requireAuth, rateLimit({ windowMs: 15 * 60 * 1000, max: 5, key: (req) => `password:${req.ip}:${req.user?.userId || "unknown"}` }), (req: AuthedRequest, res: Response) => {
  const userId = req.user!.userId;
  const currentPassword = typeof req.body?.currentPassword === "string" ? req.body.currentPassword : "";
  const newPassword = typeof req.body?.newPassword === "string" ? req.body.newPassword : "";

  if (!currentPassword || !newPassword) {
    res.status(400).json({ error: "Current and new password are required" });
    return;
  }
  if (newPassword.length < 6) {
    res.status(400).json({ error: "New password must be at least 6 characters" });
    return;
  }

  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId) as UserRow | undefined;
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  if (!bcrypt.compareSync(currentPassword, user.password)) {
    res.status(403).json({ error: "Current password is incorrect" });
    return;
  }

  const hashed = bcrypt.hashSync(newPassword, 10);
  db.prepare(`UPDATE users SET password = ? WHERE id = ?`).run(hashed, userId);
  db.prepare(`DELETE FROM sessions WHERE userId = ?`).run(userId);

  res.json({ success: true });
});

router.delete("/", requireAuth, (req: AuthedRequest, res: Response) => {
  const userId = req.user!.userId;
  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId) as UserRow | undefined;
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  const mediaDir = path.resolve(process.env.MEDIA_DIR || "./data/media");
  const mediaRows = db.prepare(`SELECT id FROM media_files WHERE senderId = ? OR receiverId = ?`).all(userId, userId) as Array<{ id: string }>;
  const deleteUser = db.transaction(() => db.prepare(`DELETE FROM users WHERE id = ?`).run(userId));
  deleteUser();
  for (const row of mediaRows) {
    try { fs.unlinkSync(path.join(mediaDir, `${row.id}.bin`)); } catch { /* file may already be absent */ }
  }
  res.json({ success: true });
});

export default router;
