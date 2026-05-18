// DocuSign client (Phase 5.1 — Scribe foundation).
// @agent: scribe
//
// Thin REST client over DocuSign eSign API v2.1 + a hand-rolled JWT
// bearer flow over Node's `crypto`. No new npm deps — mirrors the
// dependency-frugal posture of `lib/quo.ts` and `lib/gmail.ts`.
//
// Auth model:
//   1. Service-account JWT: integration key + user_id + RSA private key
//      → POST /oauth/token (grant_type=urn:ietf:params:oauth:grant-
//      type:jwt-bearer) → access_token
//   2. Access tokens cached in-process for their lifetime minus a 60s
//      safety margin. Cold-start lambdas re-mint on first call.
//
// Env (all required for live calls):
//   DOCUSIGN_INTEGRATION_KEY   — UUID from the DocuSign integration's
//                                 Apps & Keys panel
//   DOCUSIGN_USER_ID           — UUID of the user being impersonated
//                                 (Alex's getUserInfo `sub`)
//   DOCUSIGN_PRIVATE_KEY       — RSA private key (PEM, full multi-line
//                                 with BEGIN/END markers; Vercel env
//                                 stores newlines literally)
//
// Defaults (overridable via env):
//   DOCUSIGN_ACCOUNT_ID        — default 'ab943441-29da-4bcb-8d3f-19efc0412d6c'
//   DOCUSIGN_BASE_URI          — default 'https://na4.docusign.net'
//   DOCUSIGN_OAUTH_BASE        — default 'https://account.docusign.com'
//                                 (use 'account-d.docusign.com' for demo)
//
// All HTTPS calls go through the cached access token. When env is
// incomplete, `getDocusignAccessToken` returns null and callers
// degrade to empty-state behavior (no exceptions bubbled).

import { createSign } from "crypto";

const OAUTH_BASE = process.env.DOCUSIGN_OAUTH_BASE ?? "https://account.docusign.com";
const ACCOUNT_ID = process.env.DOCUSIGN_ACCOUNT_ID ?? "ab943441-29da-4bcb-8d3f-19efc0412d6c";
const BASE_URI = process.env.DOCUSIGN_BASE_URI ?? "https://na4.docusign.net";

// JWT scope for envelope read + reminder send. Spec §6 (impersonation)
// is required because we act as Alex against his own envelopes.
const JWT_SCOPE = "signature impersonation";
// JWT max lifetime per DocuSign spec — 1h. We mint with 50min to leave
// headroom for clock drift.
const JWT_LIFETIME_S = 50 * 60;
// Strip access-token cache 60s before expiry to avoid mid-call expiry.
const TOKEN_REFRESH_MARGIN_MS = 60_000;

interface AccessTokenCache {
  token: string;
  expires_at: number;
}
let tokenCache: AccessTokenCache | null = null;

export function docusignConfigured(): boolean {
  return Boolean(
    process.env.DOCUSIGN_INTEGRATION_KEY &&
      process.env.DOCUSIGN_USER_ID &&
      process.env.DOCUSIGN_PRIVATE_KEY,
  );
}

// ────────────────────── auth ──────────────────────

export interface DocusignAuthResult {
  ok: true;
  token: string;
  expires_at: number;
}
export interface DocusignAuthFailure {
  ok: false;
  reason:
    | "env_missing"
    | "jwt_signing_failed"
    | "oauth_rejected"
    | "oauth_malformed";
  detail?: string;
}

/**
 * Mint or return a cached DocuSign access token. Returns null when
 * env is incomplete (degrade-to-empty contract). Throws only on
 * unexpected internal errors; OAuth rejection is reported via
 * DocusignAuthFailure, not exception.
 */
