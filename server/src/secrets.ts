// Bearer-secret minting and hashing — invariant 7 (tokens stored hashed) in
// one place.
// Both credential kinds use it: agent tokens (tokens.ts) and human browser
// session tokens (sessions.ts). It was written out twice, byte-identical, and
// the two copies had already drifted in their comments; the invariant gets one
// implementation so a change to it cannot land on only half the credentials.
import { createHash, getRandomValues } from "node:crypto";

// docs/security.md "Content rules": random ≥128-bit — we use 256-bit;
// base64url keeps it header/config copy-paste safe.
const TOKEN_BYTES = 32;

// Invariant 7 (tokens stored hashed): tokens are stored as SHA-256 only; the
// plaintext
// exists solely in the return value of the call that minted it.
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newToken(): string {
  return Buffer.from(getRandomValues(new Uint8Array(TOKEN_BYTES))).toString(
    "base64url",
  );
}
