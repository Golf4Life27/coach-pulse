// H2 bump lane (#33, operator build order 2026-07-09/11) — pure logic.
// @agent: crier
//
// Day-3 / day-7 re-touch of SILENT first-touch threads. The cheap send
// multiplier: a delivered opener that never got a reply gets exactly two
// bumps, then goes quiet (the parked/d3 timeout owns the tail).
//
// DOCTRINE, encoded here:
//   - FORWARD-ONLY (The Forward Ruling, spine rec8wKrqajIXYQXbq): v2-era
//     threads only (Source_Version gate). Legacy inventory is dead; a bump
//     never digs up an old thread. Inbound revives a thread — but a thread
//     with ANY inbound belongs to the classifier/reply lane, never to this
//     one (silent threads only).
//   - STICKY NUMBER FROM THE DELIVERY STAMP, never a field (P3 field-drift
//     evidence, spine recqoiPxXy1Ybmib7: Ave I field $28,900 vs stamped
//     $12,000). The number we re-text is parsed from the `[H2 sent …]`
//     Verification_Notes stamp the send path wrote on CONFIRMED delivery —
//     the number the agent actually received. No stamp → no bump, ever.
//     We never recompute, never improvise (INVARIANTS §3 sticky offers).
//   - FRESHNESS: a bump is a real SMS about a live listing — same 48h
//     confirmed-on-market window as a first touch. The freshness-reverify
//     pass re-admits bump-waiting Texted records (budget-partitioned, see
//     partitionReverifyBatch) so this gate is satisfiable; spine
//     recFYBbF5H9YU1GWm ruled re-admit-on-bump-lane-ship, not before.
//
// PURE. No I/O, no clock (caller passes `now`). The route does the sending.

import type { Listing } from "@/lib/types";
import { normalizePhone } from "@/lib/phone-normalize";
import { SOURCE_VERSION_V2 } from "@/lib/source-version";
import { isActionableMarket } from "@/lib/markets/actionable";
import { isOutreachFresh, DEFAULT_FRESHNESS_HOURS } from "@/lib/outreach-freshness";
import { firstNameOnly } from "@/lib/h2-outreach";

/** Two bumps, then silence. The tail (auto-dead at cadence timeout) belongs
 *  to the parked/d3 lane — this lane never disposes. */
export const BUMP_MAX_ATTEMPTS = 2;

/** Days since the LAST outbound before each attempt is due: bump 1 fires
 *  3 days after the first touch; bump 2 fires 4 days after bump 1 — day ~7
 *  of a silent thread. Index = Follow_Up_Count at plan time. */
export const BUMP_GAP_DAYS: readonly number[] = [3, 4];

/** Share of each freshness-reverify batch reservable by bump-waiting Texted
 *  records. The 2026-07-09 budget theft (spine recFYBbF5H9YU1GWm) was Texted
 *  records consuming the ENTIRE re-verify budget ahead of sendable supply —
 *  re-admission is therefore minority-share by construction: first-touch
 *  supply and live threads keep ≥60% of every batch when they need it. */
export const BUMP_REVERIFY_SHARE = 0.4;

const HOUR_MS = 3_600_000;

// ── Sticky number extraction ─────────────────────────────────────────────

/** Matches the delivery stamps the send paths write on CONFIRMED delivery:
 *    `[H2 sent <iso>] Quo msg <id>: <body>`        (first touch)
 *    `[H2 bump N sent <iso>] Quo msg <id>: <body>` (this lane)
 *  Bodies are single-line (notes append with \n\n). */
const STAMP_RE = /\[H2 (?:bump \d+ )?sent ([^\]]+)\] Quo msg [^:]*: (.*)/g;
const AMOUNT_RE = /\$(\d{1,3}(?:,\d{3})+|\d+)/;

export interface StickyStamp {
  /** The dollar amount the agent actually received. */
  offer: number;
  /** ISO timestamp of the stamp the amount was parsed from. */
  iso: string;
  /** The full stamped SMS body (for audit/telemetry). */
  body: string;
}

