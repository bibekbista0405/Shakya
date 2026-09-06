const DB_NAME = "sakhya-crypto";
const STORE = "keys";
const IDENTITY_ID = "identity";
const SIGNING_ID = "signing";
const BUNDLE_ID = "bundle";
const SELF_KEY_ID = "self-copy-key";
const SESSION_PREFIX = "session:";
const DEVICE_SESSION_SEPARATOR = "::device::";

export type JwkPair = { publicKey: JsonWebKey; privateKey: JsonWebKey };
export type StoredBundle = {
  signing: JwkPair;
  signedPrekey: JwkPair & { id: string; signature: string };
  oneTimePrekeys: Array<JwkPair & { id: string }>;
};
export type RemoteKeyBundle = {
  identityPublicKey: string;
  signingPublicKey: string;
  signedPrekey: { id: string; publicKey: string; signature: string };
  oneTimePrekey: { id: string; publicKey: string } | null;
};

export type RemoteDeviceBundle = {
  deviceId: string;
  name?: string;
  identityPublicKey: string;
  signingPublicKey: string;
  signedPrekey: { id: string; publicKey: string; signature: string };
  oneTimePrekeys: Array<{ id: string; publicKey: string }>;
};

type MultiDeviceEnvelope = {
  v: 3;
  kind: "multi-device";
  senderDeviceId: string;
  senderCopy: string;
  devices: Array<{ deviceId: string; ciphertext: string }>;
};

type SessionState = {
  version: 2;
  sessionId: string;
  peerId: string;
  peerIdentityPublicKey: JsonWebKey;
  sendChainKey: string;
  recvChainKey: string;
  sendCounter: number;
  recvCounter: number;
  createdAt: number;
  updatedAt: number;
  initialSendChainKey: string;
  initialRecvChainKey: string;
  rootKey: string;
  dhSelf: JwkPair;
  dhRemote: JsonWebKey;
  previousSendCount: number;
  skippedMessageKeys: Record<string, string>;
};

type EnvelopeV2 = {
  v: 2;
  type: "session" | "message";
  sid: string;
  n: number;
  iv: string;
  ct: string;
  identityPublicKey?: JsonWebKey;
  ephemeralPublicKey?: JsonWebKey;
  signedPrekeyId?: string;
  oneTimePrekeyId?: string | null;
  ratchetPublicKey?: JsonWebKey;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 3);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readStore<T>(id: string): Promise<T | undefined> {
  const db = await openDb();
  const value = await new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return value;
}

async function writeStore(id: string, value: unknown): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function deleteStore(id: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function importEcdhPublic(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, []);
}

async function importEcdhPrivate(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
}

async function importEcdsaPublic(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
}

async function getStoredPair(): Promise<CryptoKeyPair | null> {
  const pair = await readStore<JwkPair>(IDENTITY_ID);
  if (!pair) return null;
  try {
    return { publicKey: await importEcdhPublic(pair.publicKey), privateKey: await importEcdhPrivate(pair.privateKey) };
  } catch {
    return null;
  }
}

async function storePair(pair: CryptoKeyPair): Promise<void> {
  const [publicKey, privateKey] = await Promise.all([
    crypto.subtle.exportKey("jwk", pair.publicKey),
    crypto.subtle.exportKey("jwk", pair.privateKey),
  ]);
  await writeStore(IDENTITY_ID, { publicKey, privateKey });
}

export async function getOrCreateIdentityKey(): Promise<CryptoKeyPair> {
  if (typeof window === "undefined") throw new Error("Encryption is only available in the browser");
  const existing = await getStoredPair();
  if (existing) return existing;
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  await storePair(pair);
  return pair;
}

export async function getPublicKeyJwk(): Promise<JsonWebKey> {
  const pair = await getOrCreateIdentityKey();
  return crypto.subtle.exportKey("jwk", pair.publicKey);
}

async function getOrCreateSigningKey(): Promise<CryptoKeyPair> {
  const stored = await readStore<JwkPair>(SIGNING_ID);
  if (stored) {
    try {
      return {
        publicKey: await importEcdsaPublic(stored.publicKey),
        privateKey: await crypto.subtle.importKey("jwk", stored.privateKey, { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]),
      };
    } catch { /* regenerate below */ }
  }
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const [publicKey, privateKey] = await Promise.all([
    crypto.subtle.exportKey("jwk", pair.publicKey),
    crypto.subtle.exportKey("jwk", pair.privateKey),
  ]);
  await writeStore(SIGNING_ID, { publicKey, privateKey });
  return pair;
}

