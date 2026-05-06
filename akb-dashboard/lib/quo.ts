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

function parseMessages(data: Record<string, unknown>): QuoMessage[] {
  const records = (data.data as Array<Record<string, unknown>>) || [];
  return records.map((m) => ({
    id: (m.id as string) ?? "",
    from: (m.from as string) ?? "",
    to: (m.to as string) ?? "",
    body: (m.body as string) ?? (m.content as string) ?? "",
    direction: (m.direction as "incoming" | "outgoing") ?? "incoming",
    createdAt: (m.createdAt as string) ?? "",
  }));
}

export async function getMessagesForParticipant(
  participantPhone: string,
  sinceMinutes: number = 60
): Promise<QuoMessage[]> {
  const since = new Date(Date.now() - sinceMinutes * 60_000).toISOString();

  const url = new URL("https://api.openphone.com/v1/messages");
  url.searchParams.set("phoneNumberId", QUO_PHONE_ID);
  url.searchParams.append("participants", participantPhone);
  url.searchParams.set("createdAfter", since);
  url.searchParams.set("maxResults", "10");

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

  const data = await res.json();
  return parseMessages(data);
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
