import { Router, Response } from "express";
import { db } from "../db";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { MessageRow, UserRow } from "../types";
import { areFriends, toPublicUser } from "../utils/helpers";
import { isUserOnline } from "../socket/registry";
import { deleteMediaFile } from "./media";

const router = Router();
const MESSAGE_LIMIT = 100;

function purgeExpiredMessages(): void {
  const expired = db.prepare(
    `SELECT id, mediaId FROM messages
     WHERE expiresAt IS NOT NULL AND expiresAt <= datetime('now') AND deletedAt IS NULL`
  ).all() as Array<{ id: string; mediaId: string | null }>;
  if (!expired.length) return;

  db.prepare(`UPDATE messages SET content = '', deletedAt = COALESCE(deletedAt, datetime('now')), editedAt = NULL
             WHERE expiresAt IS NOT NULL AND expiresAt <= datetime('now') AND deletedAt IS NULL`).run();

  for (const row of expired) {
    if (row.mediaId) deleteMediaFile(row.mediaId);
  }
}

function parseReactions(value: unknown): Record<string, string[]> {
  try {
    const parsed = JSON.parse(typeof value === "string" ? value : "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, users]) => Array.isArray(users)) as [string, string[]][]
    );
  } catch { return {}; }
}

function normalizeMessage(row: MessageRow & { reactions?: unknown }, viewerId?: string): MessageRow {
  const normalized = { ...row, reactions: parseReactions(row.reactions) } as MessageRow;
  if (viewerId && normalized.viewOnce === 1 && normalized.viewedAt && normalized.receiverId === viewerId) normalized.content = "";
  return normalized;
}

router.get("/conversations", requireAuth, (req: AuthedRequest, res: Response) => {
  purgeExpiredMessages();
  const userId = req.user!.userId;
  const friendRows = db.prepare(`SELECT u.* FROM friends f JOIN users u ON u.id = f.friendId WHERE f.userId = ?`).all(userId) as UserRow[];
  const conversations = friendRows.map((friend) => {
    const lastMessage = db.prepare(`SELECT m.*, r.content AS replyToContent, r.senderId AS replyToSenderId FROM messages m LEFT JOIN messages r ON r.id = m.replyToId WHERE (m.senderId = ? AND m.receiverId = ?) OR (m.senderId = ? AND m.receiverId = ?) ORDER BY m.createdAt DESC LIMIT 1`).get(userId, friend.id, friend.id, userId) as MessageRow | undefined;
    const preview = lastMessage ? normalizeMessage(lastMessage, userId) : null;
    if (preview && preview.content && (preview.content.startsWith("sakhya:e2ee:v1:") || preview.content.startsWith("sakhya:e2ee:v2:") || preview.content.startsWith("sakhya:e2ee:v3:"))) {
      preview.content = preview.mediaId ? "🔒 Encrypted attachment" : "🔒 Encrypted message";
    }
    const unreadCount = (db.prepare(`SELECT COUNT(*) as c FROM messages WHERE senderId = ? AND receiverId = ? AND status != 'seen' AND deletedAt IS NULL`).get(friend.id, userId) as { c: number }).c;
    return { friend: { ...toPublicUser(friend), online: isUserOnline(friend.id) }, lastMessage: preview, unreadCount };
  });
  conversations.sort((a, b) => (b.lastMessage?.createdAt ?? "").localeCompare(a.lastMessage?.createdAt ?? ""));
  res.json({ conversations });
});

router.post("/:friendId/view-once/:messageId/claim", requireAuth, (req: AuthedRequest, res: Response) => {
  purgeExpiredMessages();
  const userId = req.user!.userId;
  const friendId = req.params.friendId;
  const messageId = req.params.messageId;
  if (!areFriends(userId, friendId)) { res.status(403).json({ error: "You can only access messages with friends" }); return; }
  const message = db.prepare(`SELECT id, senderId, receiverId, viewOnce, viewedAt, deletedAt FROM messages WHERE id = ?`).get(messageId) as { id: string; senderId: string; receiverId: string; viewOnce: number; viewedAt: string | null; deletedAt: string | null } | undefined;
  if (!message || message.senderId !== friendId || message.receiverId !== userId || message.viewOnce !== 1 || message.viewedAt || message.deletedAt) {
    res.status(409).json({ error: "This view-once message is no longer available" }); return;
  }
  const claimed = db.prepare(`UPDATE messages SET viewedAt = datetime('now') WHERE id = ? AND senderId = ? AND receiverId = ? AND viewOnce = 1 AND viewedAt IS NULL AND deletedAt IS NULL`).run(messageId, friendId, userId);
  if (claimed.changes !== 1) { res.status(409).json({ error: "This view-once message has already been opened" }); return; }
  res.json({ ok: true });
});

router.get("/:friendId", requireAuth, (req: AuthedRequest, res: Response) => {
  purgeExpiredMessages();
  const userId = req.user!.userId;
  const friendId = req.params.friendId;
  const before = typeof req.query.before === "string" ? req.query.before : null;
  const beforeId = typeof req.query.beforeId === "string" ? req.query.beforeId : null;
  const requestedLimit = Number(req.query.limit);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.floor(requestedLimit), 20), MESSAGE_LIMIT) : MESSAGE_LIMIT;
  if (!areFriends(userId, friendId)) { res.status(403).json({ error: "You can only view messages with friends" }); return; }
  const params: (string | number)[] = [userId, friendId, friendId, userId];
  let timeClause = "";
  if (before && beforeId) { timeClause = " AND (m.createdAt < ? OR (m.createdAt = ? AND m.id < ?))"; params.push(before, before, beforeId); }
  else if (before) { timeClause = " AND m.createdAt < ?"; params.push(before); }
  params.push(limit);
  const rows = db.prepare(`SELECT m.*, r.content AS replyToContent, r.senderId AS replyToSenderId FROM messages m LEFT JOIN messages r ON r.id = m.replyToId WHERE ((m.senderId = ? AND m.receiverId = ?) OR (m.senderId = ? AND m.receiverId = ?)) ${timeClause} ORDER BY m.createdAt DESC, m.id DESC LIMIT ?`).all(...params) as MessageRow[];
  const messages = rows.reverse().map((row) => normalizeMessage(row, userId));
  const privacy = db.prepare(`SELECT readReceipts FROM privacy_settings WHERE userId = ?`).get(userId) as { readReceipts?: number } | undefined;
  if (privacy?.readReceipts !== 0) db.prepare(`UPDATE messages SET status = 'seen' WHERE senderId = ? AND receiverId = ? AND status != 'seen'`).run(friendId, userId);
  res.json({ messages, hasMore: rows.length === limit, nextBefore: rows.length === limit ? rows[rows.length - 1]?.createdAt ?? null : null, nextBeforeId: rows.length === limit ? rows[rows.length - 1]?.id ?? null : null });
});

export default router;
