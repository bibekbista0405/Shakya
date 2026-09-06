import { Router, Response } from "express";
import { db } from "../db";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { areFriends, isBlocked } from "../utils/helpers";

function isBlockedBetween(a: string, b: string): boolean { return isBlocked(a, b); }

const router = Router();

function validEcPublicKey(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 100 || value.length > 5000) return false;
  try {
    const parsed = JSON.parse(value);
    return parsed?.kty === "EC" && parsed?.crv === "P-256" && typeof parsed?.x === "string" && typeof parsed?.y === "string";
  } catch { return false; }
}

function validSignature(value: unknown): value is string {
  return typeof value === "string" && value.length >= 20 && value.length <= 1000;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,100}$/.test(value);
}

router.get("/me", requireAuth, (req: AuthedRequest, res: Response) => {
  const row = db.prepare(`SELECT publicKey, signingPublicKey, algorithm, version, updatedAt FROM user_crypto_keys WHERE userId = ?`).get(req.user!.userId) as any;
  const prekeys = db.prepare(`SELECT id, kind, publicKey, signature, createdAt, usedAt FROM crypto_prekeys WHERE userId = ? AND (kind = 'signed' OR usedAt IS NULL) ORDER BY createdAt DESC`).all(req.user!.userId);
  res.json({ key: row ? { ...row } : null, prekeys });
});

router.put("/me", requireAuth, (req: AuthedRequest, res: Response) => {
  const publicKey = req.body?.publicKey;
  if (!validEcPublicKey(publicKey)) return void res.status(400).json({ error: "Invalid ECDH public key" });
  const signingPublicKey = req.body?.signingPublicKey;
  if (signingPublicKey !== undefined && signingPublicKey !== null && !validEcPublicKey(signingPublicKey)) {
    return void res.status(400).json({ error: "Invalid signing public key" });
  }
  db.prepare(`INSERT INTO user_crypto_keys (userId, publicKey, signingPublicKey, algorithm, version) VALUES (?, ?, ?, 'ECDH-P256', 2)
    ON CONFLICT(userId) DO UPDATE SET publicKey=excluded.publicKey, signingPublicKey=excluded.signingPublicKey, algorithm=excluded.algorithm, version=2, updatedAt=datetime('now')`).run(req.user!.userId, publicKey, signingPublicKey ?? null);
  res.json({ key: { publicKey, signingPublicKey: signingPublicKey ?? null, algorithm: "ECDH-P256", version: 2 } });
});

