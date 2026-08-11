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
  // RENOVATED-LISTING VETO (operator 2026-07-25): a later verify found the
  // listing markets itself turnkey — never bump a distress number at it
  // (914 Dan St / 529 Bina class; first-touch is vetoed in isH2Eligible).
  if (l.renovatedLanguage === true) return skip("renovated_listing_veto");
  if (!normalizePhone(l.agentPhone)) return skip("no_valid_phone");
  // POST-VISION PARK (operator 2026-07-16): once decision-math has run and
  // the spread is negative — the real rehab revealed the sent opener is above
  // what a buyer pays — stop chasing. No bump ever rides a dead-on-arrival
  // number (the Mayfield/Cheyenne class: placeholder rehab looked light, the
  // vision pass said gut job). The operator can still work it by hand; the
  // machine stops spending touches on it.
  if (typeof l.dealSpread === "number" && Number.isFinite(l.dealSpread) && l.dealSpread < 0) {
    return skip("parked_underwater");
  }
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

// ── Re-price gate (2026-07-27, the 963 W 3rd miss) ───────────────────────
//
// A bump re-quotes the sticky number (INVARIANTS §3 — never recomputed),
// but until now it did so with ZERO current pricing intelligence: none of
// the gates shipped after the first touch (feasibility/infeasible_ask, the
// over-list tripwire, ARV distrust, corroboration) ever inspected a bump.
// 963 W 3rd St: first-touched $57,000 on 2026-07-24 (pre-veto), RentCast
// intake so renovatedLanguage could never be set (the flag lives in the
// Firecrawl page-copy classifier), bumped 2026-07-27 into a fully renovated
// $132,900 listing → "extremely too low" rejection. Doctrine standard 1
// (recompute before queueing) applies to every opener-class send.
//
// The gate: run the canonical pricer (priceOpenerWithSeed) on the record's
// CURRENT inputs. If TODAY's system would refuse to produce any opener for
// this listing, it must also refuse to re-text the number it produced under
// older, dumber rules — skip the bump and surface. The sticky number is
// never modified and never replaced; this is go/no-go, not re-pricing the
// quote. Source-independent, so it protects the RentCast-intake records the
// renovatedLanguage veto is structurally blind to.

export interface BumpRepriceVerdict {
  allowed: boolean;
  /** Skip reason for the audit row when not allowed. */
  reason: string | null;
}

/** Pure verdict over the canonical pricer's output for the CURRENT record
 *  state. Any hold (opener null) blocks the bump; a produced opener — at any
 *  value — allows it (the bump still quotes the STICKY number, never this
 *  one). */
export function bumpRepriceGate(pw: {
  result: { opener: number | null };
  basisLabel: string;
  corroborationFlags: readonly string[];
}): BumpRepriceVerdict {
  if (pw.result.opener != null) return { allowed: true, reason: null };
  const flags = pw.corroborationFlags.length ? ` [${pw.corroborationFlags.join(",")}]` : "";
  return { allowed: false, reason: `reprice_hold_${pw.basisLabel}${flags}` };
}

// ── Send-time thread truth (2026-07-17, the 7714 E Canfield miss) ────────
//
// Airtable state is a CACHE of the thread, not the thread. Two agent
// counters ("Youll need to double it") were never captured during a
// quo-sync gap, so the record still read "Texted, silent" and this lane
// bumped the same number into a live conversation — twice — until the agent
// asked "Are you not getting my texts?". The route therefore asks Quo
// DIRECTLY before every live send: ANY incoming message in the thread means
// it is conversational and belongs to the reply lane, never to this one —
// regardless of what our own records say.

export interface ThreadInboundTruth {
  hasInbound: boolean;
  /** Newest incoming message's timestamp / body (for record healing). */
  lastInboundAt: string | null;
  lastInboundBody: string | null;
}

/** Pure: scan a Quo message page for incoming traffic. Bot autoreplies and
 *  opt-out echoes COUNT — any human-side phone activity disqualifies a
 *  robo-bump (over-abort is free; the reply lane's echo-stripper sorts it). */
export function threadInboundTruth(
  messages: Array<{ direction: string; createdAt: string; body: string }>,
): ThreadInboundTruth {
  let lastAt: string | null = null;
  let lastBody: string | null = null;
  for (const m of messages) {
    if (m.direction !== "incoming") continue;
    if (lastAt == null || m.createdAt > lastAt) {
      lastAt = m.createdAt;
      lastBody = m.body ?? "";
    }
  }
  return { hasInbound: lastAt != null, lastInboundAt: lastAt, lastInboundBody: lastBody };
}

/** The healing note appended when a bump is aborted on thread truth — the
 *  record was blind and the thread knew better. Documents what Quo showed so
 *  the deep sync's proper ingest has a visible anchor. */