function stableJwk(jwk: JsonWebKey): string {
  return JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
}

function bytesToBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(binary);
}

function base64ToBytes(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function utf8(value: string): Uint8Array { return new TextEncoder().encode(value); }
function randomId(): string { return crypto.randomUUID().replace(/-/g, ""); }

async function hmac(keyBytes: ArrayBuffer, data: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, utf8(data));
}

async function hkdf(input: ArrayBuffer, saltText: string, infoText: string, length = 32): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", input, "HKDF", false, ["deriveBits"]);
  return crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: utf8(saltText), info: utf8(infoText) },
    key,
    length * 8,
  );
}

async function deriveDh(privateKey: CryptoKey, publicJwk: JsonWebKey): Promise<ArrayBuffer> {
  return crypto.subtle.deriveBits({ name: "ECDH", public: await importEcdhPublic(publicJwk) }, privateKey, 256);
}

async function combineDh(parts: ArrayBuffer[]): Promise<ArrayBuffer> {
  const total = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { total.set(new Uint8Array(part), offset); offset += part.byteLength; }
  return crypto.subtle.digest("SHA-256", total);
}
async function rootKdf(rootKeyB64: string, dhOutput: ArrayBuffer, label: string): Promise<{ rootKey: string; chainKey: string }> {
  const root = base64ToBytes(rootKeyB64);
  const input = new Uint8Array(root.byteLength + dhOutput.byteLength);
  input.set(new Uint8Array(root), 0);
  input.set(new Uint8Array(dhOutput), root.byteLength);
  const material = await hkdf(input.buffer, "Sakhya Double Ratchet v1", label, 64);
  return { rootKey: bytesToBase64(material.slice(0, 32)), chainKey: bytesToBase64(material.slice(32, 64)) };
}
async function generateRatchetPair(): Promise<JwkPair> {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  return { publicKey: await crypto.subtle.exportKey("jwk", pair.publicKey), privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey) };
}
function sameJwk(a: JsonWebKey, b: JsonWebKey): boolean { return stableJwk(a) === stableJwk(b); }
async function importDhPair(pair: JwkPair): Promise<CryptoKeyPair> {
  return { publicKey: await importEcdhPublic(pair.publicKey), privateKey: await importEcdhPrivate(pair.privateKey) };
}

async function deriveMessageKey(chainKeyB64: string): Promise<{ messageKey: CryptoKey; nextChainKey: string }> {
  const chain = base64ToBytes(chainKeyB64);
  const messageRaw = await hmac(chain, "Sakhya message key v2");
  const nextRaw = await hmac(chain, "Sakhya chain key v2");
  const messageKey = await crypto.subtle.importKey("raw", messageRaw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  return { messageKey, nextChainKey: bytesToBase64(nextRaw) };
}

async function ensureStoredBundle(): Promise<StoredBundle> {
  const existing = await readStore<StoredBundle>(BUNDLE_ID);
  if (existing?.signedPrekey?.signature && existing.oneTimePrekeys?.length >= 10) return existing;

  const signing = await getOrCreateSigningKey();
  const signedPrekey = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const signedPublic = await crypto.subtle.exportKey("jwk", signedPrekey.publicKey);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    signing.privateKey,
    utf8(stableJwk(signedPublic)),
  );
  const signedPair = {
    publicKey: signedPublic,
    privateKey: await crypto.subtle.exportKey("jwk", signedPrekey.privateKey),
    id: randomId(),
    signature: bytesToBase64(signature),
  };

  const oneTimePrekeys: StoredBundle["oneTimePrekeys"] = [];
  for (let i = 0; i < 20; i++) {
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
    oneTimePrekeys.push({
      publicKey: await crypto.subtle.exportKey("jwk", pair.publicKey),
      privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey),
      id: randomId(),
    });
  }

  const stored: StoredBundle = {
    signing: {
      publicKey: await crypto.subtle.exportKey("jwk", signing.publicKey),
      privateKey: await crypto.subtle.exportKey("jwk", signing.privateKey),
    },
    signedPrekey: signedPair,
    oneTimePrekeys,
  };
  await writeStore(BUNDLE_ID, stored);
  return stored;
}