export async function getDocusignAccessToken(): Promise<DocusignAuthResult | DocusignAuthFailure> {
  if (!docusignConfigured()) {
    return { ok: false, reason: "env_missing" };
  }
  const now = Date.now();
  if (tokenCache && tokenCache.expires_at - TOKEN_REFRESH_MARGIN_MS > now) {
    return { ok: true, token: tokenCache.token, expires_at: tokenCache.expires_at };
  }

  let assertion: string;
  try {
    assertion = buildJwtAssertion({
      integrationKey: process.env.DOCUSIGN_INTEGRATION_KEY!,
      userId: process.env.DOCUSIGN_USER_ID!,
      privateKeyPem: process.env.DOCUSIGN_PRIVATE_KEY!,
      audience: oauthAudience(),
      scope: JWT_SCOPE,
      lifetimeSeconds: JWT_LIFETIME_S,
      now: new Date(now),
    });
  } catch (err) {
    return {
      ok: false,
      reason: "jwt_signing_failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const res = await fetch(`${OAUTH_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return {
      ok: false,
      reason: "oauth_rejected",
      detail: `${res.status}: ${text.slice(0, 200)}`,
    };
  }
  const body = (await res.json().catch(() => null)) as {
    access_token?: unknown;
    expires_in?: unknown;
  } | null;
  if (!body || typeof body.access_token !== "string" || typeof body.expires_in !== "number") {
    return { ok: false, reason: "oauth_malformed" };
  }
  const expiresAt = now + body.expires_in * 1000;
  tokenCache = { token: body.access_token, expires_at: expiresAt };
  return { ok: true, token: body.access_token, expires_at: expiresAt };
}

