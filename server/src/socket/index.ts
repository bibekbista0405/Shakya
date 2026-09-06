import { Server, Socket } from "socket.io";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { db } from "../db";
import { JWT_SECRET } from "../middleware/auth";
import {
  AuthPayload,
  MessageRow,
  UserRow,
  RTCSessionDescriptionInit,
  RTCIceCandidateInit,
} from "../types";
import { onlineUsers, setIo, emitToUser, isUserOnline } from "./registry";
import { areFriends, createNotification, toPublicUser, sanitizeString, isBlocked } from "../utils/helpers";
import { deleteMediaFile } from "../routes/media";

interface AuthedSocket extends Socket {
  userId?: string;
  username?: string;
}

const activeCalls = new Map<
  string,
  { callerId: string; receiverId: string; type: "audio" | "video"; startedAt: number; connected: boolean }
>();

const callRate = new Map<string, { count: number; resetAt: number }>();
const CALL_WINDOW_MS = 60_000;
const MAX_CALLS_PER_MINUTE = 8;

function allowCallAction(userId: string): boolean {
  const now = Date.now();
  const current = callRate.get(userId);
  if (!current || current.resetAt <= now) { callRate.set(userId, { count: 1, resetAt: now + CALL_WINDOW_MS }); return true; }
  if (current.count >= MAX_CALLS_PER_MINUTE) return false;
  current.count += 1;
  return true;
}

function isCallParticipant(call: { callerId: string; receiverId: string }, userId: string): boolean {
  return call.callerId === userId || call.receiverId === userId;
}

function isValidRtcDescription(value: unknown): value is RTCSessionDescriptionInit {
  if (!value || typeof value !== "object") return false;
  const v = value as any;
  return (v.type === "offer" || v.type === "answer") && typeof v.sdp === "string" && v.sdp.length > 0 && v.sdp.length <= 200_000;
}

function isValidIceCandidate(value: unknown): value is RTCIceCandidateInit {
  if (!value || typeof value !== "object") return false;
  const v = value as any;
  return typeof v.candidate === "string" && v.candidate.length <= 10_000 && (v.sdpMid == null || typeof v.sdpMid === "string") && (v.sdpMLineIndex == null || Number.isInteger(v.sdpMLineIndex));
}

const ALLOWED_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "😡", "🔥", "👏"];

type StoredMessageRow = Omit<MessageRow, "reactions"> & { reactions: string };

function getMessage(id: string): MessageRow | undefined {
  const row = db
    .prepare(
      `SELECT m.*, r.content AS replyToContent, r.senderId AS replyToSenderId
       FROM messages m
       LEFT JOIN messages r ON r.id = m.replyToId
       WHERE m.id = ?`
    )
    .get(id) as StoredMessageRow | undefined;
  if (!row) return undefined;
  return { ...row, reactions: parseReactions(row.reactions) } as MessageRow;
}

function parseReactions(value: unknown): Record<string, string[]> {
  try {
    const parsed = JSON.parse(typeof value === "string" ? value : "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, users]) => Array.isArray(users)) as [string, string[]][]
    );
  } catch {
    return {};
  }
}

function sendMessageToParticipants(message: MessageRow, event = "message_updated"): void {
  emitToUser(message.senderId, event, message);
  if (message.receiverId !== message.senderId) emitToUser(message.receiverId, event, message);
}

function purgeExpiredMessages(): void {
  const expired = db.prepare(`SELECT id, mediaId FROM messages WHERE expiresAt IS NOT NULL AND expiresAt <= datetime('now') AND deletedAt IS NULL`).all() as { id: string; mediaId: string | null }[];
  if (!expired.length) return;
  db.prepare(`UPDATE messages SET content = '', deletedAt = datetime('now'), editedAt = NULL WHERE expiresAt IS NOT NULL AND expiresAt <= datetime('now') AND deletedAt IS NULL`).run();
  for (const row of expired) { if (row.mediaId) deleteMediaFile(row.mediaId); const message = getMessage(row.id); if (message) sendMessageToParticipants(message); }
}

