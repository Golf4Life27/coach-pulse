// Gmail integration.
//
// Two modes:
//   1. getThreadsForEmail — read email history (Phase 1 V2 fix).
//      Requires gmail.readonly scope on the OAuth refresh token.
//   2. (Phase 2) sendEmail / createDraft — send/draft outbound emails to
//      buyers. Uses an OAuth refresh token (no per-user OAuth flow).
//
// Required env: GMAIL_OAUTH_CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET,
// GMAIL_REFRESH_TOKEN, GMAIL_FROM_ADDRESS.
//
// When any of these are missing, sendEmail/createDraft fall back to
// returning a mailto: URL so callers can still surface drafts.
// getThreadsForEmail returns [] when not configured.

import { audit } from "./audit-log";

export interface GmailMessage {
  id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  date: string;
}

function decodeBase64Url(s: string): string {
  if (!s) return "";
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return Buffer.from(padded, "base64").toString("utf-8");
  } catch {
    return "";
  }
}

interface GmailHeader { name: string; value: string }
interface GmailMessagePart {
  mimeType?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number };
  parts?: GmailMessagePart[];
}
interface GmailFullMessage {
  id: string;
  threadId: string;
  internalDate?: string;
  payload?: GmailMessagePart;
}

function findHeader(headers: GmailHeader[] | undefined, name: string): string {
  if (!headers) return "";
  const lower = name.toLowerCase();
  const h = headers.find((x) => x.name.toLowerCase() === lower);
  return h?.value ?? "";
}