export async function getKeyBundleForUpload() {
  const identity = await getPublicKeyJwk();
  const bundle = await ensureStoredBundle();
  return {
    identityPublicKey: JSON.stringify(identity),
    signingPublicKey: JSON.stringify(bundle.signing.publicKey),
    signedPrekey: { id: bundle.signedPrekey.id, publicKey: JSON.stringify(bundle.signedPrekey.publicKey), signature: bundle.signedPrekey.signature },
    oneTimePrekeys: bundle.oneTimePrekeys.map((key) => ({ id: key.id, publicKey: JSON.stringify(key.publicKey) })),
  };
}

async function getOrCreateSelfCopyKey(): Promise<CryptoKey> {
  const stored = await readStore<JsonWebKey>(SELF_KEY_ID);
  if (stored) {
    try { return await crypto.subtle.importKey("jwk", stored, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]); } catch { /* regenerate */ }
  }
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]) as CryptoKey;
  await writeStore(SELF_KEY_ID, await crypto.subtle.exportKey("jwk", key));
  return key;
}

async function encryptSelfCopy(plaintext: string): Promise<string> {
  const key = await getOrCreateSelfCopyKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8("sakhya:self-copy:v1") }, key, utf8(plaintext));
  return `sakhya:self-copy:v1:${JSON.stringify({ iv: bytesToBase64(iv.buffer), ct: bytesToBase64(ct) })}`;
}

async function decryptSelfCopy(value: string): Promise<string> {
  if (!value.startsWith("sakhya:self-copy:v1:")) throw new Error("Invalid sender copy");
  const parsed = JSON.parse(value.slice("sakhya:self-copy:v1:".length));
  const key = await getOrCreateSelfCopyKey();
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(base64ToBytes(parsed.iv)), additionalData: utf8("sakhya:self-copy:v1") }, key, base64ToBytes(parsed.ct));
  return new TextDecoder().decode(plain);
}

export async function verifySignedPrekey(signingPublicJwk: JsonWebKey, signedPrekeyJwk: JsonWebKey, signature: string): Promise<boolean> {
  const key = await importEcdsaPublic(signingPublicJwk);
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, new Uint8Array(base64ToBytes(signature)), utf8(stableJwk(signedPrekeyJwk)));
}

async function saveSession(session: SessionState): Promise<void> {
  await writeStore(`${SESSION_PREFIX}${session.peerId}`, session);
}

async function getSession(peerId: string): Promise<SessionState | undefined> {
  return readStore<SessionState>(`${SESSION_PREFIX}${peerId}`);
}

function sessionKeyFor(peerId: string): string { return `${SESSION_PREFIX}${peerId}`; }

