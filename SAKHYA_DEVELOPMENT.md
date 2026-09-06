# Sakhya Development Roadmap

## Phase 1 — Privacy foundation
- Privacy settings for read receipts, typing indicators, presence, last-seen visibility, and notification previews.
- Basic HTTP security headers.
- Server-side ciphertext-only message storage for new messages.

## Phase 2 — E2EE key foundation
- Browser identity key.
- Signing identity.
- Signed prekeys.
- One-time prekeys.
- Key bundle API and validation.

## Phase 3 — Secure messaging sessions (current)
- X3DH-style initial session establishment.
- Ephemeral initiator key for each new session.
- Separate send/receive chains.
- Per-message AES-GCM keys derived from ratcheting chain keys.
- Replay/order counters.
- Safety-code display for manual device verification.
- v1 compatibility for existing encrypted messages.

## Phase 4 — Full forward secrecy
- Full Double Ratchet design.
- DH ratchet steps after message exchanges.
- Skipped-message-key storage with strict bounds and expiry.
- Session recovery/re-keying.
- Key-change events and explicit verification state.
- Multi-device session management.

## Phase 5 — Private communication features
- Disappearing messages.
- View-once media.
- Encrypted image/video/file attachments.
- Voice messages.
- Chat lock.
- Notification privacy enforcement.

## Phase 6 — Secure calling
- TURN infrastructure for reliable calls.
- Encrypted call signaling metadata.
- Device/session verification for calls.
- Call privacy controls.

## Phase 7 — Security hardening
- CSP and stricter browser isolation.
- Rate limiting and abuse controls.
- Automated protocol tests and interoperability tests.
- Dependency/security auditing.
- Independent cryptographic review before claiming production-grade E2EE.

## Phase 6 — Private messaging 2.0

- [x] Disappearing message metadata and server expiry cleanup
- [x] View-once message lifecycle
- [x] Privacy-safe copy behavior for view-once messages
- [x] Secure notification text without message plaintext
- [ ] Encrypted attachment transfer
- [ ] Voice-message encryption
- [ ] Multi-device encrypted media synchronization
- [ ] Chat lock with hardened local key protection


### Phase 7 completed
- Encrypted image/video/audio/file uploads with fresh per-file AES-GCM keys.
- Browser voice-message recording using MediaRecorder.
- Encrypted media download/decryption only on the client.
- Server-side participant authorization, size limits, no-store media responses, and media cleanup on message expiry/deletion.
- View-once media is not claimed until the recipient opens it.
- Chat previews now hide raw `sakhya:e2ee:*` ciphertext.
- Global horizontal overflow and settings card sizing corrected.
- Navigation now uses target-only pointer prefetching plus cached calls data instead of a burst of global route warmups.

## Phase 8 — Multi-device security foundation
- Device-bound account sessions with remote revocation.
- Each browser receives a stable device identifier and a device-specific public E2EE bundle.
- Server stores public device key material only; private keys remain local.
- Active-device management is available in Settings.
- Device key fan-out and encrypted cross-device message synchronization remain a follow-up protocol layer; messages must not be claimed as multi-device E2EE until recipient-device fan-out is implemented.

## Phase 9 — Multi-device encrypted delivery

Phase 9 adds a client-side multi-device delivery envelope. A sender can encrypt a message separately for each active recipient device while retaining a sender-only encrypted history copy. The server stores and forwards the envelope without seeing plaintext.

- Device-specific encrypted entries (`sakhya:e2ee:v3`)
- Per-device ratchet sessions
- Atomic device one-time-prekey consumption
- Compatibility fallback for users without a device crypto bundle
- Recipient devices only decrypt the entry addressed to their own device
- Revoked devices are excluded from newly fetched device bundles
- Existing v1/v2 messages remain readable
