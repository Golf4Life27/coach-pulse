// M6 — match an inbound reply to a deal record. @agent: outreach
//
// SMS: normalize both sides to E.164 and compare the participant phone to the
// listing's agentPhone. Email: compare the bare sender address to agentEmail.
// No match → null, and the caller routes to the fail-closed catch-all (never
// drops). PURE — no I/O.

import { toE164 } from "@/lib/phone";
import type { InboundMessage, MatchableListing } from "./types";

/** Pure: extract a bare lowercased email address from a From-header value
 *  ("Leonard P <lp@x.com>" → "lp@x.com"; "LP@x.com" → "lp@x.com"). */
export function extractEmailAddress(raw: string | null | undefined): string {
  const s = (raw ?? "").trim();
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim().toLowerCase();
}

/** Pure: match an inbound message to a live listing by participant phone (sms)
 *  or agent email (email). Returns null when nothing matches. */
export function matchInboundToListing(
  msg: InboundMessage,
  listings: MatchableListing[],
): MatchableListing | null {
  if (msg.channel === "sms") {
    const want = toE164(msg.sender);
    if (!/\d{7,}/.test(want)) return null; // too few digits to be a real phone
    return listings.find((l) => l.agentPhone && toE164(l.agentPhone) === want) ?? null;
  }
  const want = extractEmailAddress(msg.sender);
  if (!want.includes("@")) return null;
  return listings.find((l) => l.agentEmail && extractEmailAddress(l.agentEmail) === want) ?? null;
}
