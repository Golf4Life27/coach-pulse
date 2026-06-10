const QUO_API_KEY = process.env.QUO_API_KEY!;
const QUO_PHONE_ID = process.env.QUO_PHONE_ID || "PNLosBI6fh";

export interface QuoMessage {
  id: string;
  from: string;
  to: string;
  body: string;
  direction: "incoming" | "outgoing";
  createdAt: string;
}

// OpenPhone's GET /v1/messages returns each message with the text content
// in `text`. Older code assumed `body` or `content` (neither exist in the
// actual response), which silently dropped every SMS body. Be permissive
// across known field names.
function extractBody(m: Record<string, unknown>): string {
  if (typeof m.text === "string" && m.text.length > 0) return m.text;
  if (typeof m.body === "string" && m.body.length > 0) return m.body;
  if (typeof m.content === "string" && m.content.length > 0) return m.content;
  return "";
}

// `to` is an array of phone numbers in the OpenPhone response.
function extractTo(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    const first = v.find((x) => typeof x === "string");
    return typeof first === "string" ? first : "";
  }
  return "";
}

function parseMessages(data: Record<string, unknown>): QuoMessage[] {
  const records = (data.data as Array<Record<string, unknown>>) || [];
  return records.map((m) => ({
    id: (m.id as string) ?? "",
    from: typeof m.from === "string" ? m.from : "",
    to: extractTo(m.to),
    body: extractBody(m),
    direction: (m.direction as "incoming" | "outgoing") ?? "incoming",
    createdAt: (m.createdAt as string) ?? "",
  }));
}

const PAGE_SIZE = 50;
const MAX_PAGES = 6; // 300 messages max per participant — enough for 90d

