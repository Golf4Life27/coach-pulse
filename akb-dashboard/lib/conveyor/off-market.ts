// Off-market veto guard helpers — pure, vendor-agnostic, called from
// surfaces that detect a listing flipping off-market (verify-listing
// route, future cron sweepers).
//
// The two predicates feed canAutoDispose({hasDeliveredOffer,
// hasOpenThread}) in lib/conveyor/park. When BOTH are false a deal can
// be auto-disposed (the listing went off-market silently and nobody is
// mid-conversation). If EITHER is true the deal parks for operator
// review instead — the "listing status changed mid-negotiation"
// queue item.

/** outreachStatus values that mean an offer was actually delivered to
 *  the agent. Empty/null/"Review"/"Manual Review"/"Dead" are NOT
 *  delivered. Set is closed under the Pipeline_State spec v1 §3 stage
 *  mapping; new statuses must be added explicitly. */
export const DELIVERED_OUTREACH_STATUSES: ReadonlySet<string> = new Set([
  "Texted",
  "Texted (Portfolio)",
  "Emailed",
  "Response Received",
  "Negotiating",
  "Counter Received",
  "Offer Accepted",
  "Contract Signed",
]);

export function hasDeliveredOfferFor(outreachStatus: string | null | undefined): boolean {
  if (!outreachStatus) return false;
  return DELIVERED_OUTREACH_STATUSES.has(outreachStatus);
}

const DEFAULT_OPEN_THREAD_WINDOW_MS = 30 * 24 * 3_600_000;

/** A conversation thread is "open" iff inbound OR outbound activity is
 *  within the window. 30 days by default — matches the resurrection
 *  candidate window used by lib/airtable.ts:455. */
export function hasOpenThreadFrom(
  lastInboundAt: string | null | undefined,
  lastOutboundAt: string | null | undefined,
  now: Date = new Date(),
  windowMs: number = DEFAULT_OPEN_THREAD_WINDOW_MS,
): boolean {
  const cutoff = now.getTime() - windowMs;
  for (const ts of [lastInboundAt, lastOutboundAt]) {
    if (!ts) continue;
    const t = Date.parse(ts);
    if (Number.isFinite(t) && t >= cutoff) return true;
  }
  return false;
}
