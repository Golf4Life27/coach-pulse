// M6 — Quo (OpenPhone) inbound-webhook payload adapter. @agent: outreach
//
// Quo posts inbound SMS as { data: { object: { id, from, body/text, createdAt,
// direction, conversationId } } } (the same shape the live Make L3 scenario
// reads via 1.data.object.from/body). This maps it onto InboundMessage.
//
// FAIL-CLOSED: anything that isn't a usable INCOMING message with an id, a
// from, and a non-empty body → null (the route 200s and writes nothing).
// Never fabricates a sender or body. PURE — no I/O.

import { toE164 } from "@/lib/phone";
import type { InboundMessage } from "./types";

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

export function parseQuoWebhookPayload(payload: unknown): InboundMessage | null {
  const data = asRecord(asRecord(payload)?.data);
  const obj = asRecord(data?.object);
  if (!obj) return null;

  // Only inbound. Quo marks inbound as "incoming"; an outbound echo must not
  // be captured as a reply. An absent direction is allowed (treated inbound).
  const direction = String(obj.direction ?? "").toLowerCase();
  if (direction && direction !== "incoming") return null;

  const from = typeof obj.from === "string" ? obj.from : "";
  const body =
    typeof obj.body === "string" ? obj.body : typeof obj.text === "string" ? obj.text : "";
  const id = typeof obj.id === "string" ? obj.id : "";
  if (!from || !id || !body.trim()) return null;

  return {
    channel: "sms",
    externalId: id,
    sender: toE164(from),
    body,
    receivedAt: typeof obj.createdAt === "string" ? obj.createdAt : new Date().toISOString(),
    threadId: typeof obj.conversationId === "string" ? obj.conversationId : null,
  };
}