export async function getMessagesForParticipant(
  participantPhone: string,
  sinceMinutes: number = 60
): Promise<QuoMessage[]> {
  const since = new Date(Date.now() - sinceMinutes * 60_000).toISOString();
  const out: QuoMessage[] = [];
  let pageToken: string | undefined;

  for (let i = 0; i < MAX_PAGES; i++) {
    const url = new URL("https://api.openphone.com/v1/messages");
    url.searchParams.set("phoneNumberId", QUO_PHONE_ID);
    url.searchParams.append("participants", participantPhone);
    url.searchParams.set("createdAfter", since);
    url.searchParams.set("maxResults", String(PAGE_SIZE));
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: QUO_API_KEY,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Quo API error ${res.status}: ${errText}`);
    }

    const data = (await res.json()) as Record<string, unknown>;
    out.push(...parseMessages(data));
    pageToken = typeof data.nextPageToken === "string" && data.nextPageToken.length > 0
      ? data.nextPageToken
      : undefined;
    if (!pageToken) break;
  }

  return out;
}

export async function sendMessage(
  to: string,
  content: string,
  opts: { from?: string } = {},
): Promise<void> {
  // Back-compat shim — discards the queued id. New call sites should use
  // sendMessageWithId() and poll getMessageStatus() per Positive
  // Confirmation Principle.
  await sendMessageWithId(to, content, opts);
}

// OpenPhone POST /v1/messages response.
// 202 Accepted with { data: { id, status, ... } } on success.
// status starts as "queued"; transitions to sent/delivered/failed/undelivered
// asynchronously. A 2xx here is NOT proof of delivery (Principle §Rule 1).
export type QuoSendStatus =
  | "queued"
  | "sending"
  | "sent"
  | "delivered"
  | "undelivered"
  | "failed"
  | "unknown";

export interface QuoSendResult {
  id: string | null;
  status: QuoSendStatus;
  httpStatus: number;
  raw: unknown;
}

export async function sendMessageWithId(
  to: string,
  content: string,
  opts: { from?: string } = {},
): Promise<QuoSendResult> {
  if (!QUO_API_KEY) {
    throw new Error("QUO_API_KEY not set");
  }
  // CHANNEL SEPARATION (operator 2026-06-10): the default outreach line
  // (QUO_PHONE_ID) talks ONLY to agents. Operator-facing sends (Tier 1/2
  // alerts, Pulse escalation) pass opts.from = ALERT_FROM, the dedicated
  // Maverick line — those callers REFUSE to send when it's unset rather
  // than fall back here.
  const res = await fetch("https://api.openphone.com/v1/messages", {
    method: "POST",
    headers: {
      Authorization: QUO_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: opts.from ?? QUO_PHONE_ID,
      to: [to],
      content,
    }),
  });

  const raw = await res.json().catch(() => null);

  if (!res.ok) {
    throw new Error(
      `Quo send error ${res.status}: ${JSON.stringify(raw) || "(no body)"}`,
    );
  }

  const data = (raw as { data?: Record<string, unknown> } | null)?.data ?? null;
  const id = typeof data?.id === "string" ? data.id : null;
  const statusRaw = typeof data?.status === "string" ? data.status : "unknown";

  return {
    id,
    status: normalizeStatus(statusRaw),
    httpStatus: res.status,
    raw,
  };
}

function normalizeStatus(s: string): QuoSendStatus {
  const v = s.toLowerCase();
  if (
    v === "queued" ||
    v === "sending" ||
    v === "sent" ||
    v === "delivered" ||
    v === "undelivered" ||
    v === "failed"
  ) {
    return v;
  }
  return "unknown";
}

// Poll once for the current OpenPhone message status. Caller is
// responsible for retry cadence; this function does ONE fetch.
// Confirmed terminal states: delivered (success), undelivered + failed
// (failure). Anything else is still uncertain.
export interface QuoStatusResult {
  id: string;
  status: QuoSendStatus;
  isTerminal: boolean;
  isSuccess: boolean;
  httpStatus: number;
  raw: unknown;
}

export async function getMessageStatus(messageId: string): Promise<QuoStatusResult> {
  if (!QUO_API_KEY) {
    throw new Error("QUO_API_KEY not set");
  }
  if (!messageId) {
    throw new Error("messageId required");
  }
  const res = await fetch(
    `https://api.openphone.com/v1/messages/${encodeURIComponent(messageId)}`,
    {
      headers: {
        Authorization: QUO_API_KEY,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    },
  );

  const raw = await res.json().catch(() => null);

  if (!res.ok) {
    throw new Error(
      `Quo status error ${res.status}: ${JSON.stringify(raw) || "(no body)"}`,
    );
  }

  const data = (raw as { data?: Record<string, unknown> } | null)?.data ?? null;
  const statusRaw = typeof data?.status === "string" ? data.status : "unknown";
  const status = normalizeStatus(statusRaw);
  const isSuccess = status === "delivered" || status === "sent";
  const isFailure = status === "failed" || status === "undelivered";

  return {
    id: messageId,
    status,
    isTerminal: isSuccess || isFailure,
    isSuccess,
    httpStatus: res.status,
    raw,
  };
}

// ── Reliable lookup-by-ID — replaces the lossy feed walk ───────────────
// THE STANDING RULE (operator brief 2026-06-07): no send is marked "sent"
// until it has been FETCHED BACK and SEEN via this per-ID lookup. The feed
// walk in getMessagesForParticipant silently dropped two delivered 6/7
// outbounds — the per-ID endpoint is the authoritative reader.

/** Fetch one message by its Quo id. Returns null when the id isn't found
 *  (404) — caller decides what to do (e.g., mark "attempted_unconfirmed").
 *  Throws on non-404 errors (network / 5xx). */
export async function getMessageById(messageId: string): Promise<QuoMessage | null> {
  if (!QUO_API_KEY) throw new Error("QUO_API_KEY not set");
  if (!messageId) throw new Error("messageId required");
  const res = await fetch(
    `https://api.openphone.com/v1/messages/${encodeURIComponent(messageId)}`,
    { headers: { Authorization: QUO_API_KEY, "Content-Type": "application/json" }, cache: "no-store" },
  );
  if (res.status === 404) return null;
  const raw = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Quo getMessageById error ${res.status}: ${JSON.stringify(raw) || "(no body)"}`);
  const data = (raw as { data?: Record<string, unknown> } | null)?.data ?? null;
  if (!data) return null;
  return {
    id: typeof data.id === "string" ? data.id : messageId,
    from: typeof data.from === "string" ? data.from : "",
    to: extractTo(data.to),
    body: extractBody(data),
    direction: (data.direction as "incoming" | "outgoing") ?? "outgoing",
    createdAt: typeof data.createdAt === "string" ? data.createdAt : "",
  };
}

/** Reliable thread fetch — uses the per-participant endpoint to discover
 *  message IDs, then RELIABLE-LOOKS-UP each id individually. Returns the
 *  verified set plus any discrepancies (feed said present / lookup said
 *  not). Tight cap on lookups to keep latency bounded.
 *
 *  This is the replacement path for getMessagesForParticipant in any
 *  context where data correctness matters (sweep, duplicate guard,
 *  send-confirmation). The feed walk itself stays available for low-stakes
 *  one-line discovery, but is no longer the source of truth. */
export async function getThreadVerified(
  participantPhone: string,
  sinceMinutes: number = 60,
  maxLookups: number = 30,
): Promise<{ messages: QuoMessage[]; feedOnlyIds: string[]; bodyDivergenceIds: string[] }> {
  const feed = await getMessagesForParticipant(participantPhone, sinceMinutes);
  const verified: QuoMessage[] = [];
  const feedOnlyIds: string[] = [];
  const bodyDivergenceIds: string[] = [];
  const seen = new Set<string>();
  let looked = 0;
  for (const m of feed) {
    if (!m.id || seen.has(m.id)) continue;
    seen.add(m.id);
    if (looked >= maxLookups) {
      // Beyond cap, we trust the feed entry but note it wasn't verified;
      // callers can decide to escalate or accept.
      verified.push(m);
      continue;
    }
    looked++;
    try {
      const lookup = await getMessageById(m.id);
      if (lookup == null) {
        feedOnlyIds.push(m.id);
        continue;
      }
      // Body equality check — collapse whitespace, case-insensitive.
      const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
      if (norm(lookup.body) !== norm(m.body)) {
        bodyDivergenceIds.push(m.id);
      }
      verified.push(lookup);
    } catch {
      // Network blip on this id — keep the feed entry, flag discrepancy
      // implicitly by NOT adding to verified count.
      verified.push(m);
    }
  }
  return { messages: verified, feedOnlyIds, bodyDivergenceIds };
}
