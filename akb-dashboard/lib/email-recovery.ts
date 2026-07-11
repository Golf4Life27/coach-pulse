// Email recovery lane (operator "get started" 2026-07-11) — pure logic.
// @agent: crier
//
// THE FOUND MONEY: when the carrier confirms a number can't receive SMS,
// the send path quarantines the record as Dead — even when Agent_Email is
// sitting right there. Every such record is crawled, verified, and
// priceable inventory abandoned over a transport failure. This lane gives
// exactly that cohort ONE value-anchored email opener.
//
// DOCTRINE:
//   - First touch by email (the SMS never delivered — there is no sticky
//     number to honor). The number in the email comes from the SAME seed
//     pricer as the SMS opener, with every guard intact: HOLD → skip,
//     never a list fraction (INVARIANTS §2).
//   - Do_Not_Text is respected across channels — an opted-out human is
//     opted out, full stop (conservative posture).
//   - Business-hours window (property-local 8–20) for reply-rate and
//     decency; per-run cap; one attempt per record ever (KV claim +
//     note stamp check).
//
// PURE. No I/O — the route does the sending.

import type { Listing } from "@/lib/types";
import { SOURCE_VERSION_V2 } from "@/lib/source-version";
import { isActionableMarket } from "@/lib/markets/actionable";
import { firstNameOnly } from "@/lib/h2-outreach";

/** The marker the delivery-quarantine writes into Verification_Notes
 *  (buildDeliveryQuarantineNote): "[H2 quarantine <iso>] Carrier could not
 *  deliver to '<phone>' …". Its presence is what makes a Dead record a
 *  carrier-dead record (vs walked/terminated/no-response). */
const CARRIER_QUARANTINE_RE = /\[H2 quarantine [^\]]*\] Carrier could not deliver/;

/** The stamp THIS lane writes on a successful send — checked for
 *  idempotency (one recovery email per record, ever). */
const EMAIL_SENT_RE = /\[H2 email sent /;

export interface EmailRecoveryVerdict {
  eligible: boolean;
  reason: string | null;
}

export function emailRecoveryVerdict(l: Listing): EmailRecoveryVerdict {
  const skip = (reason: string): EmailRecoveryVerdict => ({ eligible: false, reason });

  if ((l.outreachStatus ?? "").trim() !== "Dead") return skip("not_dead");
  if (!CARRIER_QUARANTINE_RE.test(l.notes ?? "")) return skip("not_carrier_quarantined");
  if (EMAIL_SENT_RE.test(l.notes ?? "")) return skip("recovery_email_already_sent");
  if (l.sourceVersion !== SOURCE_VERSION_V2) return skip("not_v2");
  if (l.doNotText === true) return skip("opted_out");
  const email = (l.agentEmail ?? "").trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return skip("no_valid_email");
  if ((l.liveStatus ?? "").trim() !== "Active") return skip("not_active");
  const market = isActionableMarket({ state: l.state, city: l.city, zip: l.zip });
  if (!market.actionable) return skip(market.reason ?? "market_not_actionable");
  return { eligible: true, reason: null };
}

export function selectEmailRecoveryCandidates(listings: Listing[]): Listing[] {
  return listings
    .filter((l) => emailRecoveryVerdict(l).eligible)
    // Oldest quarantine first — they've waited longest.
    .sort((a, b) => Date.parse(a.lastOutboundAt ?? "") - Date.parse(b.lastOutboundAt ?? ""));
}

/** The email body — the locked relief-framed register, letter form. The
 *  offer is the freshly-priced value-anchored number (the SMS never
 *  delivered, so this is the record's FIRST touch). */
export function buildRecoveryEmail(
  agentName: string | null,
  address: string,
  offer: number,
): { subject: string; body: string } {
  const name = firstNameOnly(agentName);
  const street = address.split(",")[0].trim() || address;
  const amount = `$${Math.round(offer).toLocaleString("en-US")}`;
  return {
    subject: `Cash offer — ${street}`,
    body:
      `Hi ${name},\n\n` +
      `This is Alex with AKB Solutions. I'd like to make a cash offer of ${amount} on ${street}. ` +
      `As-is, no repairs or cleanout, and we close on your timeline.\n\n` +
      `If the seller just wants this off their hands and done, we're ready to move fast. ` +
      `Happy to provide proof of funds.\n\n` +
      `Best,\nAlex Balog\nAKB Solutions LLC\nalex@akb-properties.com\n(815) 556-9965`,
  };
}

/** The delivery stamp — email-channel sibling of the [H2 sent] stamp.
 *  (extractStickyOffer currently parses Quo stamps only; the DD lane's
 *  extractor extension is flagged to the belt session.) */
export function buildEmailSentNote(
  existing: string | null,
  iso: string,
  messageId: string | null,
  subject: string,
  body: string,
): string {
  const line = `[H2 email sent ${iso}] Gmail msg ${messageId ?? "(no id)"}: ${subject} — ${body.split("\n")[2] ?? ""}`;
  const prior = existing ?? "";
  return prior ? `${prior}\n\n${line}` : line;
}
