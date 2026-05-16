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
  content: string
): Promise<void> {
  // Back-compat shim — discards the queued id. New call sites should use
  // sendMessageWithId() and poll getMessageStatus() per Positive
  // Confirmation Principle.
  await sendMessageWithId(to, content);
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
): Promise<QuoSendResult> {
  if (!QUO_API_KEY) {
    throw new Error("QUO_API_KEY not set");
  }
  const res = await fetch("https://api.openphone.com/v1/messages", {
    method: "POST",
    headers: {
      Authorization: QUO_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: QUO_PHONE_ID,
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
