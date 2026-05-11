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

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Quo send error ${res.status}: ${errText}`);
  }
}
