// M6 Reply Capture & Triage — shared inbound types. @agent: outreach
//
// One InboundMessage shape for BOTH channels (Quo SMS, Gmail) so the pure
// match/triage/capture pipeline is channel-agnostic. The channel-specific
// adapters (webhook-parse for Quo, gmail-capture for Gmail) map their raw
// payloads onto this before anything downstream runs.

export type InboundChannel = "sms" | "email";

export interface InboundMessage {
  channel: InboundChannel;
  /** Idempotency id — Quo activity id (AC…) for SMS, Gmail message id for email. */
  externalId: string;
  /** E.164 phone (sms) or email address (email) of the sender. */
  sender: string;
  /** Verbatim reply body. */
  body: string;
  /** ISO timestamp of receipt. */
  receivedAt: string;
  /** Quo conversation id / Gmail thread id, when available. */
  threadId?: string | null;
  /** Email subject (email only). */
  subject?: string | null;
}

/** Minimal listing shape the matcher needs — deliberately decoupled from the
 *  full Listing type so the pure pipeline stays I/O-free and easy to test. */
export interface MatchableListing {
  id: string;
  agentPhone: string | null;
  agentEmail: string | null;
  outreachStatus: string | null;
}