/** Parse the sticky offer from the LAST delivery stamp in Verification_Notes.
 *  Returns null when there is no stamp or the stamp carries no parseable
 *  amount — in which case the record must NOT be bumped (fail closed; a
 *  drifted field is never a fallback). */
export function extractStickyOffer(notes: string | null | undefined): StickyStamp | null {
  if (!notes) return null;
  let last: RegExpExecArray | null = null;
  STAMP_RE.lastIndex = 0;
  for (let m = STAMP_RE.exec(notes); m !== null; m = STAMP_RE.exec(notes)) {
    last = m;
  }
  if (!last) return null;
  const body = last[2] ?? "";
  const amt = AMOUNT_RE.exec(body);
  if (!amt) return null;
  const offer = Number(amt[1].replace(/,/g, ""));
  if (!Number.isFinite(offer) || offer <= 0) return null;
  return { offer, iso: last[1], body };
}

// ── Eligibility ──────────────────────────────────────────────────────────

export interface BumpVerdict {
  due: boolean;
  /** 1-based attempt number this record is due for (Follow_Up_Count + 1). */
  attempt: number | null;
  reason: string | null;
}

/** Pure: is this listing due for a bump right now? Order matters — cheap
 *  identity gates first, then the clock, then market + freshness. */
export function bumpVerdict(
  l: Listing,
  now: Date = new Date(),
  maxAgeHours: number = DEFAULT_FRESHNESS_HOURS,
): BumpVerdict {
  const skip = (reason: string): BumpVerdict => ({ due: false, attempt: null, reason });

  if ((l.outreachStatus ?? "").trim() !== "Texted") return skip("not_texted");
  if (l.sourceVersion !== SOURCE_VERSION_V2) return skip("not_v2");
  if (l.doNotText === true) return skip("do_not_text");
  if (!normalizePhone(l.agentPhone)) return skip("no_valid_phone");
  // ANY inbound ever → the thread is conversational; the reply/classifier
  // lane owns it. Silent threads only.
  if (l.lastInboundAt && l.lastInboundAt.trim() !== "") return skip("has_inbound");

  const count = l.followUpCount ?? 0;
  if (count >= BUMP_MAX_ATTEMPTS) return skip("bump_exhausted");

  if (!l.lastOutboundAt) return skip("no_outbound_stamp");
  const t = Date.parse(l.lastOutboundAt);
  if (!Number.isFinite(t)) return skip("outbound_stamp_unparseable");
  const gapHours = BUMP_GAP_DAYS[count] * 24;
  const ageHours = (now.getTime() - t) / HOUR_MS;
  if (ageHours < gapHours) return skip("not_yet_due");

  const market = isActionableMarket({ state: l.state, city: l.city, zip: l.zip });
  if (!market.actionable) return skip(market.reason ?? "market_not_actionable");

  const fresh = isOutreachFresh(
    { lastVerified: l.lastVerified, liveStatus: l.liveStatus },
    now,
    maxAgeHours,
  );
  if (!fresh.fresh) return skip(fresh.reason ?? "not_fresh");

  return { due: true, attempt: count + 1, reason: null };
}

/** Pure: the bump queue — due records, oldest silent thread first. */
export function selectBumpDue(listings: Listing[], now: Date = new Date()): Listing[] {
  return listings
    .filter((l) => bumpVerdict(l, now).due)
    .sort((a, b) => Date.parse(a.lastOutboundAt ?? "") - Date.parse(b.lastOutboundAt ?? ""));
}

/** Reply-bearing statuses — a normalized agent phone with ANY listing in one
 *  of these is in a live human conversation; a robo-bump on a sibling thread
 *  would step on it. */
const LIVE_THREAD_STATUSES: ReadonlySet<string> = new Set([
  "Response Received",
  "Negotiating",
  "Counter Received",
  "Offer Accepted",
  "Inbound Lead",
]);

/** Pure: normalized phones currently in a live (reply-bearing) thread. */
export function liveThreadPhoneIndex(listings: Listing[]): Set<string> {
  const index = new Set<string>();
  for (const l of listings) {
    if (!LIVE_THREAD_STATUSES.has((l.outreachStatus ?? "").trim())) continue;
    const key = normalizePhone(l.agentPhone);
    if (key) index.add(key);
  }
  return index;
}

