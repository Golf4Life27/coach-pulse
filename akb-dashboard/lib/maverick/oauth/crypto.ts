// Maverick OAuth — crypto primitives.
// @agent: maverick (Day 4.5)
//
// PKCE S256 verification, opaque token generation, constant-time
// comparison. Pure functions over node:crypto — testable without I/O.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Base64url encode without padding (RFC 4648 §5). */
export function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/**
 * Verify a PKCE code_verifier against a stored code_challenge per RFC 7636.
 * S256: base64url(SHA-256(verifier)) === challenge
 * plain: verifier === challenge (S256 strongly preferred; plain accepted for compat)
 */
export function verifyPkce(
  codeVerifier: string,
  codeChallenge: string,
  method: "S256" | "plain",
): boolean {
  if (typeof codeVerifier !== "string" || typeof codeChallenge !== "string") {
    return false;
  }
  if (method === "plain") {
    return constantTimeEqual(codeVerifier, codeChallenge);
  }
  // S256: base64url(SHA-256(verifier))
  const hash = createHash("sha256").update(codeVerifier).digest();
  const computed = base64url(hash);
  return constantTimeEqual(computed, codeChallenge);
}

/** Constant-time string equality. Bails on length mismatch (length is non-secret). */
export function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  // timingSafeEqual requires equal-length Buffers.
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * Generate an opaque token with a known prefix. 32 bytes of entropy →
 * 43 base64url chars; prefix narrows mistakes (e.g., mat_ on access
 * tokens, mrt_ on refresh tokens).
 */
export function generateOpaqueToken(prefix: string): string {
  return `${prefix}${base64url(randomBytes(32))}`;
}

/** 16-byte family_id for refresh-token rotation grouping. */
export function generateFamilyId(): string {
  return `fam_${base64url(randomBytes(16))}`;
}

/** Validate the shape of a code_verifier per RFC 7636 §4.1 (43–128 chars, [A-Za-z0-9-._~]). */
export function isValidCodeVerifier(s: unknown): s is string {
  return (
    typeof s === "string" &&
    s.length >= 43 &&
    s.length <= 128 &&
    /^[A-Za-z0-9\-._~]+$/.test(s)
  );
}
