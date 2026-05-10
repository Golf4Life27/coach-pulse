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

export interface GmailSendResult {
  success: boolean;
  messageId?: string;
  draftId?: string;
  draftUrl?: string;
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

export async function sendEmail(opts: SendOpts): Promise<GmailSendResult> {
  const fromAddress = process.env.GMAIL_FROM_ADDRESS;
  const token = await getAccessToken();
  if (!token || !fromAddress) {
    return { success: false, fallbackMailto: mailtoFallback(opts), error: "Gmail OAuth not configured" };
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
      return { success: false, error: `Gmail draft ${res.status}: ${errText}`, fallbackMailto: mailtoFallback(opts) };
    }
    const data = (await res.json()) as { id?: string; message?: { id?: string } };
    return {
      success: true,
      draftId: data.id,
      messageId: data.message?.id,
      draftUrl: data.id ? `https://mail.google.com/mail/u/0/#drafts/${data.id}` : undefined,
    };
  }

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
    return { success: false, error: `Gmail send ${res.status}: ${errText}`, fallbackMailto: mailtoFallback(opts) };
  }
  const data = (await res.json()) as { id?: string };
  return { success: true, messageId: data.id };
}