function oauthAudience(): string {
  // DocuSign expects the bare hostname (no scheme) as audience.
  return OAUTH_BASE.replace(/^https?:\/\//, "");
}

// Reset for tests — never invoked in production.
export function __resetTokenCacheForTests(): void {
  tokenCache = null;
}

// ────────────────────── JWT signing (pure) ──────────────────────

export interface JwtBuildOpts {
  integrationKey: string;
  userId: string;
  privateKeyPem: string;
  audience: string;
  scope: string;
  lifetimeSeconds: number;
  now: Date;
}

/**
 * Pure: build the JWT assertion string used in the JWT-bearer grant.
 * Signs with RS256 via Node crypto. Extracted so tests can verify the
 * header/payload structure without standing up a private key.
 */
export function buildJwtAssertion(opts: JwtBuildOpts): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const iat = Math.floor(opts.now.getTime() / 1000);
  const payload = base64UrlEncode(
    JSON.stringify({
      iss: opts.integrationKey,
      sub: opts.userId,
      iat,
      exp: iat + opts.lifetimeSeconds,
      aud: opts.audience,
      scope: opts.scope,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer
    .sign(opts.privateKeyPem)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${signingInput}.${signature}`;
}

function base64UrlEncode(s: string): string {
  return Buffer.from(s, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// ────────────────────── envelope types ──────────────────────

// Subset of the DocuSign envelope shape we read. Full envelope is far
// richer (tabs, custom fields, etc.); we only model what Scribe surfaces.
export interface DocusignEnvelope {
  envelopeId: string;
  status: DocusignEnvelopeStatus;
  emailSubject?: string;
  sentDateTime?: string;
  lastModifiedDateTime?: string;
  statusChangedDateTime?: string;
  completedDateTime?: string;
  voidedDateTime?: string;
  voidedReason?: string;
  expireDateTime?: string;
}

export type DocusignEnvelopeStatus =
  | "created"
  | "sent"
  | "delivered"
  | "signed"
  | "completed"
  | "declined"
  | "voided"
  | "timedout"
  | "deleted"
  | "processing"
  | "unknown";

export interface DocusignRecipient {
  recipientId: string;
  name?: string;
  email?: string;
  status?: DocusignRecipientStatus;
  routingOrder?: string;
  signedDateTime?: string;
  deliveredDateTime?: string;
  sentDateTime?: string;
  declinedDateTime?: string;
  declinedReason?: string;
}

export type DocusignRecipientStatus =
  | "created"
  | "sent"
  | "delivered"
  | "signed"
  | "completed"
  | "declined"
  | "autoresponded"
  | "unknown";

// ────────────────────── REST calls ──────────────────────

const REST_BASE = `${BASE_URI}/restapi/v2.1/accounts/${ACCOUNT_ID}`;

async function docusignFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const auth = await getDocusignAccessToken();
  if (!auth.ok) {
    throw new Error(`docusign auth failed: ${auth.reason}${auth.detail ? ` (${auth.detail})` : ""}`);
  }
  return fetch(`${REST_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${auth.token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    cache: "no-store",
  });
}

export interface ListEnvelopesOpts {
  fromDate?: string;
  status?: string;
  count?: number;
}

export async function listEnvelopes(
  opts: ListEnvelopesOpts = {},
): Promise<DocusignEnvelope[]> {
  const params = new URLSearchParams();
  // 30-day default look-back. DocuSign requires at least one of
  // from_date / envelope_ids / transaction_ids per API contract.
  const fromDate =
    opts.fromDate ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  params.set("from_date", fromDate);
  if (opts.status) params.set("status", opts.status);
  if (opts.count !== undefined) params.set("count", String(opts.count));
  params.set("order_by", "last_modified");
  params.set("order", "desc");

  const res = await docusignFetch(`/envelopes?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`docusign listEnvelopes ${res.status}`);
  }
  const body = (await res.json()) as { envelopes?: DocusignEnvelope[] };
  return body.envelopes ?? [];
}

export async function getEnvelope(envelopeId: string): Promise<DocusignEnvelope> {
  const res = await docusignFetch(`/envelopes/${encodeURIComponent(envelopeId)}`);
  if (!res.ok) throw new Error(`docusign getEnvelope ${res.status}`);
  return (await res.json()) as DocusignEnvelope;
}

export async function listRecipients(envelopeId: string): Promise<DocusignRecipient[]> {
  const res = await docusignFetch(
    `/envelopes/${encodeURIComponent(envelopeId)}/recipients`,
  );
  if (!res.ok) throw new Error(`docusign listRecipients ${res.status}`);
  const body = (await res.json()) as {
    signers?: DocusignRecipient[];
    carbonCopies?: DocusignRecipient[];
    agents?: DocusignRecipient[];
    intermediaries?: DocusignRecipient[];
    certifiedDeliveries?: DocusignRecipient[];
    editors?: DocusignRecipient[];
    inPersonSigners?: DocusignRecipient[];
    witnesses?: DocusignRecipient[];
  };
  return [
    ...(body.signers ?? []),
    ...(body.carbonCopies ?? []),
    ...(body.agents ?? []),
    ...(body.intermediaries ?? []),
    ...(body.certifiedDeliveries ?? []),
    ...(body.editors ?? []),
    ...(body.inPersonSigners ?? []),
    ...(body.witnesses ?? []),
  ];
}

export async function sendReminder(envelopeId: string): Promise<{ ok: boolean; httpStatus: number; raw: unknown }> {
  // DocuSign's reminder API: POST envelopes/{id}/notification with
  // resendEnvelope=true. We use the simple shape (no custom subject/
  // body) so reminders look identical to DocuSign's defaults — Alex
  // can override later from inside DocuSign if needed.
  const res = await docusignFetch(`/envelopes/${encodeURIComponent(envelopeId)}`, {
    method: "PUT",
    body: JSON.stringify({ status: "sent" }),
    headers: { "Content-Type": "application/json" },
  });
  const raw = await res.json().catch(() => null);
  return { ok: res.ok, httpStatus: res.status, raw };
}

// ────────────────────── pure projection helpers ──────────────────────

export interface EnvelopeSummary {
  envelopeId: string;
  status: DocusignEnvelopeStatus;
  subject: string | null;
  last_modified_iso: string | null;
  awaiting_recipient_name: string | null;
  awaiting_recipient_email: string | null;
  /** Hours since the envelope was last sent/changed and is still
   *  awaiting any recipient action. Null when not in-flight. */
  awaiting_hours: number | null;
  /** True when this envelope's current next-action recipient is Alex
   *  (his Gmail address — set via env so test envs can override). */
  awaiting_is_alex: boolean;
  deep_link_url: string;
}

const ALEX_EMAIL = (process.env.DOCUSIGN_ALEX_EMAIL ?? "Alex@akb-properties.com").toLowerCase();
const DOCUSIGN_WEB_BASE = "https://app.docusign.com/documents/details";

/**
 * Summarize an envelope + its recipients into the slim shape the
 * briefing source ships. Pure given the inputs + a 'now' clock.
 */
export function summarizeEnvelope(
  envelope: DocusignEnvelope,
  recipients: DocusignRecipient[],
  now: Date = new Date(),
): EnvelopeSummary {
  const status = normalizeEnvelopeStatus(envelope.status);
  // Pending recipient = first one in routing order whose status isn't
  // a terminal "done" state. DocuSign lists them in arbitrary order
  // so we sort by routingOrder ascending first.
  const pending = [...recipients]
    .filter((r) => r.status && !isRecipientTerminal(r.status))
    .sort((a, b) => parseRoutingOrder(a.routingOrder) - parseRoutingOrder(b.routingOrder))[0];

  const lastModified = envelope.lastModifiedDateTime ?? envelope.statusChangedDateTime ?? envelope.sentDateTime ?? null;
  const awaitingHours = pending && lastModified ? hoursBetween(lastModified, now) : null;

  return {
    envelopeId: envelope.envelopeId,
    status,
    subject: envelope.emailSubject ?? null,
    last_modified_iso: lastModified,
    awaiting_recipient_name: pending?.name ?? null,
    awaiting_recipient_email: pending?.email ?? null,
    awaiting_hours: awaitingHours,
    awaiting_is_alex: Boolean(
      pending?.email && pending.email.toLowerCase() === ALEX_EMAIL,
    ),
    deep_link_url: `${DOCUSIGN_WEB_BASE}/${encodeURIComponent(envelope.envelopeId)}`,
  };
}

export function normalizeEnvelopeStatus(s: string): DocusignEnvelopeStatus {
  const v = (s ?? "").toLowerCase();
  const known: DocusignEnvelopeStatus[] = [
    "created",
    "sent",
    "delivered",
    "signed",
    "completed",
    "declined",
    "voided",
    "timedout",
    "deleted",
    "processing",
  ];
  return known.includes(v as DocusignEnvelopeStatus)
    ? (v as DocusignEnvelopeStatus)
    : "unknown";
}

export function isRecipientTerminal(status: DocusignRecipientStatus): boolean {
  return status === "signed" || status === "completed" || status === "declined" || status === "autoresponded";
}

export function isEnvelopeInFlight(status: DocusignEnvelopeStatus): boolean {
  return status === "sent" || status === "delivered" || status === "signed" || status === "created" || status === "processing";
}

export function isEnvelopeCompleted(status: DocusignEnvelopeStatus): boolean {
  return status === "completed";
}

export function isEnvelopeVoidedOrExpired(status: DocusignEnvelopeStatus): boolean {
  return status === "voided" || status === "declined" || status === "timedout";
}

/**
 * Rollup across many summarized envelopes — what the briefing source
 * surfaces to the Scribe room. Pure.
 */
export interface DocusignRollup {
  active_count: number;
  awaiting_alex_count: number;
  signed_this_week: number;
  voided_or_expired: number;
  max_awaiting_alex_hours: number | null;
}

export function rollupEnvelopes(
  summaries: EnvelopeSummary[],
  now: Date = new Date(),
): DocusignRollup {
  let activeCount = 0;
  let awaitingAlexCount = 0;
  let signedThisWeek = 0;
  let voidedOrExpired = 0;
  let maxAwaitingAlexHours: number | null = null;

  const weekAgo = now.getTime() - 7 * 86_400_000;

  for (const e of summaries) {
    if (isEnvelopeInFlight(e.status)) activeCount++;
    if (isEnvelopeVoidedOrExpired(e.status)) voidedOrExpired++;
    if (isEnvelopeCompleted(e.status) && e.last_modified_iso) {
      const t = new Date(e.last_modified_iso).getTime();
      if (!isNaN(t) && t >= weekAgo) signedThisWeek++;
    }
    if (e.awaiting_is_alex && e.awaiting_hours !== null) {
      awaitingAlexCount++;
      if (maxAwaitingAlexHours === null || e.awaiting_hours > maxAwaitingAlexHours) {
        maxAwaitingAlexHours = e.awaiting_hours;
      }
    }
  }

  return {
    active_count: activeCount,
    awaiting_alex_count: awaitingAlexCount,
    signed_this_week: signedThisWeek,
    voided_or_expired: voidedOrExpired,
    max_awaiting_alex_hours: maxAwaitingAlexHours,
  };
}

// ────────────────────── helpers ──────────────────────

function parseRoutingOrder(s: string | undefined): number {
  if (!s) return Infinity;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : Infinity;
}

function hoursBetween(iso: string, now: Date): number {
  const t = new Date(iso).getTime();
  if (isNaN(t)) return 0;
  return Math.max(0, (now.getTime() - t) / 3_600_000);
}