async function establishInitiatorSession(peerId: string, bundle: RemoteKeyBundle): Promise<{ session: SessionState; envelopeHeader: EnvelopeV2 }> {
  const identity = await getOrCreateIdentityKey();
  const identityPublic = await crypto.subtle.exportKey("jwk", identity.publicKey);
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const ephemeralPublic = await crypto.subtle.exportKey("jwk", ephemeral.publicKey);
  const remoteIdentity = JSON.parse(bundle.identityPublicKey) as JsonWebKey;
  const remoteSigned = JSON.parse(bundle.signedPrekey.publicKey) as JsonWebKey;
  const remoteOneTime = bundle.oneTimePrekey ? JSON.parse(bundle.oneTimePrekey.publicKey) as JsonWebKey : null;

  const parts = [
    await deriveDh(identity.privateKey, remoteSigned),
    await deriveDh(ephemeral.privateKey, remoteIdentity),
    await deriveDh(ephemeral.privateKey, remoteSigned),
  ];
  if (remoteOneTime) parts.push(await deriveDh(ephemeral.privateKey, remoteOneTime));
  const master = await combineDh(parts);
  const send = await hkdf(master, "Sakhya X3DH v2", "initiator-send", 32);
  const recv = await hkdf(master, "Sakhya X3DH v2", "responder-send", 32);
  const session: SessionState = {
    version: 2,
    sessionId: randomId(),
    peerId,
    peerIdentityPublicKey: remoteIdentity,
    sendChainKey: bytesToBase64(send),
    recvChainKey: bytesToBase64(recv),
    initialSendChainKey: bytesToBase64(send),
    initialRecvChainKey: bytesToBase64(recv),
    rootKey: bytesToBase64(master),
    dhSelf: { publicKey: ephemeralPublic, privateKey: await crypto.subtle.exportKey("jwk", ephemeral.privateKey) },
    dhRemote: remoteSigned,
    previousSendCount: 0,
    skippedMessageKeys: {},
    sendCounter: 0,
    recvCounter: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await saveSession(session);
  return {
    session,
    envelopeHeader: {
      v: 2,
      type: "session",
      sid: session.sessionId,
      n: 0,
      iv: "",
      ct: "",
      identityPublicKey: identityPublic,
      ephemeralPublicKey: ephemeralPublic,
      signedPrekeyId: bundle.signedPrekey.id,
      oneTimePrekeyId: bundle.oneTimePrekey?.id ?? null,
      ratchetPublicKey: ephemeralPublic,
    },
  };
}

async function establishResponderSession(peerId: string, envelope: EnvelopeV2, expectedBundle: StoredBundle): Promise<SessionState> {
  if (!envelope.identityPublicKey || !envelope.ephemeralPublicKey || !envelope.signedPrekeyId) throw new Error("Invalid secure session envelope");
  if (envelope.signedPrekeyId !== expectedBundle.signedPrekey.id) throw new Error("Secure prekey has changed; start a new secure session");

  const remoteIdentity = envelope.identityPublicKey;
  const remoteEphemeral = envelope.ephemeralPublicKey;
  const signedPrivate = await importEcdhPrivate(expectedBundle.signedPrekey.privateKey);
  const identity = await getOrCreateIdentityKey();
  const parts = [
    await deriveDh(signedPrivate, remoteIdentity),
    await deriveDh(identity.privateKey, remoteEphemeral),
    await deriveDh(signedPrivate, remoteEphemeral),
  ];

  if (envelope.oneTimePrekeyId) {
    const otp = expectedBundle.oneTimePrekeys.find((item) => item.id === envelope.oneTimePrekeyId);
    if (!otp) throw new Error("One-time prekey is unavailable on this device");
    parts.push(await deriveDh(await importEcdhPrivate(otp.privateKey), remoteEphemeral));
    expectedBundle.oneTimePrekeys = expectedBundle.oneTimePrekeys.filter((item) => item.id !== envelope.oneTimePrekeyId);
    await writeStore(BUNDLE_ID, expectedBundle);
  }

  const master = await combineDh(parts);
  const recv = await hkdf(master, "Sakhya X3DH v2", "initiator-send", 32);
  const initialSend = await hkdf(master, "Sakhya X3DH v2", "responder-send", 32);
  const newSelf = await generateRatchetPair();
  const newSelfCrypto = await importDhPair(newSelf);
  const sendDh = await deriveDh(newSelfCrypto.privateKey, remoteEphemeral);
  const sendStep = await rootKdf(bytesToBase64(master), sendDh, "send");
  const session: SessionState = {
    version: 2,
    sessionId: envelope.sid,
    peerId,
    peerIdentityPublicKey: remoteIdentity,
    sendChainKey: sendStep.chainKey,
    recvChainKey: bytesToBase64(recv),
    initialSendChainKey: bytesToBase64(initialSend),
    initialRecvChainKey: bytesToBase64(recv),
    rootKey: sendStep.rootKey,
    dhSelf: newSelf,
    dhRemote: remoteEphemeral,
    previousSendCount: 0,
    skippedMessageKeys: {},
    sendCounter: 0,
    recvCounter: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await saveSession(session);
  return session;
}

async function deriveMessageKeyAt(chainKeyB64: string, counter: number): Promise<CryptoKey> {
  let chain = chainKeyB64;
  for (let i = 0; i < counter; i++) chain = (await deriveMessageKey(chain)).nextChainKey;
  return (await deriveMessageKey(chain)).messageKey;
}

export async function decryptHistoryForPeer<T extends { content: string }>(peerId: string, messages: T[], bundle: RemoteKeyBundle): Promise<T[]> {
  const result: T[] = [];
  for (const message of messages) {
    try { result.push({ ...message, content: await decryptForPeer(peerId, message.content, bundle) }); }
    catch { result.push({ ...message, content: "Unable to decrypt this message." }); }
  }
  return result;
}

async function encryptWithChain(plaintext: string, session: SessionState, header: EnvelopeV2): Promise<{ value: string; session: SessionState }> {
  const { messageKey, nextChainKey } = await deriveMessageKey(session.sendChainKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aadHeader = { v: header.v, type: header.type, sid: header.sid, n: header.n, ratchetPublicKey: header.ratchetPublicKey ?? null };
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(JSON.stringify(aadHeader)) }, messageKey, utf8(plaintext));
  const envelope: EnvelopeV2 = { ...header, iv: bytesToBase64(iv.buffer), ct: bytesToBase64(ciphertext) };
  const next = { ...session, sendChainKey: nextChainKey, sendCounter: session.sendCounter + 1, updatedAt: Date.now() };
  await saveSession(next);
  return { value: `sakhya:e2ee:v2:${btoa(JSON.stringify(envelope))}`, session: next };
}

async function decryptWithChain(value: string, session: SessionState, envelope: EnvelopeV2): Promise<{ plaintext: string; session: SessionState }> {
  let working = { ...session, skippedMessageKeys: { ...session.skippedMessageKeys } };
  const remoteRatchet = envelope.ratchetPublicKey;
  if (!remoteRatchet) throw new Error("Secure ratchet key missing");

  if (!sameJwk(remoteRatchet, session.dhRemote)) {
    if (envelope.n > session.recvCounter && envelope.n - session.recvCounter <= 64) {
      let chain = session.recvChainKey;
      for (let i = session.recvCounter; i < envelope.n; i++) {
        const skipped = await deriveMessageKey(chain);
        working.skippedMessageKeys[`${session.sessionId}:${i}`] = bytesToBase64(await crypto.subtle.exportKey("raw", skipped.messageKey));
        chain = skipped.nextChainKey;
      }
    }
    const currentSelf = await importDhPair(session.dhSelf);
    const receiveDh = await deriveDh(currentSelf.privateKey, remoteRatchet);
    const receiveStep = await rootKdf(session.rootKey, receiveDh, "receive");
    const newSelf = await generateRatchetPair();
    const newSelfCrypto = await importDhPair(newSelf);
    const sendDh = await deriveDh(newSelfCrypto.privateKey, remoteRatchet);
    const sendStep = await rootKdf(receiveStep.rootKey, sendDh, "send");
    working = {
      ...working,
      rootKey: sendStep.rootKey,
      dhSelf: newSelf,
      dhRemote: remoteRatchet,
      recvChainKey: receiveStep.chainKey,
      sendChainKey: sendStep.chainKey,
      previousSendCount: session.sendCounter,
      recvCounter: 0,
      sendCounter: 0,
      updatedAt: Date.now(),
    };
  }

  const skippedId = `${working.sessionId}:${envelope.n}`;
  let messageKey: CryptoKey;
  if (working.skippedMessageKeys[skippedId]) {
    messageKey = await crypto.subtle.importKey("raw", base64ToBytes(working.skippedMessageKeys[skippedId]), { name: "AES-GCM" }, false, ["decrypt"]);
    delete working.skippedMessageKeys[skippedId];
  } else {
    if (envelope.n < working.recvCounter) throw new Error("Replay or already-consumed secure message");
    if (envelope.n - working.recvCounter > 64) throw new Error("Secure message is too far ahead");
    let chain = working.recvChainKey;
    for (let i = working.recvCounter; i < envelope.n; i++) chain = (await deriveMessageKey(chain)).nextChainKey;
    const derived = await deriveMessageKey(chain);
    messageKey = derived.messageKey;
    working.recvChainKey = derived.nextChainKey;
    working.recvCounter = envelope.n + 1;
  }

  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(base64ToBytes(envelope.iv)), additionalData: utf8(JSON.stringify({ v: envelope.v, type: envelope.type, sid: envelope.sid, n: envelope.n, ratchetPublicKey: envelope.ratchetPublicKey ?? null })) },
    messageKey, base64ToBytes(envelope.ct),
  );
  working.updatedAt = Date.now();
  await saveSession(working);
  return { plaintext: new TextDecoder().decode(plaintext), session: working };
}

