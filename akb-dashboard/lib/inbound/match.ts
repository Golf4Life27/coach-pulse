// M6 — match an inbound reply to a deal record. @agent: outreach
//
// SMS: normalize both sides to E.164 and compare the participant phone to the
// listing's agentPhone. Email: compare the bare sender address to agentEmail.
// No match → null, and the caller routes to the fail-closed catch-all (never
// drops). PURE — no I/O.

import { toE164 } from "@/lib/phone";
import { selectThreadListing } from "@/lib/conversation-thread";
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
  // A phone/email can match SEVERAL of an agent's listings (one thread, many
  // properties). Collect ALL matches and attribute to the ACTIVE-thread listing
  // — the one we most recently texted — instead of the arbitrary first match
  // that flipped the wrong deal's status (operator 2026-07-22, Roberto Carver).
  if (msg.channel === "sms") {
    const want = toE164(msg.sender);
    if (!/\d{7,}/.test(want)) return null; // too few digits to be a real phone
    const matches = listings.filter((l) => l.agentPhone && toE164(l.agentPhone) === want);
    return selectThreadListing(
      matches.map((l) => ({
        id: l.id,
        lastInboundAt: l.lastInboundAt ?? null,
        lastOutboundAt: l.lastOutboundAt ?? null,
        outreachStatus: l.outreachStatus,
        _row: l,
      })),
    )?._row ?? null;
  }
  const want = extractEmailAddress(msg.sender);
  if (!want.includes("@")) return null;
  const matches = listings.filter((l) => l.agentEmail && extractEmailAddress(l.agentEmail) === want);
  return selectThreadListing(
    matches.map((l) => ({
      id: l.id,
      lastInboundAt: l.lastInboundAt ?? null,
      lastOutboundAt: l.lastOutboundAt ?? null,
      outreachStatus: l.outreachStatus,
      _row: l,
    })),
  )?._row ?? null;
}
