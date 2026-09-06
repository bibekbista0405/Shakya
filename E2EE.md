# Sakhya E2EE

Sakhya now has a **versioned end-to-end encrypted session protocol** for 1-to-1 text messages.

## Current protocol

### v2 session establishment
- Browser-generated ECDH P-256 identity key per device.
- Separate ECDSA P-256 signing identity.
- Signed ECDH prekey authenticated by the signing key.
- One-time prekeys for initial sessions.
- X3DH-style multi-DH session derivation.
- HKDF-SHA-256 derives independent initiator/responder chains.
- AES-256-GCM encrypts message bodies in the browser.
- Per-message HMAC-derived message keys advance the sending/receiving chain.
- Message counters and authenticated metadata prevent silent reordering/tampering.
- The server stores ciphertext and key metadata; it does not receive plaintext message bodies.
- A deterministic safety code is shown in the conversation security panel so two users can compare device keys out-of-band.

### Legacy compatibility
Existing `sakhya:e2ee:v1:` messages remain decryptable so an upgraded local database does not immediately lose access to older messages. New messages use v2.

## Important security boundary

This is **not yet Signal Protocol / Double Ratchet equivalent**. The current v2 implementation still has important limitations:

- The device identity private keys are stored in browser IndexedDB as JWK material.
- The current ratchet is symmetric-chain based rather than a full Double Ratchet with DH ratchet steps.
- Multi-device sessions are not independently managed yet.
- Safety-code comparison is user-driven and is not a server-independent verification authority.
- Encrypted attachments/media, disappearing messages, and encrypted call signaling are separate future work.

Do not describe Sakhya as “Signal-grade” until those missing protocol properties are implemented and independently audited.

## Threat model

The design aims to protect message plaintext from the Sakhya application server and database if the server only sees normal application traffic. It does **not** protect against a compromised browser/device, malicious browser extensions, XSS that executes in the origin, or a user voluntarily exposing their device keys.

## Phase 4 — Double Ratchet layer

Sakhya v2 now adds a browser-side Double Ratchet-style DH ratchet on top of the authenticated prekey session:

- Every ratchet step creates a fresh P-256 ephemeral DH key pair.
- Receiving a new remote ratchet public key advances the root key and receiving chain.
- The receiver immediately creates a fresh local ratchet key and derives the next sending chain.
- Message keys are derived from a one-way HMAC chain and are never sent to the server.
- AES-256-GCM authenticates the protocol header as additional authenticated data.
- A bounded skipped-message window (64) allows limited out-of-order delivery while preventing unbounded key derivation.
- Replayed messages outside the retained skipped-key window are rejected.
- A changed identity key still stops the session and requires verification.

### Security boundary

This is an application-level Double Ratchet-style implementation using Web Crypto and should **not** be represented as an audited Signal Protocol implementation. In particular, browser key storage, multi-device synchronization, recovery, and independent protocol auditing remain security work for later phases.

## Phase 6 — Private message lifecycle

Sakhya now supports privacy-preserving message lifecycle controls without putting plaintext back on the server.

### Disappearing messages
The sender can attach an expiry of 30 seconds, 5 minutes, 1 hour, 24 hours, or 7 days. The server stores only the encrypted envelope and the expiry metadata. Expired records have their ciphertext removed and are broadcast as deleted.

### View-once messages
A sender can mark a message as view-once. The recipient can decrypt it once and then claims it. After the claim, the recipient's copy is replaced by a consumed placeholder and the server no longer exposes the ciphertext to that recipient. Copy/reaction actions are disabled for view-once messages in the client.

### Security boundary
These features reduce persistence and accidental copying; they do not prevent screenshots, camera capture, malicious browser extensions, or a compromised endpoint. Browser-based E2EE should not be described as protection against a compromised device.

### Not yet included
Encrypted attachment storage/transfer, true screenshot detection, and hardware-backed key storage remain later phases. In particular, screenshot detection should not be presented as a guaranteed security control on the web platform.


## Phase 7 — Encrypted media and smooth UX
- Client-side encrypted image, video, audio/voice, and file attachments.
- Encrypted media blobs are stored server-side without plaintext content.
- Privacy-safe chat previews never expose E2EE ciphertext.
- Settings layout is constrained to the viewport with horizontal overflow protection.
- Primary navigation uses idle route prefetching and cached calls data to reduce transition latency and repeated clicks.


## Phase 7 media security

Media attachments are encrypted in the browser with a fresh AES-256-GCM file key. The encrypted blob is uploaded to the Sakhya server; the file key, IV, filename, MIME type, and other media metadata are carried inside an E2EE message envelope. The server can enforce access control and expiration without receiving plaintext media.

The server can still observe account IDs, upload/download timing, encrypted blob size, and the existence of an attachment. A compromised endpoint/browser can also access plaintext after decryption. This is intentional and documented; it is not a claim of metadata privacy or protection from a compromised device.

## Phase 8 — Device identity foundation
Sakhya now treats each browser installation as a distinct account device. Authentication sessions are bound to a device ID, and each active device publishes its public E2EE identity/signing/prekey bundle separately. Private key material remains in browser storage and is never uploaded.

This is the foundation for multi-device E2EE. The current chat protocol still establishes a peer session against a selected account-level bundle; it does **not** yet claim complete multi-device ciphertext fan-out or seamless encrypted history synchronization. Those require explicit per-device recipient envelopes and a secure encrypted sync design.

## Phase 9 — Multi-device encrypted delivery

Sakhya now has a v3 multi-device delivery envelope. When the recipient has active device crypto bundles, the sender creates a separate E2EE ciphertext for each active recipient device. Each ciphertext has its own device-scoped ratchet session. The outer envelope contains no plaintext.

The sender also keeps a sender-only encrypted copy so the sender can reload its own history. If no recipient device bundle is available, Sakhya falls back to the existing v2 user-level encrypted message so users are not blocked by an incomplete device setup.

This is a multi-device delivery foundation, not a claim of production-grade Signal protocol compatibility. A future hardening pass should add formal protocol review, stronger key storage, device verification UX, and audited recovery/backup mechanisms.