export function remoteDeviceToKeyBundle(device: RemoteDeviceBundle): RemoteKeyBundle {
  return {
    identityPublicKey: device.identityPublicKey,
    signingPublicKey: device.signingPublicKey,
    signedPrekey: device.signedPrekey,
    oneTimePrekey: device.oneTimePrekeys?.[0] ?? null,
  };
}

function deviceSessionPeerId(peerUserId: string, deviceId: string): string {
  return `${peerUserId}${DEVICE_SESSION_SEPARATOR}${deviceId}`;
}

export async function encryptForAllDevices(
  peerUserId: string,
  primaryBundle: RemoteKeyBundle,
  devices: RemoteDeviceBundle[],
  plaintext: string,
  senderDeviceId: string,
  consumePrekey?: (deviceId: string, prekeyId: string) => Promise<unknown>,
): Promise<string> {
  // Keep a sender-only encrypted copy so the sender can decrypt its own history.
  const senderCopy = await encryptSelfCopy(plaintext);
  const activeDevices = devices.filter((device) => device.deviceId && device.identityPublicKey && device.signedPrekey);
  const ciphertexts: Array<{ deviceId: string; ciphertext: string }> = [];

  for (const device of activeDevices) {
    const bundle = remoteDeviceToKeyBundle(device);
    const peerKey = deviceSessionPeerId(peerUserId, device.deviceId);
    if (!(await hasSecureSession(peerKey)) && bundle.oneTimePrekey && consumePrekey) {
      try { await consumePrekey(device.deviceId, bundle.oneTimePrekey.id); } catch { /* fall back to signed prekey */ }
    }
    try {
      const ciphertext = await encryptForPeer(peerKey, bundle, plaintext);
      ciphertexts.push({ deviceId: device.deviceId, ciphertext });
    } catch (error) {
      // One unavailable/revoked device must not prevent delivery to the others.
      console.warn(`Could not create encrypted session for device ${device.deviceId}`, error);
    }
  }

  // If the peer has no usable device bundle yet (or every device encryption
  // attempt failed), use the account-level compatibility bundle as a fallback.
  // Keep it inside the v3 envelope so the sender can still read its own copy.
  if (!ciphertexts.length) {
    try {
      const fallback = await encryptForPeer(peerUserId, primaryBundle, plaintext);
      ciphertexts.push({ deviceId: "__primary__", ciphertext: fallback });
    } catch (error) {
      console.warn("Could not create fallback secure message", error);
      throw new Error("Secure messaging is not ready for this friend. Ask them to open Sakhya and sign in once so their secure keys can be registered.");
    }
  }

  // Never return the sender-only copy as the transport payload. The server
  // accepts only E2EE envelopes because a sender-only copy cannot be decrypted
  // by the recipient.
  const envelope: MultiDeviceEnvelope = { v: 3, kind: "multi-device", senderDeviceId, senderCopy, devices: ciphertexts };
  return `sakhya:e2ee:v3:${btoa(JSON.stringify(envelope))}`;
}

