import { Router, Response } from "express";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";
import { db } from "../db";
import { signToken, requireAuth, AuthedRequest } from "../middleware/auth";
import { UserRow } from "../types";
import { rateLimit } from "../middleware/rateLimit";
import {
  toPublicUser,
  isValidEmail,
  isValidUsername,
  sanitizeString,
  generateUsernameFrom,
  toSelfUser,
} from "../utils/helpers";

const router = Router();

function deviceInput(req: any): { deviceId: string; deviceName: string; userAgent: string } {
  const rawId = typeof req.body?.deviceId === "string" ? req.body.deviceId : "";
  const deviceId = /^[A-Za-z0-9_-]{16,100}$/.test(rawId) ? rawId : uuidv4().replace(/-/g, "");
  const rawName = typeof req.body?.deviceName === "string" ? req.body.deviceName.trim().slice(0, 80) : "";
  const ua = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"].slice(0, 500) : "";
  return { deviceId, deviceName: rawName || "Web browser", userAgent: ua };
}

function createSession(userId: string, username: string, req: any) {
  let { deviceId, deviceName, userAgent } = deviceInput(req);
  const sessionId = uuidv4();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  // Device IDs are globally unique because devices.id is the primary key.
  // A browser may previously have generated an ID while another account was
  // signed in, so never try to attach that ID to a different user. Generate a
  // fresh ID instead of letting SQLite throw UNIQUE constraint failed.
  const existing = db.prepare(`SELECT userId, revokedAt FROM devices WHERE id = ?`).get(deviceId) as
    | { userId: string; revokedAt: string | null }
    | undefined;
  if (existing && existing.userId !== userId) {
    deviceId = uuidv4().replace(/-/g, "");
  }

  db.prepare(`INSERT INTO devices (id, userId, name, userAgent, revokedAt, lastSeenAt) VALUES (?, ?, ?, ?, NULL, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, userAgent=excluded.userAgent, revokedAt=NULL, lastSeenAt=datetime('now')`).run(deviceId, userId, deviceName, userAgent);
  const token = signToken({ userId, username, sessionId, deviceId });
  db.prepare(`INSERT INTO sessions (id, userId, token, deviceId, deviceName, userAgent, expiresAt, lastSeenAt, revokedAt) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), NULL)`).run(sessionId, userId, token, deviceId, deviceName, userAgent, expiresAt);
  return { token, sessionId, deviceId };
}

const VALID_GENDERS = ["male", "female", "custom", "prefer_not_to_say", ""];

router.post("/register", rateLimit({ windowMs: 15 * 60 * 1000, max: 8, key: (req) => `register:${req.ip}` }), (req, res: Response) => {
  const firstName = sanitizeString(req.body?.firstName, 50);
  const lastName = sanitizeString(req.body?.lastName, 50);
  const dateOfBirth = sanitizeString(req.body?.dateOfBirth, 10);
  const genderRaw = sanitizeString(req.body?.gender, 20).toLowerCase();
  const email = sanitizeString(req.body?.email, 100).toLowerCase();
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  // Kept for backward compatibility with API clients that still send a username directly.
  const explicitUsername = sanitizeString(req.body?.username, 20);

  if (!firstName || !lastName) {
    res.status(400).json({ error: "First and last name are required" });
    return;
  }
  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }
  if (!isValidEmail(email)) {
    res.status(400).json({ error: "Invalid email address" });
    return;
  }
  if (password.length < 6) {
    res.status(400).json({ error: "Password must be at least 6 characters" });
    return;
  }
  if (genderRaw && !VALID_GENDERS.includes(genderRaw)) {
    res.status(400).json({ error: "Invalid gender value" });
    return;
  }
  if (dateOfBirth && !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) {
    res.status(400).json({ error: "Invalid date of birth format" });
    return;
  }

  let username = explicitUsername;
  if (username && !isValidUsername(username)) {
    res.status(400).json({ error: "Username must be 3-20 characters (letters, numbers, underscore)" });
    return;
  }
  if (!username) {
    username = generateUsernameFrom(firstName, lastName);
  }

  const existing = db
    .prepare(`SELECT id FROM users WHERE email = ? OR username = ?`)
    .get(email, username);
  if (existing) {
    res.status(409).json({ error: "Username or email already in use" });
    return;
  }

  const id = uuidv4();
  const hashed = bcrypt.hashSync(password, 10);
  const avatar = `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(username)}`;

  db.prepare(
    `INSERT INTO users (id, username, email, password, avatar, bio, firstName, lastName, dateOfBirth, gender)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, username, email, hashed, avatar, "", firstName, lastName, dateOfBirth, genderRaw);

  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as UserRow;
  const session = createSession(user.id, user.username, req);
  res.status(201).json({ user: toSelfUser(user), token: session.token, deviceId: session.deviceId });
});

router.post("/login", rateLimit({ windowMs: 15 * 60 * 1000, max: 12, key: (req) => `login:${req.ip}:${String(req.body?.email || "").toLowerCase().slice(0, 100)}` }), (req, res: Response) => {
  const email = sanitizeString(req.body?.email, 100).toLowerCase();
  const password = typeof req.body?.password === "string" ? req.body.password : "";

  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }

  const user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email) as UserRow | undefined;
  if (!user) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  const valid = bcrypt.compareSync(password, user.password);
  if (!valid) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  const session = createSession(user.id, user.username, req);
  res.json({ user: toSelfUser(user), token: session.token, deviceId: session.deviceId });
});

router.post("/logout", requireAuth, (req: AuthedRequest, res: Response) => {
  const header = req.headers.authorization;
  const token = header ? header.slice(7) : "";
  db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
  res.json({ success: true });
});

router.get("/me", requireAuth, (req: AuthedRequest, res: Response) => {
  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.user!.userId) as
    | UserRow
    | undefined;
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  res.json({ user: toSelfUser(user) });
});

export default router;