export function initSocket(io: Server): void {
  setIo(io);
  const expiryTimer = setInterval(purgeExpiredMessages, 30_000);
  expiryTimer.unref?.();

  io.use((socket: AuthedSocket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error("Authentication required"));
    try {
      const payload = jwt.verify(token, JWT_SECRET) as AuthPayload;
      if (!payload.sessionId) return next(new Error("Session expired; sign in again"));
      const session = db.prepare(`SELECT s.id, s.userId, s.deviceId, s.expiresAt, s.revokedAt, d.revokedAt AS deviceRevokedAt FROM sessions s LEFT JOIN devices d ON d.id = s.deviceId WHERE s.id = ? AND s.token = ?`).get(payload.sessionId, token) as { id: string; userId: string; deviceId: string | null; expiresAt: string; revokedAt: string | null; deviceRevokedAt: string | null } | undefined;
      if (!session || session.userId !== payload.userId || session.revokedAt || session.deviceRevokedAt || new Date(session.expiresAt).getTime() <= Date.now()) {
        return next(new Error("Session is no longer active"));
      }
      socket.userId = payload.userId;
      socket.username = payload.username;
      next();
    } catch {
      next(new Error("Invalid token"));
    }
  });

  io.on("connection", (socket: AuthedSocket) => {
    const userId = socket.userId!;

    if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
    onlineUsers.get(userId)!.add(socket.id);
    broadcastPresence(userId, true);
    socket.emit("online_users", { userIds: Array.from(onlineUsers.keys()) });

    socket.on(
      "send_message",
      (
        data: { receiverId: string; content: string; replyToId?: string | null; expiresIn?: number; viewOnce?: boolean; mediaId?: string | null },
        ack?: (response: { ok: boolean; error?: string; message?: MessageRow }) => void,
      ) => {
        const fail = (error: string) => {
          socket.emit("error_message", { error });
          ack?.({ ok: false, error });
        };
        const receiverId = data?.receiverId;
        const content = sanitizeString(data?.content, 30000);
        const replyToId = typeof data?.replyToId === "string" ? data.replyToId : null;
        const expiresIn = Number.isFinite(data?.expiresIn) ? Math.min(Math.max(Math.floor(Number(data.expiresIn)), 0), 7 * 24 * 60 * 60) : 0;
        const viewOnce = data?.viewOnce === true;
        const mediaId = typeof data?.mediaId === "string" ? data.mediaId : null;
        if (!receiverId || !content) { fail("Message cannot be empty."); return; }
        if (!content.startsWith("sakhya:e2ee:v1:") && !content.startsWith("sakhya:e2ee:v2:") && !content.startsWith("sakhya:e2ee:v3:")) {
          fail("Secure messaging is required for new messages");
          return;
        }
        if (!areFriends(userId, receiverId)) {
          fail("You can only message friends");
          return;
        }
        if (mediaId) {
          const media = db.prepare(`SELECT id, senderId, receiverId FROM media_files WHERE id = ?`).get(mediaId) as { id: string; senderId: string; receiverId: string } | undefined;
          if (!media || media.senderId !== userId || media.receiverId !== receiverId) {
            fail("Invalid encrypted media attachment");
            return;
          }
        }

        if (isBlocked(userId, receiverId)) {
          fail("You cannot message this user");
          return;
        }

        if (replyToId) {
          const reply = db.prepare(`SELECT senderId, receiverId FROM messages WHERE id = ?`).get(replyToId) as
            | { senderId: string; receiverId: string }
            | undefined;
          if (!reply || !((reply.senderId === userId && reply.receiverId === receiverId) || (reply.senderId === receiverId && reply.receiverId === userId))) {
            fail("Invalid reply target");
            return;
          }
        }

        const id = uuidv4();
        const receiverOnline = isUserOnline(receiverId);
        const status: MessageRow["status"] = receiverOnline ? "delivered" : "sent";

        db.prepare(
          `INSERT INTO messages (id, senderId, receiverId, content, status, replyToId, reactions, expiresAt, viewOnce, mediaId)
           VALUES (?, ?, ?, ?, ?, ?, '{}', CASE WHEN ? > 0 THEN datetime('now', ? || ' seconds') ELSE NULL END, ?, ?)`
        ).run(id, userId, receiverId, content, status, replyToId, expiresIn, String(expiresIn), viewOnce ? 1 : 0, mediaId);

        const message = getMessage(id);
        if (!message) { fail("Message was saved but could not be loaded."); return; }
        socket.emit("receive_message", message);
        emitToUser(receiverId, "receive_message", message);
        ack?.({ ok: true, message });

        const sender = db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId) as UserRow;
        const notif = createNotification(
          receiverId,
          "message",
          `${sender.username} sent you a secure message`,
          id
        );
        emitToUser(receiverId, "notification", notif);
      }
    );

    socket.on("claim_view_once", (data: { messageId: string }) => {
      const messageId = data?.messageId;
      if (!messageId) return;
      const existing = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(messageId) as MessageRow | undefined;
      if (!existing || existing.receiverId !== userId || existing.viewOnce !== 1 || existing.viewedAt || existing.deletedAt) return;
      db.prepare(`UPDATE messages SET viewedAt = datetime('now') WHERE id = ? AND viewedAt IS NULL AND deletedAt IS NULL`).run(messageId);
      const message = getMessage(messageId);
      if (message) {
        emitToUser(message.senderId, "message_updated", message);
        emitToUser(message.receiverId, "message_updated", { ...message, content: "" });
      }
    });

    socket.on("edit_message", (data: { messageId: string; content: string }) => {
      const messageId = data?.messageId;
      const content = sanitizeString(data?.content, 30000);
      if (!messageId || !content) return;
      if (!content.startsWith("sakhya:e2ee:v1:") && !content.startsWith("sakhya:e2ee:v2:") && !content.startsWith("sakhya:e2ee:v3:")) return;
      const existing = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(messageId) as MessageRow | undefined;
      if (!existing || existing.senderId !== userId) return;
      if (existing.deletedAt) return;
      db.prepare(`UPDATE messages SET content = ?, editedAt = datetime('now') WHERE id = ?`).run(content, messageId);
      const message = getMessage(messageId);
      if (message) sendMessageToParticipants(message);
    });

    socket.on("delete_message", (data: { messageId: string }) => {
      const messageId = data?.messageId;
      if (!messageId) return;
      const existing = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(messageId) as MessageRow | undefined;
      if (!existing || existing.senderId !== userId) return;
      db.prepare(`UPDATE messages SET content = '', deletedAt = datetime('now'), editedAt = NULL WHERE id = ?`).run(messageId);
      if (existing.mediaId) deleteMediaFile(existing.mediaId);
      const message = getMessage(messageId);
      if (message) sendMessageToParticipants(message);
    });

    socket.on("react_message", (data: { messageId: string; emoji: string }) => {
      const messageId = data?.messageId;
      const emoji = data?.emoji;
      if (!messageId || !ALLOWED_REACTIONS.includes(emoji)) return;
      const existing = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(messageId) as StoredMessageRow | undefined;
      if (!existing || existing.deletedAt || !((existing.senderId === userId) || (existing.receiverId === userId))) return;
      if (!areFriends(existing.senderId, existing.receiverId)) return;

      const reactions = parseReactions(existing.reactions);
      const users = new Set(reactions[emoji] || []);
      if (users.has(userId)) users.delete(userId);
      else users.add(userId);
      if (users.size) reactions[emoji] = Array.from(users);
      else delete reactions[emoji];
      db.prepare(`UPDATE messages SET reactions = ? WHERE id = ?`).run(JSON.stringify(reactions), messageId);
      const message = getMessage(messageId);
      if (message) sendMessageToParticipants(message);
    });

    socket.on("typing", (data: { receiverId: string }) => {
      if (!data?.receiverId || !areFriends(userId, data.receiverId)) return;
      emitToUser(data.receiverId, "typing", { senderId: userId });
    });

    socket.on("stop_typing", (data: { receiverId: string }) => {
      if (!data?.receiverId || !areFriends(userId, data.receiverId)) return;
      emitToUser(data.receiverId, "stop_typing", { senderId: userId });
    });

    socket.on("message_seen", (data: { friendId: string }) => {
      const friendId = data?.friendId;
      if (!friendId || !areFriends(userId, friendId)) return;
      db.prepare(
        `UPDATE messages SET status = 'seen' WHERE senderId = ? AND receiverId = ? AND status != 'seen'`
      ).run(friendId, userId);
      emitToUser(friendId, "message_seen", { by: userId });
    });

    socket.on("call_user", (data: { receiverId: string; type: "audio" | "video"; offer: RTCSessionDescriptionInit }) => {
      const { receiverId, type, offer } = data || {};
      if (!receiverId || receiverId === userId || !isValidRtcDescription(offer) || offer.type !== "offer" || (type !== "audio" && type !== "video")) return;
      if (!allowCallAction(userId)) { socket.emit("call_failed", { reason: "Too many call attempts. Please wait a moment." }); return; }
      if (!areFriends(userId, receiverId)) {
        socket.emit("error_message", { error: "You can only call friends" });
        return;
      }
      if (isBlocked(userId, receiverId)) {
        socket.emit("error_message", { error: "You cannot call this user" });
        return;
      }
      for (const active of activeCalls.values()) {
        if (isCallParticipant(active, userId)) { socket.emit("call_failed", { reason: "You are already in a call." }); return; }
      }
      if (!isUserOnline(receiverId)) {
        socket.emit("call_failed", { reason: "User is offline" });
        return;
      }

      const callId = uuidv4();
      activeCalls.set(callId, { callerId: userId, receiverId, type, startedAt: Date.now(), connected: false });
      db.prepare(`INSERT INTO calls (id, callerId, receiverId, type, status, duration) VALUES (?, ?, ?, ?, 'missed', 0)`).run(
        callId, userId, receiverId, type
      );

      const caller = db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId) as UserRow;
      socket.emit("call_initiated", { callId, receiverId, type });
      emitToUser(receiverId, "incoming_call", { callId, type, offer, caller: toPublicUser(caller) });
      const notif = createNotification(receiverId, "incoming_call", `Incoming ${type} call from ${caller.username}`, callId);
      emitToUser(receiverId, "notification", notif);
    });

    socket.on("call_accepted", (data: { callId: string; answer: RTCSessionDescriptionInit }) => {
      const call = activeCalls.get(data?.callId);
      if (!call || call.receiverId !== userId || !isValidRtcDescription(data?.answer) || data.answer.type !== "answer") return;
      call.connected = true;
      call.startedAt = Date.now();
      db.prepare(`UPDATE calls SET status = 'completed' WHERE id = ? AND receiverId = ?`).run(data.callId, userId);
      emitToUser(call.callerId, "call_accepted", { callId: data.callId, answer: data.answer });
    });

    socket.on("call_rejected", (data: { callId: string }) => {
      const call = activeCalls.get(data?.callId);
      if (!call || call.receiverId !== userId) return;
      db.prepare(`UPDATE calls SET status = 'rejected', endedAt = datetime('now') WHERE id = ? AND receiverId = ?`).run(data.callId, userId);
      emitToUser(call.callerId, "call_rejected", { callId: data.callId });
      activeCalls.delete(data.callId);
    });

    socket.on("ice_candidate", (data: { callId: string; candidate: RTCIceCandidateInit; targetId: string }) => {
      const call = activeCalls.get(data?.callId);
      if (!call || !isCallParticipant(call, userId) || !isValidIceCandidate(data?.candidate)) return;
      const otherId = call.callerId === userId ? call.receiverId : call.callerId;
      if (data.targetId !== otherId) return;
      emitToUser(otherId, "ice_candidate", { callId: data.callId, candidate: data.candidate });
    });

    socket.on("end_call", (data: { callId: string }) => {
      const call = activeCalls.get(data?.callId);
      if (!call || !isCallParticipant(call, userId)) return;
      const otherId = call.callerId === userId ? call.receiverId : call.callerId;
      const durationSec = call.connected ? Math.round((Date.now() - call.startedAt) / 1000) : 0;
      const finalStatus = call.connected ? "completed" : "outgoing_cancelled";
      db.prepare(`UPDATE calls SET status = ?, duration = ?, endedAt = datetime('now') WHERE id = ?`).run(finalStatus, durationSec, data.callId);

      if (!call.connected && userId === call.callerId) {
        const caller = db.prepare(`SELECT * FROM users WHERE id = ?`).get(call.callerId) as UserRow;
        const notif = createNotification(call.receiverId, "missed_call", `Missed ${call.type} call from ${caller.username}`, data.callId);
        emitToUser(call.receiverId, "notification", notif);
      }
      emitToUser(otherId, "call_ended", { callId: data.callId, duration: durationSec });
      activeCalls.delete(data.callId);
    });

    socket.on("disconnect", () => {
      const sockets = onlineUsers.get(userId);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          onlineUsers.delete(userId);
          broadcastPresence(userId, false);
          for (const [callId, call] of activeCalls.entries()) {
            if (call.callerId === userId || call.receiverId === userId) {
              const otherId = call.callerId === userId ? call.receiverId : call.callerId;
              const durationSec = call.connected ? Math.round((Date.now() - call.startedAt) / 1000) : 0;
              db.prepare(`UPDATE calls SET status = ?, duration = ?, endedAt = datetime('now') WHERE id = ?`).run(
                call.connected ? "completed" : "outgoing_cancelled", durationSec, callId
              );
              emitToUser(otherId, "call_ended", { callId, duration: durationSec });
              activeCalls.delete(callId);
            }
          }
        }
      }
    });
  });
}

function broadcastPresence(userId: string, online: boolean): void {
  const friends = db.prepare(`SELECT friendId FROM friends WHERE userId = ?`).all(userId) as { friendId: string }[];
  for (const f of friends) emitToUser(f.friendId, online ? "user_online" : "user_offline", { userId });
}