export async function decryptMultiDeviceForUser(
  peerUserId: string,
  value: string,
  primaryBundle: RemoteKeyBundle,
  currentUserId: string,
  senderDevices: RemoteDeviceBundle[] = [],
): Promise<string> {
  if (!value.startsWith("sakhya:e2ee:v3:")) return decryptForPeer(peerUserId, value, primaryBundle);
  const envelope = JSON.parse(atob(value.slice("sakhya:e2ee:v3:".length))) as MultiDeviceEnvelope;
  if (envelope.v !== 3 || envelope.kind !== "multi-device" || !envelope.senderDeviceId || !Array.isArray(envelope.devices)) {
    throw new Error("Unsupported multi-device secure message");
  }

  if (envelope.senderCopy?.startsWith("sakhya:self-copy:v1:")) {
    // The sender can always read its own sent-message copy on this device.
    // Receiver devices still use the per-device ciphertexts below.
    try { if (currentUserId !== peerUserId) return await decryptSelfCopy(envelope.senderCopy); } catch { /* not the sender device */ }
  }
  if (currentUserId === peerUserId) {
    return decryptSelfCopy(envelope.senderCopy);
  }

  const localDeviceId = typeof window !== "undefined"
    ? localStorage.getItem("sakhya_device_id") || (() => {
        const activeAccount = localStorage.getItem("sakhya_active_device_account");
        return activeAccount ? localStorage.getItem(`sakhya_device_id:${encodeURIComponent(activeAccount.trim().toLowerCase())}`) : null;
      })()
    : null;
  const target = envelope.devices.find((entry) => entry.deviceId === localDeviceId)
    || envelope.devices.find((entry) => entry.deviceId === "__primary__");
  if (!target) throw new Error("This secure message was not encrypted for this device");
  if (target.deviceId === "__primary__") return decryptForPeer(peerUserId, target.ciphertext, primaryBundle);

  const senderDevice = senderDevices.find((device) => device.deviceId === envelope.senderDeviceId);
  if (!senderDevice) throw new Error("Sender device security bundle is unavailable");
  return decryptForPeer(deviceSessionPeerId(peerUserId, envelope.senderDeviceId), target.ciphertext, remoteDeviceToKeyBundle(senderDevice));
}