function extractBodyFromPayload(payload: GmailMessagePart | undefined): string {
  if (!payload) return "";
  // Prefer text/plain anywhere in the part tree.
  const stack: GmailMessagePart[] = [payload];
  let textPlain = "";
  let textHtml = "";
  while (stack.length > 0) {
    const p = stack.pop()!;
    const mime = (p.mimeType ?? "").toLowerCase();
    const data = p.body?.data;
    if (data) {
      const decoded = decodeBase64Url(data);
      if (mime === "text/plain" && !textPlain) textPlain = decoded;
      else if (mime === "text/html" && !textHtml) textHtml = decoded;
    }
    if (p.parts) stack.push(...p.parts);
  }
  if (textPlain) return textPlain.trim();
  if (textHtml) {
    // Strip tags as a basic fallback.
    return textHtml.replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  return "";
}

function shapeMessage(msg: GmailFullMessage): GmailMessage {
  const headers = msg.payload?.headers;
  const subject = findHeader(headers, "Subject");
  const from = findHeader(headers, "From");
  const to = findHeader(headers, "To");
  const dateHeader = findHeader(headers, "Date");
  const body = extractBodyFromPayload(msg.payload);
  const epoch = msg.internalDate ? parseInt(msg.internalDate, 10) : NaN;
  const date = !isNaN(epoch) ? new Date(epoch).toISOString() : (dateHeader || "");
  return { id: msg.id, from, to, subject, body, date };
}

const MAX_THREADS_TO_PULL = 50;
const MAX_MESSAGES_PER_THREAD = 25;

export async function getThreadsForEmail(
  email: string,
  sinceMinutes: number = 60 * 24 * 90,
): Promise<GmailMessage[]> {
  if (!email || !email.trim()) return [];
  const token = await getAccessToken();
  if (!token) return [];

  const trimmed = email.trim().toLowerCase();
  // Gmail accepts a relative `newer_than:Nd` query — convert sinceMinutes to days.
  const days = Math.max(1, Math.ceil(sinceMinutes / (60 * 24)));
  const q = `(from:${trimmed} OR to:${trimmed} OR cc:${trimmed}) newer_than:${days}d`;

  // Step 1: list thread IDs
  const listRes = await fetch(
    `${GMAIL_API}/threads?q=${encodeURIComponent(q)}&maxResults=${MAX_THREADS_TO_PULL}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    },
  );
  if (!listRes.ok) {
    const errText = await listRes.text().catch(() => "");
    console.error(`[gmail] threads.list ${listRes.status}:`, errText);
    return [];
  }
  const listData = (await listRes.json()) as { threads?: Array<{ id: string }> };
  const threadIds = (listData.threads ?? []).map((t) => t.id);
  if (threadIds.length === 0) return [];

  // Step 2: fetch each thread (limit concurrency to 5).
  const messages: GmailMessage[] = [];
  const CONCURRENCY = 5;
  for (let i = 0; i < threadIds.length; i += CONCURRENCY) {
    const slice = threadIds.slice(i, i + CONCURRENCY);
    const threadResults = await Promise.all(
      slice.map(async (id) => {
        const r = await fetch(`${GMAIL_API}/threads/${id}?format=full`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        if (!r.ok) return [] as GmailMessage[];
        const data = (await r.json()) as { messages?: GmailFullMessage[] };
        const msgs = (data.messages ?? []).slice(0, MAX_MESSAGES_PER_THREAD).map(shapeMessage);
        return msgs;
      }),
    );
    for (const arr of threadResults) messages.push(...arr);
  }

  // Sort oldest-first to match the timeline merger contract.
  messages.sort((a, b) => {
    const ta = a.date ? new Date(a.date).getTime() : 0;
    const tb = b.date ? new Date(b.date).getTime() : 0;
    return ta - tb;
  });

  return messages;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

interface SendOpts {
  to: string;
  subject: string;
  body: string;
  /** When true, create a Gmail draft instead of sending. */
  asDraft?: boolean;
}

export type GmailAuditStatus = "confirmed_success" | "confirmed_failure" | "uncertain";

export interface GmailSendResult {
  success: boolean;
  audit_status: GmailAuditStatus;
  messageId?: string;
  threadId?: string;
  draftId?: string;
  draftUrl?: string;
  // Post-send verification surfaces:
  labelsConfirmed?: string[]; // labels on the message in Gmail (expect "SENT")
  headersConfirmed?: { to?: string; subject?: string };
  verifyError?: string; // populated when POST succeeded but GET verification failed
  fallbackMailto?: string;
  error?: string;
}

let cachedAccessToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string | null> {
  const clientId = process.env.GMAIL_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GMAIL_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return null;

  if (cachedAccessToken && Date.now() < cachedAccessToken.expiresAt - 30_000) {
    return cachedAccessToken.token;
  }

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
    cache: "no-store",
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) return null;
  cachedAccessToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  return data.access_token;
}

function base64Url(input: string): string {
  return Buffer.from(input, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function buildRfc822(opts: SendOpts, fromAddress: string): string {
  const headers = [
    `From: ${fromAddress}`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    "Content-Type: text/plain; charset=UTF-8",
    "MIME-Version: 1.0",
  ].join("\r\n");
  return `${headers}\r\n\r\n${opts.body}`;
}

function mailtoFallback(opts: SendOpts): string {
  return `mailto:${opts.to}?subject=${encodeURIComponent(opts.subject)}&body=${encodeURIComponent(opts.body)}`;
}

// Verify a sent message by GETing it back from Gmail. The POST /send
// response says "Gmail accepted the message"; the GET confirms it
// actually landed in the Sent folder with the expected envelope. Per
// the Positive Confirmation Principle: a 200 from /send is not proof
// of state. We need a read-back.
//
// Returns:
//   confirmed_success — message is in Sent, To header matches
//   uncertain         — GET failed OR labels/headers don't match (Gmail
//                       accepted the message but we can't verify its
//                       final state — could be flagged, queued, etc.)
async function verifySentMessage(
  token: string,
  messageId: string,
  expectedTo: string,
): Promise<{
  audit_status: "confirmed_success" | "uncertain";
  labels?: string[];
  headers?: { to?: string; subject?: string };
  error?: string;
}> {
  try {
    const res = await fetch(
      `${GMAIL_API}/messages/${encodeURIComponent(messageId)}?format=metadata&metadataHeaders=To&metadataHeaders=Subject`,
      {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      },
    );
    if (!res.ok) {
      return {
        audit_status: "uncertain",
        error: `verify GET ${res.status}: ${await res.text().catch(() => "(no body)")}`,
      };
    }
    const data = (await res.json()) as {
      labelIds?: string[];
      payload?: { headers?: Array<{ name: string; value: string }> };
    };
    const labels = data.labelIds ?? [];
    const headers = (data.payload?.headers ?? []).reduce<
      Record<string, string>
    >((acc, h) => {
      acc[h.name.toLowerCase()] = h.value;
      return acc;
    }, {});

    const inSent = labels.includes("SENT");
    const toMatches = (headers.to ?? "").toLowerCase().includes(expectedTo.toLowerCase());

    if (!inSent || !toMatches) {
      return {
        audit_status: "uncertain",
        labels,
        headers: { to: headers.to, subject: headers.subject },
        error: !inSent
          ? "Gmail returned the message but it's NOT labeled SENT — may still be in queue or rejected"
          : `To header mismatch — expected "${expectedTo}" not present in "${headers.to}"`,
      };
    }

    return {
      audit_status: "confirmed_success",
      labels,
      headers: { to: headers.to, subject: headers.subject },
    };
  } catch (err) {
    return { audit_status: "uncertain", error: `verify threw: ${String(err)}` };
  }
}

export async function sendEmail(opts: SendOpts): Promise<GmailSendResult> {
  const t0 = Date.now();
  const fromAddress = process.env.GMAIL_FROM_ADDRESS;
  const token = await getAccessToken();
  if (!token || !fromAddress) {
    const result: GmailSendResult = {
      success: false,
      audit_status: "confirmed_failure",
      fallbackMailto: mailtoFallback(opts),
      error: "Gmail OAuth not configured",
    };
    await audit({
      agent: "gmail",
      event: opts.asDraft ? "draft_attempt" : "send_attempt",
      status: "confirmed_failure",
      inputSummary: { to: maskEmail(opts.to), subject_len: opts.subject.length, asDraft: !!opts.asDraft },
      error: result.error,
      ms: Date.now() - t0,
    });
    return result;
  }

  const raw = base64Url(buildRfc822(opts, fromAddress));

  if (opts.asDraft) {
    const res = await fetch(`${GMAIL_API}/drafts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: { raw } }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      const result: GmailSendResult = {
        success: false,
        audit_status: "confirmed_failure",
        error: `Gmail draft ${res.status}: ${errText}`,
        fallbackMailto: mailtoFallback(opts),
      };
      await audit({
        agent: "gmail",
        event: "draft_attempt",
        status: "confirmed_failure",
        inputSummary: { to: maskEmail(opts.to), subject_len: opts.subject.length },
        error: result.error,
        ms: Date.now() - t0,
      });
      return result;
    }
    const data = (await res.json()) as { id?: string; message?: { id?: string } };
    // Draft creation: success means Gmail accepted + stored. No verify
    // GET needed — drafts don't have a "sent" terminal state.
    const result: GmailSendResult = {
      success: true,
      audit_status: "confirmed_success",
      draftId: data.id,
      messageId: data.message?.id,
      draftUrl: data.id ? `https://mail.google.com/mail/u/0/#drafts/${data.id}` : undefined,
    };
    await audit({
      agent: "gmail",
      event: "draft_attempt",
      status: "confirmed_success",
      externalId: data.id,
      inputSummary: { to: maskEmail(opts.to), subject_len: opts.subject.length },
      outputSummary: { draft_id: data.id, message_id: data.message?.id },
      decision: "drafted",
      ms: Date.now() - t0,
    });
    return result;
  }

  // ── Live send ──────────────────────────────────────────────────────
  const res = await fetch(`${GMAIL_API}/messages/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    const result: GmailSendResult = {
      success: false,
      audit_status: "confirmed_failure",
      error: `Gmail send ${res.status}: ${errText}`,
      fallbackMailto: mailtoFallback(opts),
    };
    await audit({
      agent: "gmail",
      event: "send_attempt",
      status: "confirmed_failure",
      inputSummary: { to: maskEmail(opts.to), subject_len: opts.subject.length },
      error: result.error,
      ms: Date.now() - t0,
    });
    return result;
  }
  const data = (await res.json()) as { id?: string; threadId?: string };
  if (!data.id) {
    // POST returned 2xx but no message ID — Gmail accepted but we have
    // nothing to verify against. Uncertain per the Principle.
    const result: GmailSendResult = {
      success: true,
      audit_status: "uncertain",
      threadId: data.threadId,
      verifyError: "Gmail send returned 2xx with no message id — cannot verify",
    };
    await audit({
      agent: "gmail",
      event: "send_attempt",
      status: "uncertain",
      inputSummary: { to: maskEmail(opts.to), subject_len: opts.subject.length },
      outputSummary: { thread_id: data.threadId },
      error: result.verifyError,
      decision: "no_message_id",
      ms: Date.now() - t0,
    });
    return result;
  }

  // Verify via GET. Adds ~100-300ms per send + extra API quota; the
  // principle requires it.
  const verify = await verifySentMessage(token, data.id, opts.to);
  const result: GmailSendResult = {
    success: true,
    audit_status: verify.audit_status,
    messageId: data.id,
    threadId: data.threadId,
    labelsConfirmed: verify.labels,
    headersConfirmed: verify.headers,
    verifyError: verify.error,
  };
  await audit({
    agent: "gmail",
    event: "send_attempt",
    status: verify.audit_status,
    externalId: data.id,
    inputSummary: { to: maskEmail(opts.to), subject_len: opts.subject.length },
    outputSummary: {
      message_id: data.id,
      thread_id: data.threadId,
      labels: verify.labels,
      to_header: verify.headers?.to,
      subject_header: verify.headers?.subject,
    },
    error: verify.error,
    decision: verify.audit_status === "confirmed_success" ? "verified_sent" : "verification_failed",
    ms: Date.now() - t0,
  });
  return result;
}

function maskEmail(addr: string): string {
  const at = addr.indexOf("@");
  if (at <= 1) return "***";
  return `${addr[0]}***${addr.slice(at)}`;
}
