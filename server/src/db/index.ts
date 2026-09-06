import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const DB_PATH = process.env.DB_PATH || "./data/sakhya.db";
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

export function initDb(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      avatar TEXT NOT NULL DEFAULT '',
      bio TEXT NOT NULL DEFAULT '',
      firstName TEXT NOT NULL DEFAULT '',
      lastName TEXT NOT NULL DEFAULT '',
      dateOfBirth TEXT NOT NULL DEFAULT '',
      gender TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT UNIQUE NOT NULL,
      deviceId TEXT,
      deviceName TEXT NOT NULL DEFAULT 'Unknown device',
      userAgent TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      lastSeenAt TEXT NOT NULL DEFAULT (datetime('now')),
      expiresAt TEXT NOT NULL,
      revokedAt TEXT
    );

    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT 'Unknown device',
      userAgent TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      lastSeenAt TEXT NOT NULL DEFAULT (datetime('now')),
      revokedAt TEXT,
      UNIQUE(userId, id)
    );

    CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(userId, revokedAt, lastSeenAt);

    CREATE TABLE IF NOT EXISTS friend_requests (
      id TEXT PRIMARY KEY,
      senderId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      receiverId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | rejected
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(senderId, receiverId)
    );

    CREATE TABLE IF NOT EXISTS friends (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      friendId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(userId, friendId)
    );

    CREATE TABLE IF NOT EXISTS blocked_users (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      blockedId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(userId, blockedId)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      senderId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      receiverId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'sent', -- sent | delivered | seen
      replyToId TEXT REFERENCES messages(id) ON DELETE SET NULL,
      reactions TEXT NOT NULL DEFAULT '{}',
      editedAt TEXT,
      deletedAt TEXT,
      expiresAt TEXT,
      viewOnce INTEGER NOT NULL DEFAULT 0,
      viewedAt TEXT,
      mediaId TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS media_files (
      id TEXT PRIMARY KEY,
      senderId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      receiverId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      byteLength INTEGER NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS calls (
      id TEXT PRIMARY KEY,
      callerId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      receiverId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL, -- audio | video
      status TEXT NOT NULL, -- missed | completed | rejected | outgoing_cancelled
      duration INTEGER NOT NULL DEFAULT 0,
      startedAt TEXT NOT NULL DEFAULT (datetime('now')),
      endedAt TEXT
    );


    CREATE TABLE IF NOT EXISTS user_crypto_keys (
      userId TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      publicKey TEXT NOT NULL,
      signingPublicKey TEXT,
      algorithm TEXT NOT NULL DEFAULT 'ECDH-P256',
      version INTEGER NOT NULL DEFAULT 2,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS crypto_prekeys (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, -- signed | one_time
      publicKey TEXT NOT NULL,
      signature TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      usedAt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_crypto_prekeys_user_kind ON crypto_prekeys(userId, kind, usedAt);
    CREATE TABLE IF NOT EXISTS device_crypto_keys (
      deviceId TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
      userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      identityPublicKey TEXT NOT NULL,
      signingPublicKey TEXT NOT NULL,
      signedPrekeyId TEXT NOT NULL,
      signedPrekeyPublicKey TEXT NOT NULL,
      signedPrekeySignature TEXT NOT NULL,
      oneTimePrekeys TEXT NOT NULL DEFAULT '[]',
      version INTEGER NOT NULL DEFAULT 1,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_device_crypto_user ON device_crypto_keys(userId);


    CREATE TABLE IF NOT EXISTS privacy_settings (
      userId TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      readReceipts INTEGER NOT NULL DEFAULT 1,
      typingIndicators INTEGER NOT NULL DEFAULT 1,
      onlineStatus INTEGER NOT NULL DEFAULT 1,
      lastSeenVisibility TEXT NOT NULL DEFAULT 'friends',
      messagePreview INTEGER NOT NULL DEFAULT 0,
      updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL, -- message | friend_request | friend_accept | missed_call | incoming_call
      content TEXT NOT NULL,
      relatedId TEXT,
      isRead INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(senderId, receiverId);
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(userId);
    CREATE INDEX IF NOT EXISTS idx_calls_users ON calls(callerId, receiverId);
    CREATE INDEX IF NOT EXISTS idx_blocked_user ON blocked_users(userId);
  `);

  // Lightweight migration path for databases created before these columns existed,
  // so upgrading an existing local install doesn't require deleting data.
  const existingCols = (db.prepare(`PRAGMA table_info(users)`).all() as { name: string }[]).map(
    (c) => c.name
  );
  const migrations: [string, string][] = [
    ["firstName", "ALTER TABLE users ADD COLUMN firstName TEXT NOT NULL DEFAULT ''"],
    ["lastName", "ALTER TABLE users ADD COLUMN lastName TEXT NOT NULL DEFAULT ''"],
    ["dateOfBirth", "ALTER TABLE users ADD COLUMN dateOfBirth TEXT NOT NULL DEFAULT ''"],
    ["gender", "ALTER TABLE users ADD COLUMN gender TEXT NOT NULL DEFAULT ''"],
  ];
  for (const [col, sql] of migrations) {
    if (!existingCols.includes(col)) {
      db.exec(sql);
    }
  }

  const sessionCols = (db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]).map((c) => c.name);
  const sessionMigrations: [string, string][] = [
    ["deviceId", "ALTER TABLE sessions ADD COLUMN deviceId TEXT"],
    ["deviceName", "ALTER TABLE sessions ADD COLUMN deviceName TEXT NOT NULL DEFAULT 'Unknown device'"],
    ["userAgent", "ALTER TABLE sessions ADD COLUMN userAgent TEXT NOT NULL DEFAULT ''"],
    ["lastSeenAt", "ALTER TABLE sessions ADD COLUMN lastSeenAt TEXT NOT NULL DEFAULT ''"],
    ["revokedAt", "ALTER TABLE sessions ADD COLUMN revokedAt TEXT"],
  ];
  for (const [col, sql] of sessionMigrations) if (!sessionCols.includes(col)) db.exec(sql);
  db.exec(`UPDATE sessions SET lastSeenAt = COALESCE(NULLIF(lastSeenAt, ''), createdAt) WHERE lastSeenAt IS NULL OR lastSeenAt = ''`);

  const messageCols = (db.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[]).map((c) => c.name);
  const messageMigrations: [string, string][] = [
    ["replyToId", "ALTER TABLE messages ADD COLUMN replyToId TEXT REFERENCES messages(id) ON DELETE SET NULL"],
    ["reactions", "ALTER TABLE messages ADD COLUMN reactions TEXT NOT NULL DEFAULT '{}'"],
    ["editedAt", "ALTER TABLE messages ADD COLUMN editedAt TEXT"],
    ["deletedAt", "ALTER TABLE messages ADD COLUMN deletedAt TEXT"],
    ["expiresAt", "ALTER TABLE messages ADD COLUMN expiresAt TEXT"],
    ["viewOnce", "ALTER TABLE messages ADD COLUMN viewOnce INTEGER NOT NULL DEFAULT 0"],
    ["viewedAt", "ALTER TABLE messages ADD COLUMN viewedAt TEXT"],
  ];
  for (const [col, sql] of messageMigrations) {
    if (!messageCols.includes(col)) {
      db.exec(sql);
    }
  }

  const mediaMessageCols = (db.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[]).map((c) => c.name);
  if (!mediaMessageCols.includes("mediaId")) db.exec(`ALTER TABLE messages ADD COLUMN mediaId TEXT`);

  const cryptoKeyCols = (db.prepare(`PRAGMA table_info(user_crypto_keys)`).all() as { name: string }[]).map((c) => c.name);
  if (!cryptoKeyCols.includes("signingPublicKey")) {
    db.exec(`ALTER TABLE user_crypto_keys ADD COLUMN signingPublicKey TEXT`);
  }

  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_receiver_status ON messages(receiverId, status);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_expires ON messages(expiresAt);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_reply ON messages(replyToId);`);
}