export async function encryptForPeer(peerId: string, bundle: RemoteKeyBundle, plaintext: string): Promise<string> {
  let session = await getSession(peerId);
  if (!session) {
    const verified = await verifySignedPrekey(JSON.parse(bundle.signingPublicKey), JSON.parse(bundle.signedPrekey.publicKey), bundle.signedPrekey.signature);
    if (!verified) throw new Error("The recipient's secure key could not be verified");
    const established = await establishInitiatorSession(peerId, bundle);
    return (await encryptWithChain(plaintext, established.session, established.envelopeHeader)).value;
  }
  const expectedIdentity = JSON.stringify(session.peerIdentityPublicKey);
  if (expectedIdentity !== JSON.stringify(JSON.parse(bundle.identityPublicKey))) {
    throw new Error("The recipient's security key changed. Verify the new device before messaging.");
  }
  const header: EnvelopeV2 = { v: 2, type: "message", sid: session.sessionId, n: session.sendCounter, iv: "", ct: "", ratchetPublicKey: session.dhSelf.publicKey };
  return (await encryptWithChain(plaintext, session, header)).value;
}

export async function decryptForPeer(peerId: string, value: string, bundle: RemoteKeyBundle): Promise<string> {
  if (!value.startsWith("sakhya:e2ee:v2:")) {
    if (value.startsWith("sakhya:e2ee:v1:")) {
      return decryptText(value, JSON.parse(bundle.identityPublicKey) as JsonWebKey);
    }
    return value;
  }
  const envelope = JSON.parse(atob(value.slice("sakhya:e2ee:v2:".length))) as EnvelopeV2;
  if (envelope.v !== 2 || !envelope.sid || envelope.n < 0) throw new Error("Unsupported secure message");
  if (!envelope.ratchetPublicKey) throw new Error("Secure ratchet key missing");

  let session = await getSession(peerId);
  if (envelope.type === "session") {
    const signingKey = JSON.parse(bundle.signingPublicKey) as JsonWebKey;
    const signedPrekey = JSON.parse(bundle.signedPrekey.publicKey) as JsonWebKey;
    if (envelope.signedPrekeyId !== bundle.signedPrekey.id || !(await verifySignedPrekey(signingKey, signedPrekey, bundle.signedPrekey.signature))) {
      throw new Error("The secure session prekey could not be verified");
    }
    if (session && session.sessionId === envelope.sid) return decryptWithChain(value, session, envelope).then((result) => result.plaintext);
    session = await establishResponderSession(peerId, envelope, await ensureStoredBundle());
  }
  if (!session) throw new Error("Secure session is not established");
  if (session.sessionId !== envelope.sid) throw new Error("Secure session changed; verify the new device");
  return (await decryptWithChain(value, session, envelope)).plaintext;
}

