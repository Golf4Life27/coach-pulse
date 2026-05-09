// Gmail integration.
//
// Two modes:
//   1. (Existing stub) getThreadsForEmail — read email history. Still a
//      stub returning [] until OAuth read scope is wired. Notes already
//      capture email content via the existing scan-replies pipeline.
//   2. (Phase 2) sendEmail / createDraft — send/draft outbound emails to
//      buyers. Uses an OAuth refresh token (no per-user OAuth flow).
//
// Required env for send: GMAIL_OAUTH_CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET,
// GMAIL_REFRESH_TOKEN, GMAIL_FROM_ADDRESS.
//
// When any of these are missing, sendEmail/createDraft fall back to
// returning a mailto: URL so callers can still surface drafts.

export interface GmailMessage {
  id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  date: string;
}

export async function getThreadsForEmail(
  _email: string,
  _sinceMinutes: number = 60 * 24 * 90,
): Promise<GmailMessage[]> {
  return [];
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