export function buildBumpAbortedNote(
  existing: string | null,
  iso: string,
  inboundAt: string | null,
  inboundExcerpt: string | null,
): string {
  const line =
    `[bump aborted ${iso}] Quo thread shows an inbound${inboundAt ? ` at ${inboundAt}` : ""} this record never captured` +
    `${inboundExcerpt ? `: "${inboundExcerpt.slice(0, 140)}"` : ""} — record healed from thread truth (status → Response Received); reply lane owns this thread.`;
  const prior = existing ?? "";
  return prior ? `${prior}\n\n${line}` : line;
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

// ── Plan selection ────────────────────────────────────────────────────
//
// Extracted from app/api/cron/bump-followup on 2026-08-08 so the slot
// accounting is testable (Spine rec7xw7eUgFQ7stEb). The defect it pins:
// the dispatch claim used to be consulted ONLY at send time, so a record
// holding a live 24h claim still CONSUMED one of the run's `limit` slots
// and then bounced to idempotent_skipped. With ten stale claims at the
// head of the due queue every run planned 10, skipped 10, and sent 0
// while dozens of genuinely-due records behind them were never reached.
// The claim is now a planning input, and the records it displaces are
// counted (claimSkipped) so a backed-up queue is legible in the audit
// row instead of reading as ordinary idempotency.

export interface BumpPlan {
  recordId: string;
  address: string;
  zip: string | null;
  state: string | null;
  agentName: string | null;
  toE164: string;
  attempt: number;
  stickyOffer: number;
  message: string;
}

export interface BumpPlanSkip {
  record_id: string;
  address: string;
  reason: string;
}

export interface PlanBumpsResult {
  plans: BumpPlan[];
  skipped: BumpPlanSkip[];
  claimSkipped: number;
  scanned: number;
}

export interface PlanBumpsOpts {
  due: Listing[];
  liveThreads: Set<string>;
  limit: number;
  maxScan: number;
  now?: Date;
  /** Live dispatch-claim lookup. Omitted (dry run / KV unconfigured) means
   *  no claim gating — matching the dispatch path, which only calls setNx
   *  when the lock is enabled. A lookup that throws must resolve false:
   *  a blind claim check may not silently hold back the whole lane. */
  isClaimed?: (recordId: string, attempt: number) => Promise<boolean>;
}

export async function planBumps(opts: PlanBumpsOpts): Promise<PlanBumpsResult> {
  const { due, liveThreads, limit, maxScan, isClaimed } = opts;
  const now = opts.now ?? new Date();
  const plans: BumpPlan[] = [];
  const skipped: BumpPlanSkip[] = [];
  const seenThisRun = new Set<string>();
  let claimSkipped = 0;
  let scanned = 0;

  for (const l of due) {
    if (plans.length >= limit) break;
    if (scanned >= maxScan) break;
    scanned++;
    const v = bumpVerdict(l, now);
    if (!v.due || v.attempt == null) continue; // selectBumpDue already filtered; defensive
    const phone = normalizePhone(l.agentPhone);
    if (!phone) {
      skipped.push({ record_id: l.id, address: l.address, reason: "no_agent_phone" });
      continue;
    }
    if (liveThreads.has(phone)) {
      skipped.push({ record_id: l.id, address: l.address, reason: "agent_in_live_thread" });
      continue;
    }
    if (seenThisRun.has(phone)) {
      skipped.push({ record_id: l.id, address: l.address, reason: "agent_already_bumped_this_run" });
      continue;
    }
    const sticky = extractStickyOffer(l.notes);
    if (!sticky) {
      // No delivery stamp → we do not know what number the agent received.
      // Fail closed — a drifted field is never a fallback (INVARIANTS §3).
      skipped.push({ record_id: l.id, address: l.address, reason: "no_sticky_stamp" });
      continue;
    }
    // Claim check LAST — the only I/O here, so it runs only for candidates
    // that already cleared every cheap gate. It must also run BEFORE
    // seenThisRun.add, or a claimed record would burn its agent's
    // one-bump-per-run slot on its way out the door.
    if (isClaimed) {
      const held = await isClaimed(l.id, v.attempt).catch(() => false);
      if (held) {
        skipped.push({ record_id: l.id, address: l.address, reason: "already_claimed" });
        claimSkipped++;
        continue;
      }
    }
    seenThisRun.add(phone);
    plans.push({
      recordId: l.id,
      address: l.address,
      zip: l.zip ?? null,
      state: l.state ?? null,
      agentName: l.agentName,
      toE164: phone,
      attempt: v.attempt,
      stickyOffer: sticky.offer,
      message: buildBumpMessage(l.agentName, l.address, sticky.offer, v.attempt),
    });
  }

  return { plans, skipped, claimSkipped, scanned };
}