export async function decryptHistoryForMultiDevice<T extends { content: string }>(
  peerUserId: string,
  messages: T[],
  primaryBundle: RemoteKeyBundle,
  currentUserId: string,
  senderDevices: RemoteDeviceBundle[],
): Promise<T[]> {
  const result: T[] = [];
  for (const message of messages) {
    try {
      result.push({ ...message, content: await decryptMultiDeviceForUser(peerUserId, message.content, primaryBundle, currentUserId, senderDevices) });
    } catch {
      result.push({ ...message, content: "Unable to decrypt this secure message." });
    }
  }
  return result;
}

export async function hasSecureSession(peerId: string): Promise<boolean> {
  return !!(await getSession(peerId));
}

export async function resetSecureSession(peerId: string): Promise<void> {
  await deleteStore(sessionKeyFor(peerId));
}


export async function getSafetyNumber(remoteIdentityPublicJwk: JsonWebKey): Promise<string> {
  const local = await getPublicKeyJwk();
  const values = [stableJwk(local), stableJwk(remoteIdentityPublicJwk)].sort();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(values.join("|"))));
  let digits = "";
  for (const byte of digest) digits += String(byte).padStart(3, "0");
  return digits.slice(0, 60).match(/.{1,5}/g)?.join(" ") ?? digits;
}

// Backward-compatible helpers for older callers.
export interface EncryptedEnvelope { v: 1; alg: "ECDH-P256/AES-256-GCM"; iv: string; ct: string; }

async function deriveLegacyAesKey(remotePublicJwk: JsonWebKey): Promise<CryptoKey> {
  const pair = await getOrCreateIdentityKey();
  const remote = await importEcdhPublic(remotePublicJwk);
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: remote }, pair.privateKey, 256);
  const digest = await crypto.subtle.digest("SHA-256", bits);
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptText(plaintext: string, remotePublicJwk: JsonWebKey): Promise<string> {
  const key = await deriveLegacyAesKey(remotePublicJwk);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, utf8(plaintext));
  const envelope: EncryptedEnvelope = { v: 1, alg: "ECDH-P256/AES-256-GCM", iv: bytesToBase64(iv.buffer), ct: bytesToBase64(ciphertext) };
  return `sakhya:e2ee:v1:${btoa(JSON.stringify(envelope))}`;
}

export async function decryptText(value: string, senderPublicJwk: JsonWebKey): Promise<string> {
  if (!value.startsWith("sakhya:e2ee:v1:")) return value;
  const envelope = JSON.parse(atob(value.slice("sakhya:e2ee:v1:".length))) as EncryptedEnvelope;
  const key = await deriveLegacyAesKey(senderPublicJwk);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(base64ToBytes(envelope.iv)) }, key, base64ToBytes(envelope.ct));
  return new TextDecoder().decode(plaintext);
}

export function isEncryptedMessage(value: string): boolean {
  return value.startsWith("sakhya:e2ee:v1:") || value.startsWith("sakhya:e2ee:v2:") || value.startsWith("sakhya:e2ee:v3:");
}


export type SecureMediaMeta = {
  v: 1;
  kind: "image" | "video" | "audio" | "file";
  mediaId: string;
  name: string;
  mime: string;
  size: number;
  key: JsonWebKey;
  iv: string;
  voice?: boolean;
};

export async function encryptMedia(file: File): Promise<{ blob: Blob; key: JsonWebKey; iv: string }> {
  if (file.size > 45 * 1024 * 1024) throw new Error("Media must be 45 MB or smaller");
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, await file.arrayBuffer());
  return { blob: new Blob([encrypted], { type: "application/octet-stream" }), key: await crypto.subtle.exportKey("jwk", key), iv: bytesToBase64(iv.buffer) };
}

export async function decryptMedia(blob: Blob, keyJwk: JsonWebKey, ivB64: string, mime: string): Promise<Blob> {
  const key = await crypto.subtle.importKey("jwk", keyJwk, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(base64ToBytes(ivB64)) }, key, await blob.arrayBuffer());
  return new Blob([plain], { type: mime || "application/octet-stream" });
}

export function parseSecureMediaMeta(value: string): SecureMediaMeta | null {
  try {
    if (!value.startsWith("sakhya:media:v1:")) return null;
    const parsed = JSON.parse(value.slice("sakhya:media:v1:".length)) as SecureMediaMeta;
    if (parsed.v !== 1 || !parsed.mediaId || !parsed.key || !parsed.iv || !parsed.mime) return null;
    return parsed;
  } catch { return null; }
}