// ── Message copy ─────────────────────────────────────────────────────────

/** Compose the bump SMS. Same relief-framed register as the locked first-touch
 *  copy (operator 2026-06-30): the STICKY number restated, as-is / no-repairs /
 *  their-timeline, zero pressure. Street only — the full address carries a
 *  redundant city/state/zip tail. */
export function buildBumpMessage(
  agentName: string | null,
  address: string,
  stickyOffer: number,
  attempt: number,
): string {
  const name = firstNameOnly(agentName);
  const offer = `$${Math.round(stickyOffer).toLocaleString("en-US")}`;
  const street = address.split(",")[0].trim() || address;
  if (attempt <= 1) {
    return (
      `Hi ${name}, Alex with AKB Solutions — following up on ${street}. My cash ` +
      `offer of ${offer} still stands: as-is, no repairs or cleanout, and we close ` +
      `on your timeline. Happy to answer any questions.`
    );
  }
  return (
    `Hi ${name}, last follow-up from me on ${street}. ${offer} cash, as-is, ` +
    `quick close — if the seller's moved on, no worries at all. Otherwise ` +
    `I'm ready when you are.`
  );
}

/** The bump delivery stamp — same grammar as the first-touch stamp so
 *  extractStickyOffer reads either (the bump body restates the same sticky
 *  number, so stickiness survives any number of bumps). */
export function buildBumpSentNote(
  existing: string | null,
  iso: string,
  attempt: number,
  messageId: string | null,
  message: string,
): string {
  const line = `[H2 bump ${attempt} sent ${iso}] Quo msg ${messageId ?? "(no id)"}: ${message}`;
  const prior = existing ?? "";
  return prior ? `${prior}\n\n${line}` : line;
}

// ── Freshness-reverify re-admission (budget-partitioned) ─────────────────

/** Pure: should the freshness-reverify pass keep THIS Texted record warm?
 *  Only bump-waiting silent v2 threads whose next bump is due now or inside
 *  the freshness window (so the verify credit buys a POSSIBLE send, never
 *  keep-warm on dead air — the exact 2026-07-09 budget theft this guards). */
export function isBumpReverifyCandidate(l: Listing, now: Date = new Date()): boolean {
  if ((l.outreachStatus ?? "").trim() !== "Texted") return false;
  if (l.sourceVersion !== SOURCE_VERSION_V2) return false;
  if (l.doNotText === true) return false;
  if (l.lastInboundAt && l.lastInboundAt.trim() !== "") return false;
  const count = l.followUpCount ?? 0;
  if (count >= BUMP_MAX_ATTEMPTS) return false;
  if (!l.lastOutboundAt) return false;
  const t = Date.parse(l.lastOutboundAt);
  if (!Number.isFinite(t)) return false;
  const gapHours = BUMP_GAP_DAYS[count] * 24;
  const ageHours = (now.getTime() - t) / HOUR_MS;
  // Due now, or due before a fresh verify stamp would expire.
  return gapHours - ageHours <= DEFAULT_FRESHNESS_HOURS;
}

/** Pure: compose a reverify batch from the core pool (first-touch supply +
 *  live threads + liveness-unknown — always priority) and the bump-waiting
 *  pool (minority share). Bump records get at most `share` of the limit,
 *  but may backfill slots the core pool doesn't need. */
export function partitionReverifyBatch<T>(
  core: T[],
  bump: T[],
  limit: number,
  share: number = BUMP_REVERIFY_SHARE,
): { batch: T[]; coreTaken: number; bumpTaken: number } {
  if (limit <= 0) return { batch: [], coreTaken: 0, bumpTaken: 0 };
  const reserved = Math.min(Math.floor(limit * share), bump.length);
  const coreTaken = Math.min(core.length, limit - reserved);
  const bumpTaken = Math.min(bump.length, limit - coreTaken);
  return {
    batch: [...core.slice(0, coreTaken), ...bump.slice(0, bumpTaken)],
    coreTaken,
    bumpTaken,
  };
}