router.put("/bundle", requireAuth, (req: AuthedRequest, res: Response) => {
  const { identityPublicKey, signingPublicKey, signedPrekey, oneTimePrekeys } = req.body ?? {};
  if (!validEcPublicKey(identityPublicKey) || !validEcPublicKey(signingPublicKey)) return void res.status(400).json({ error: "Invalid identity or signing key" });
  if (!signedPrekey || !validId(signedPrekey.id) || !validEcPublicKey(signedPrekey.publicKey) || !validSignature(signedPrekey.signature)) return void res.status(400).json({ error: "Invalid signed prekey" });
  if (!Array.isArray(oneTimePrekeys) || oneTimePrekeys.length > 100) return void res.status(400).json({ error: "Invalid one-time prekeys" });
  for (const key of oneTimePrekeys) if (!key || !validId(key.id) || !validEcPublicKey(key.publicKey)) return void res.status(400).json({ error: "Invalid one-time prekey" });

  const userId = req.user!.userId;
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO user_crypto_keys (userId, publicKey, signingPublicKey, algorithm, version) VALUES (?, ?, ?, 'ECDH-P256', 2)
      ON CONFLICT(userId) DO UPDATE SET publicKey=excluded.publicKey, signingPublicKey=excluded.signingPublicKey, version=2, updatedAt=datetime('now')`).run(userId, identityPublicKey, signingPublicKey);
    db.prepare(`INSERT INTO crypto_prekeys (id, userId, kind, publicKey, signature, usedAt) VALUES (?, ?, 'signed', ?, ?, NULL)
      ON CONFLICT(id) DO UPDATE SET publicKey=excluded.publicKey, signature=excluded.signature, usedAt=NULL`).run(signedPrekey.id, userId, signedPrekey.publicKey, signedPrekey.signature);
    const insert = db.prepare(`INSERT OR IGNORE INTO crypto_prekeys (id, userId, kind, publicKey) VALUES (?, ?, 'one_time', ?)`);
    for (const key of oneTimePrekeys) insert.run(key.id, userId, key.publicKey);
  });
  tx();
  res.json({ ok: true, oneTimePrekeysAccepted: oneTimePrekeys.length });
});

router.get("/bundle/:userId", requireAuth, (req: AuthedRequest, res: Response) => {
  const peerId = req.params.userId;
  if (!peerId || peerId === req.user!.userId) return void res.status(400).json({ error: "Invalid secure key target" });
  if (!areFriends(req.user!.userId, peerId) || isBlockedBetween(req.user!.userId, peerId)) {
    return void res.status(403).json({ error: "Secure key bundles are only available to friends" });
  }

  const legacy = db.prepare(`SELECT publicKey AS identityPublicKey, signingPublicKey, algorithm, version, updatedAt FROM user_crypto_keys WHERE userId = ?`).get(peerId) as any;
  if (legacy?.signingPublicKey) {
    const signedPrekey = db.prepare(`SELECT id, publicKey, signature, createdAt FROM crypto_prekeys WHERE userId = ? AND kind = 'signed' AND usedAt IS NULL ORDER BY createdAt DESC LIMIT 1`).get(peerId) as any;
    if (signedPrekey) {
      const oneTime = db.prepare(`SELECT id, publicKey FROM crypto_prekeys WHERE userId = ? AND kind = 'one_time' AND usedAt IS NULL ORDER BY createdAt ASC LIMIT 1`).get(peerId);
      return void res.json({ bundle: { ...legacy, signedPrekey, oneTimePrekey: oneTime ?? null } });
    }
  }

  // New device-first installs only populate device_crypto_keys. Expose the newest
  // active device as the compatibility bundle so old v2 callers do not receive 404.
  const device = db.prepare(`SELECT d.id AS deviceId, k.identityPublicKey, k.signingPublicKey, k.signedPrekeyId, k.signedPrekeyPublicKey, k.signedPrekeySignature, k.oneTimePrekeys, k.version, k.updatedAt
    FROM devices d JOIN device_crypto_keys k ON k.deviceId = d.id
    WHERE d.userId = ? AND d.revokedAt IS NULL ORDER BY d.lastSeenAt DESC LIMIT 1`).get(peerId) as any;
  if (!device) return void res.status(404).json({ error: "Secure key bundle unavailable. The user has not enabled secure messaging." });
  let oneTime: { id: string; publicKey: string } | null = null;
  try {
    const list = JSON.parse(device.oneTimePrekeys || "[]");
    if (Array.isArray(list)) oneTime = list.find((x: any) => x?.id && x?.publicKey) ?? null;
  } catch { oneTime = null; }
  res.json({ bundle: {
    identityPublicKey: device.identityPublicKey,
    signingPublicKey: device.signingPublicKey,
    algorithm: "ECDH-P256",
    version: device.version,
    updatedAt: device.updatedAt,
    signedPrekey: { id: device.signedPrekeyId, publicKey: device.signedPrekeyPublicKey, signature: device.signedPrekeySignature },
    oneTimePrekey: oneTime,
  }});
});

router.post("/bundle/:userId/consume", requireAuth, (req: AuthedRequest, res: Response) => {
  const id = req.body?.id;
  if (!validId(id)) return void res.status(400).json({ error: "Invalid prekey id" });
  if (!areFriends(req.user!.userId, req.params.userId) || isBlockedBetween(req.user!.userId, req.params.userId)) return void res.status(403).json({ error: "Secure prekeys are only available to friends" });
  const peerId = req.params.userId;
  const consume = db.transaction(() => {
    // Legacy account-level prekeys.
    const row = db.prepare(`SELECT id, publicKey FROM crypto_prekeys WHERE id = ? AND userId = ? AND kind = 'one_time' AND usedAt IS NULL`).get(id, peerId) as any;
    if (row) {
      const result = db.prepare(`UPDATE crypto_prekeys SET usedAt = datetime('now') WHERE id = ? AND userId = ? AND kind = 'one_time' AND usedAt IS NULL`).run(id, peerId);
      if (result.changes === 1) return row;
    }

    // Device-first installs keep one-time prekeys inside device_crypto_keys.
    // Older clients may still call /bundle/:userId/consume, so consume the
    // matching key from an active device bundle as a compatibility path.
    const devices = db.prepare(`SELECT deviceId, oneTimePrekeys FROM device_crypto_keys k JOIN devices d ON d.id = k.deviceId WHERE k.userId = ? AND d.revokedAt IS NULL`).all(peerId) as Array<{ deviceId: string; oneTimePrekeys: string }>;
    for (const device of devices) {
      let keys: Array<{ id: string; publicKey: string }> = [];
      try { keys = JSON.parse(device.oneTimePrekeys || '[]'); } catch { keys = []; }
      const index = keys.findIndex((key) => key?.id === id);
      if (index < 0) continue;
      const [prekey] = keys.splice(index, 1);
      db.prepare(`UPDATE device_crypto_keys SET oneTimePrekeys = ?, updatedAt = datetime('now') WHERE deviceId = ? AND userId = ?`).run(JSON.stringify(keys), device.deviceId, peerId);
      return prekey;
    }
    return null;
  });
  const row = consume();
  if (!row) return void res.status(404).json({ error: "Prekey unavailable" });
  res.json({ prekey: row });
});


router.post("/device/:deviceId/consume", requireAuth, (req: AuthedRequest, res: Response) => {
  const deviceId = req.params.deviceId;
  const prekeyId = req.body?.id;
  if (!validId(deviceId) || !validId(prekeyId)) return void res.status(400).json({ error: "Invalid device or prekey id" });

  const owner = db.prepare(`SELECT userId FROM devices WHERE id = ? AND revokedAt IS NULL`).get(deviceId) as { userId: string } | undefined;
  if (!owner) return void res.status(404).json({ error: "Device not found" });
  if (owner.userId !== req.user!.userId && (!areFriends(req.user!.userId, owner.userId) || isBlockedBetween(req.user!.userId, owner.userId))) {
    return void res.status(403).json({ error: "You can only establish secure sessions with friends" });
  }

  const consume = db.transaction(() => {
    const row = db.prepare(`SELECT oneTimePrekeys FROM device_crypto_keys WHERE deviceId = ? AND userId = ?`).get(deviceId, owner.userId) as { oneTimePrekeys: string } | undefined;
    if (!row) return null;
    let keys: Array<{ id: string; publicKey: string }> = [];
    try { keys = JSON.parse(row.oneTimePrekeys || "[]"); } catch { keys = []; }
    const index = keys.findIndex((key) => key?.id === prekeyId);
    if (index < 0) return null;
    const [prekey] = keys.splice(index, 1);
    db.prepare(`UPDATE device_crypto_keys SET oneTimePrekeys = ?, updatedAt = datetime('now') WHERE deviceId = ?`).run(JSON.stringify(keys), deviceId);
    return prekey;
  });

  const prekey = consume();
  if (!prekey) return void res.status(404).json({ error: "One-time prekey unavailable" });
  res.json({ prekey, deviceId, userId: owner.userId });
});

router.get("/:userId", requireAuth, (req: AuthedRequest, res: Response) => {
  if (req.params.userId !== req.user!.userId && (!areFriends(req.user!.userId, req.params.userId) || isBlockedBetween(req.user!.userId, req.params.userId))) return void res.status(403).json({ error: "Secure keys are only available to friends" });
  const row = db.prepare(`SELECT publicKey, signingPublicKey, algorithm, version, updatedAt FROM user_crypto_keys WHERE userId = ?`).get(req.params.userId) as any;
  if (!row) return void res.status(404).json({ error: "This user has not enabled secure messaging on this device" });
  res.json({ key: row });
});

router.put("/device/bundle", requireAuth, (req: AuthedRequest, res: Response) => {
  const deviceId = req.user!.deviceId;
  const { identityPublicKey, signingPublicKey, signedPrekey, oneTimePrekeys } = req.body ?? {};
  if (!deviceId) return void res.status(400).json({ error: "This session is not device-bound" });
  if (!validEcPublicKey(identityPublicKey) || !validEcPublicKey(signingPublicKey)) return void res.status(400).json({ error: "Invalid identity or signing key" });
  if (!signedPrekey || !validId(signedPrekey.id) || !validEcPublicKey(signedPrekey.publicKey) || !validSignature(signedPrekey.signature)) return void res.status(400).json({ error: "Invalid signed prekey" });
  if (!Array.isArray(oneTimePrekeys) || oneTimePrekeys.length > 100) return void res.status(400).json({ error: "Invalid one-time prekeys" });
  for (const key of oneTimePrekeys) if (!key || !validId(key.id) || !validEcPublicKey(key.publicKey)) return void res.status(400).json({ error: "Invalid one-time prekey" });
  const device = db.prepare(`SELECT id FROM devices WHERE id = ? AND userId = ? AND revokedAt IS NULL`).get(deviceId, req.user!.userId);
  if (!device) return void res.status(403).json({ error: "Device is not active" });
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO device_crypto_keys (deviceId,userId,identityPublicKey,signingPublicKey,signedPrekeyId,signedPrekeyPublicKey,signedPrekeySignature,oneTimePrekeys,version,updatedAt) VALUES (?,?,?,?,?,?,?,?,1,datetime('now'))
      ON CONFLICT(deviceId) DO UPDATE SET identityPublicKey=excluded.identityPublicKey, signingPublicKey=excluded.signingPublicKey, signedPrekeyId=excluded.signedPrekeyId, signedPrekeyPublicKey=excluded.signedPrekeyPublicKey, signedPrekeySignature=excluded.signedPrekeySignature, oneTimePrekeys=excluded.oneTimePrekeys, version=1, updatedAt=datetime('now')`).run(deviceId, req.user!.userId, identityPublicKey, signingPublicKey, signedPrekey.id, signedPrekey.publicKey, signedPrekey.signature, JSON.stringify(oneTimePrekeys));
    // Keep the account-level bundle populated for v2/legacy clients and older
    // chat code. The device bundle remains the source of truth for multi-device.
    db.prepare(`INSERT INTO user_crypto_keys (userId,publicKey,signingPublicKey,algorithm,version) VALUES (?,?,?,'ECDH-P256',2)
      ON CONFLICT(userId) DO UPDATE SET publicKey=excluded.publicKey, signingPublicKey=excluded.signingPublicKey, algorithm=excluded.algorithm, version=2, updatedAt=datetime('now')`).run(req.user!.userId, identityPublicKey, signingPublicKey);
    db.prepare(`INSERT INTO crypto_prekeys (id,userId,kind,publicKey,signature,usedAt) VALUES (?,?, 'signed',?,?,NULL)
      ON CONFLICT(id) DO UPDATE SET publicKey=excluded.publicKey, signature=excluded.signature, usedAt=NULL`).run(signedPrekey.id, req.user!.userId, signedPrekey.publicKey, signedPrekey.signature);
    const insertLegacy = db.prepare(`INSERT OR IGNORE INTO crypto_prekeys (id,userId,kind,publicKey) VALUES (?,?, 'one_time',?)`);
    for (const key of oneTimePrekeys) insertLegacy.run(key.id, req.user!.userId, key.publicKey);
  });
  tx();
  res.json({ ok: true, deviceId, oneTimePrekeysAccepted: oneTimePrekeys.length });
});

router.get("/devices/:userId", requireAuth, (req: AuthedRequest, res: Response) => {
  if (req.params.userId !== req.user!.userId && (!areFriends(req.user!.userId, req.params.userId) || isBlockedBetween(req.user!.userId, req.params.userId))) return void res.status(403).json({ error: "Device keys are only available to friends" });
  const rows = db.prepare(`SELECT d.id AS deviceId, d.name, d.lastSeenAt, k.identityPublicKey, k.signingPublicKey, k.signedPrekeyId, k.signedPrekeyPublicKey, k.signedPrekeySignature, k.oneTimePrekeys, k.version, k.updatedAt FROM devices d JOIN device_crypto_keys k ON k.deviceId=d.id WHERE d.userId=? AND d.revokedAt IS NULL ORDER BY d.lastSeenAt DESC`).all(req.params.userId) as any[];
  const devices = rows.map((row) => ({ ...row, oneTimePrekeys: JSON.parse(row.oneTimePrekeys || "[]").filter((x: any) => x && x.id && x.publicKey) }));
  res.json({ devices });
});

export default router;
