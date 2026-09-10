// Dashboard session cookie — signed, sliding, no new env var.
// @agent: ops
//
// WHAT THIS REPLACES: the dashboard used to set `akb-auth=authenticated`
// after a correct password and treat that literal string, forever, as proof
// of a session. That is a constant — the same seven bytes on every login,
// for every visitor, until the process is redeployed. Anyone who opens
// devtools on ANY page that mentions the cookie name (this file, a bug
// report, a screenshot) can set `akb-auth=authenticated` by hand and be
// fully logged in without ever seeing the password. The password was
// decorative against that one guess.
//
// THE FIX: the cookie now carries an expiry plus an HMAC over that expiry,
// keyed on a secret only the server holds. A value is only good if (a) the
// signature verifies, meaning it was minted by this server, and (b) it
// hasn't expired. There is no fixed "magic value" to guess — every session
// is a distinct signed token, and the tokens carry no user identity or
// other payload worth stealing beyond "log in until this timestamp".
//
// WHERE THE SECRET COMES FROM: DASHBOARD_SESSION_SECRET if it's set, else
// derived from DASHBOARD_PASSWORD (see sessionSecret below). Deriving from
// the password rather than requiring a second env var means this ships
// with zero new configuration — the dashboard already requires
// DASHBOARD_PASSWORD to boot. It also buys a property the old constant
// cookie could never have: ROTATING THE PASSWORD INVALIDATES EVERY
// OUTSTANDING SESSION, because every session's signature depends on it.
// That's a feature, not a side effect — it's the honest way to force
// everyone back through the login screen after a password change.
//
// WHY THE DERIVED SECRET ISN'T THE PASSWORD ITSELF: if the signing key
// equaled the password, then anyone who ever saw a cookie's signature
// would hold an oracle for verifying password guesses offline (mint a
// candidate, compare the HMAC). Hashing the password through a fixed,
// versioned prefix first (see deriveSecretFromPassword) means the signing
// key is one-way from the password, not equal to it.
//
// DELIBERATELY NO COMPATIBILITY WINDOW: verifySessionValue below rejects
// the literal legacy value "authenticated" as malformed rather than
// special-casing it as still-valid. Accepting it "just for the transition"
// would keep the exact hole this file exists to close open for as long as
// the compatibility code lived. The cost is that the operator has to type
// the password one more time after this ships. That's the intended cost.

import { createHash, createHmac } from "node:crypto";
import { constantTimeEqual } from "@/lib/maverick/oauth/crypto";

export const SESSION_COOKIE_NAME = "akb-auth";

const DERIVATION_PREFIX = "akb-dashboard-session-v1:";

/** One-way derivation from the dashboard password into a signing key that
 *  is not the password itself (see file header for why that distinction
 *  matters). Versioned prefix so a future derivation change is a visible
 *  diff, not a silent behavior change. */
function deriveSecretFromPassword(password: string): string {
  return createHash("sha256").update(DERIVATION_PREFIX + password).digest("hex");
}

/**
 * The key used to sign and verify session cookies.
 *
 * DASHBOARD_SESSION_SECRET wins when set — an operator who wants session
 * validity independent of the login password (e.g. so a password change
 * does NOT log everyone out) can set it explicitly. Otherwise the secret
 * is derived from DASHBOARD_PASSWORD, which is the no-new-env-var default
 * and the one that makes rotating the password also revoke sessions.
 *
 * Returns null when neither is configured. Callers MUST fail closed on
 * null — there is no secret to check anything against, so no cookie can
 * be trusted no matter what it contains.
 */
export function sessionSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.DASHBOARD_SESSION_SECRET;
  if (explicit) return explicit;
  const password = env.DASHBOARD_PASSWORD;
  if (password) return deriveSecretFromPassword(password);
  return null;
}

function sign(expiresAtMs: number, secret: string): string {
  return createHmac("sha256", secret).update(String(expiresAtMs)).digest("base64url");
}

/** Mint a session cookie value: `<expiresAtMs>.<hmac>`. */
export function mintSessionValue(expiresAtMs: number, secret: string): string {
  return `${expiresAtMs}.${sign(expiresAtMs, secret)}`;
}

export type SessionVerifyResult =
  | { ok: true; expiresAtMs: number }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "no_secret" };

// The exact value the old, unsigned cookie used. Rejected unconditionally
// (see file header — no compatibility window for the hole being closed).
const LEGACY_VALUE = "authenticated";

/**
 * Verify a session cookie value. Never throws — every shape of garbage a
 * hand-edited cookie could contain (empty, no dot, extra dots, a huge
 * string, a non-numeric expiry) resolves to a typed failure instead of an
 * exception, because this runs on every request and a thrown error here
 * must never become an unhandled 500 that masks an auth decision.
 */
export function verifySessionValue(
  value: string | undefined | null,
  nowMs: number,
  secret: string | null,
): SessionVerifyResult {
  if (!secret) return { ok: false, reason: "no_secret" };
  if (!value || value === LEGACY_VALUE) return { ok: false, reason: "malformed" };

  const dot = value.indexOf(".");
  if (dot === -1 || value.indexOf(".", dot + 1) !== -1) {
    return { ok: false, reason: "malformed" };
  }
  const expiresPart = value.slice(0, dot);
  const macPart = value.slice(dot + 1);
  if (!expiresPart || !macPart || !/^\d+$/.test(expiresPart)) {
    return { ok: false, reason: "malformed" };
  }
  const expiresAtMs = Number(expiresPart);
  if (!Number.isSafeInteger(expiresAtMs)) {
    return { ok: false, reason: "malformed" };
  }

  const expectedMac = sign(expiresAtMs, secret);
  if (!constantTimeEqual(macPart, expectedMac)) {
    return { ok: false, reason: "bad_signature" };
  }
  if (nowMs >= expiresAtMs) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, expiresAtMs };
}
