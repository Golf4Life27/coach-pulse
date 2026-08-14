// Crawl portfolio policy — how many ZIPs we hold, which ones earn their slot,
// and when one is retired. @agent: scout
//
// Pure. No I/O. The route reads ZIP_Registry + the send counter and hands rows
// in; this module only decides. Tests: lib/crawler/portfolio.test.ts
//
// ── WHY THIS EXISTS (operator, 2026-08-13) ────────────────────────────────
// "as it captures more zips, it needs to drop some zips, we can't just
// continue to absorb every zip in america, right?"
//
// Right, but the binding variable is not ZIP COUNT — it is ZIPS ÷ CADENCE.
// Measured that day: the circuit held exactly 100 ZIPs across 10 metros, and
// the sustainable RentCast draw was ~164 calls/day. 100 ZIPs crawled daily
// costs 100 calls/day; the same 100 crawled weekly costs 14. Adding San
// Antonio's 56 seeded ZIPs costs 56/day at daily cadence and 8/day at weekly.
// So the question "how many ZIPs can we hold?" is unanswerable until someone
// states the cadence and the budget, which is exactly what nothing did:
// lib/crawler/zip-rotation already decayed cadence per ZIP, but NOTHING tied
// portfolio SIZE to the call budget. ZIPs could be added indefinitely and the
// governor simply clamped the per-run cap — silently stretching every ZIP's
// effective cadence instead of refusing the new ones. Growth was paid for by
// the incumbents, invisibly.
//
// ── THE METRIC PROBLEM, WHICH IS THE REAL ONE ─────────────────────────────
// ZIP_Registry scores a ZIP on Records_Ingested_30d and Accept_Rate_30d. Both
// count records accepted INTO the table. Neither has any relationship to
// money, and on 2026-08-13 that was proven the expensive way: 1,326 San
// Antonio records had been accepted and had produced ZERO sends — they were a
// stale PropStream import that failed the PO-02 freshness gate by 28x. Under
// the incumbent metric that ZIP set scored as a triumph.
//
// So this module scores a ZIP on SENDS. A send is the first event in the
// funnel where the machine has actually done its job — a real number reached a
// real counterparty. It is a proxy, chosen deliberately: replies and contracts
// are better proxies for revenue but are far too sparse to rank 100+ ZIPs on a
// 30-day window, while accepted-records is dense and meaningless. Sends is the
// last DENSE signal before the funnel goes sparse. When reply volume can carry
// the ranking, move this to replies — the shape of the policy does not change.

export const PORTFOLIO_DOCTRINE_VERSION = "2026-08-13";

// ── Retirement ────────────────────────────────────────────────────────────

/** Zero sends for this long → eligible for retirement, PROVIDED the ZIP could
 *  actually have sent (see eligibleForSends). 90 days is deliberately long:
 *  DOM-based distress sourcing means a ZIP can be genuinely quiet for a
 *  season and then produce. */
export const RETIREMENT_WINDOW_DAYS = 90;

/** A ZIP must have been crawled at least this many times before its silence
 *  counts as evidence about the ZIP rather than evidence about our coverage. */
export const MIN_CRAWLS_BEFORE_RETIREMENT = 3;

/** Retirement is PAROLE, not execution: a retired ZIP is re-checked on this
 *  cycle instead of being dropped forever.
 *
 *  This is the difference between a policy and a trap. Exclude a ZIP outright
 *  and it can never produce a send again, so it can never earn its way back —
 *  the retirement becomes self-justifying and permanent. At 90 days, 56
 *  retired ZIPs cost 0.6 calls/day between them, which buys a door that stays
 *  open. Any structural unlock (a new seed, a market flipping priceable)
 *  restores normal cadence immediately, because eligibility is recomputed from
 *  live inputs on every run rather than stored as a sticky flag. */
export const RETIRED_PAROLE_CYCLE_HOURS = 24 * 90;

export type PortfolioStatus =
  /** Crawling on its earned cadence. */
  | "active"
  /** Never crawled — holds a reserved exploration slot. */
  | "exploring"
  /** Lost the ranking competition for a slot this cycle. NOT a judgement about
   *  the ZIP: it comes straight back when an incumbent decays. */
  | "benched"
  /** Was able to send, was crawled enough to know, and sent nothing. Parole
   *  cadence, not exclusion. */
  | "retired";

export interface ZipYieldRow {
  zip: string;
  /** Outbound sends attributable to this ZIP in the retirement window. NULL
   *  means UNMEASURED, which is treated as "no evidence" and can never trigger
   *  retirement — a missing counter must not read as a zero. */
  sends: number | null;
  /** Records accepted into the table (ZIP_Registry Records_Ingested_30d).
   *  Retained ONLY as a tie-break between ZIPs with equal sends; never
   *  promoted back into the primary rank. See the metric note above. */
  recordsIngested: number | null;
  /** How many ingest runs have actually touched this ZIP. */
  crawlCount: number | null;
  /** Null → never crawled. */
  lastIngestedAt: string | null;
  /** COULD this ZIP have produced a send during the window? False when the
   *  opener could not price the market, the ZIP was saturated/paused, or it
   *  had no usable ARV seed.
   *
   *  THIS FLAG IS THE WHOLE SAFETY PROPERTY. Every San Antonio ZIP had zero
   *  sends on 2026-08-13 — not because San Antonio is unproductive, but
   *  because a non-disclosure hold meant nothing there could be priced, so
   *  nothing could be sent, so nothing could be crawled. A naive "no sends in
   *  90 days" rule would have retired all 56 of them permanently, on the very
   *  day the market unlocked, and the system would have quietly locked out the
   *  operator's only proven market. Silence is only evidence when speech was
   *  possible. */
  eligibleForSends: boolean;
}

export interface RetirementVerdict {
  retire: boolean;
  reason: string;
}

/** Pure: has this ZIP earned retirement? Conservative by construction — every
 *  unknown resolves to "keep crawling". */
export function assessRetirement(row: ZipYieldRow): RetirementVerdict {
  if (row.lastIngestedAt == null) {
    return { retire: false, reason: "never crawled — nothing to judge" };
  }
  if (!row.eligibleForSends) {
    return {
      retire: false,
      reason: "could not have sent during the window (market held / saturated / unseeded) — silence is not evidence",
    };
  }
  if (row.sends == null) {
    return { retire: false, reason: "sends unmeasured — a missing counter is not a zero" };
  }
  const crawls = Math.max(0, Math.floor(row.crawlCount ?? 0));
  if (crawls < MIN_CRAWLS_BEFORE_RETIREMENT) {
    return { retire: false, reason: `only ${crawls} crawls (need ${MIN_CRAWLS_BEFORE_RETIREMENT}) — too little coverage to blame the ZIP` };
  }
  if (row.sends > 0) {
    return { retire: false, reason: `${row.sends} send(s) in the window — earning its slot` };
  }
  return {
    retire: true,
    reason: `0 sends across ${crawls} crawls while able to send — retired to ${RETIREMENT_WINDOW_DAYS}-day parole`,
  };
}

// ── Capacity ──────────────────────────────────────────────────────────────

export interface CapacityInput {
  /** Paid calls per day the operator is willing to spend on INTAKE crawling —
   *  not the whole vendor budget, which also funds pricing, verification and
   *  backfill. */
  callsPerDayForIntake: number;
  /** The cadence the portfolio is sized for, in hours. Sizing at the BASE
   *  cycle is the honest choice: decayed tiers (cooling/chewed) only ever cost
   *  less, so a portfolio that fits at base cadence always fits. */
  targetCycleHours: number;
  /** Fraction of capacity held back for never-crawled ZIPs. Without a reserve
   *  the incumbents lock in permanently and no new metro can ever prove
   *  itself — the failure mode that kept San Antonio dark. */
  explorationShare?: number;
}

export const DEFAULT_EXPLORATION_SHARE = 0.15;

export interface Capacity {
  /** Total ZIP slots the budget supports at the target cadence. */
  maxZips: number;
  /** Slots reserved for never-crawled ZIPs. */
  explorationSlots: number;
  /** Slots contested by crawled ZIPs on yield. */
  earnedSlots: number;
  callsPerDay: number;
}

/** Pure: how many ZIPs can this budget hold at this cadence?
 *
 *  One crawl = one paid listings call per ZIP per cycle, so a ZIP costs
 *  (24 / cycleHours) calls per day and the portfolio ceiling is simply
 *  budget ÷ that. Stating it as arithmetic rather than a hand-picked list is
 *  the point: adding a metro now has to name what it costs. */
export function computeCapacity(input: CapacityInput): Capacity {
  const calls = Math.max(0, input.callsPerDayForIntake);
  const cycleH = Math.max(1, input.targetCycleHours);
  const maxZips = Math.floor(calls * (cycleH / 24));
  const share = Math.min(0.9, Math.max(0, input.explorationShare ?? DEFAULT_EXPLORATION_SHARE));
  const explorationSlots = Math.floor(maxZips * share);
  return {
    maxZips,
    explorationSlots,
    earnedSlots: Math.max(0, maxZips - explorationSlots),
    callsPerDay: calls,
  };
}

// ── Admission by displacement ─────────────────────────────────────────────

export interface PortfolioAssignment {
  zip: string;
  status: PortfolioStatus;
  /** Rank score used for the earned-slot competition (higher wins). */
  score: number;
  reason: string;
}

export interface PortfolioPlan {
  capacity: Capacity;
  assignments: PortfolioAssignment[];
  counts: Record<PortfolioStatus, number>;
  /** True when demand exceeded capacity — i.e. ZIPs were benched. Surfaced so
   *  the run can SAY it dropped coverage rather than silently stretching
   *  everyone's cadence, which is what the old behaviour did. */
  overSubscribed: boolean;
}

/** Pure: rank a crawled ZIP for the earned-slot competition.
 *
 *  Sends dominate. recordsIngested breaks ties only — two ZIPs that have each
 *  produced one send are ordered by which is feeding more inventory, but no
 *  amount of accepted records ever outranks a single send. That ordering is
 *  the whole correction: it is what stops 1,326 unsendable records from
 *  outscoring a ZIP that actually reached a seller. */
export function yieldScore(row: ZipYieldRow): number {
  const sends = Math.max(0, row.sends ?? 0);
  const records = Math.max(0, row.recordsIngested ?? 0);
  // Records contribute strictly less than one send, asymptotically.
  return sends + records / (records + 1_000);
}

export interface PlanInput {
  rows: ZipYieldRow[];
  capacity: Capacity;
}

/** Pure: assign every ZIP a portfolio status.
 *
 *  Order of operations matters and is deliberate:
 *    1. RETIRE first — a ZIP that proved unproductive should not occupy a slot
 *       in the competition at all.
 *    2. EXPLORE next — never-crawled ZIPs draw from their own reserve, so a
 *       new metro is never outranked by incumbents on a record it has had no
 *       chance to build.
 *    3. COMPETE last — the remainder rank on sends for the earned slots, and
 *       the overflow is BENCHED (returns automatically when an incumbent
 *       decays), never retired. Losing a competition is not evidence of
 *       failure; only measured silence is. */
export function planPortfolio(input: PlanInput): PortfolioPlan {
  const { capacity } = input;
  const assignments: PortfolioAssignment[] = [];
  const contenders: Array<{ row: ZipYieldRow; score: number }> = [];
  const explorers: ZipYieldRow[] = [];

  const seen = new Set<string>();
  for (const row of input.rows) {
    if (!/^\d{5}$/.test(row.zip) || seen.has(row.zip)) continue;
    seen.add(row.zip);
    const verdict = assessRetirement(row);
    if (verdict.retire) {
      assignments.push({ zip: row.zip, status: "retired", score: 0, reason: verdict.reason });
      continue;
    }
    if (row.lastIngestedAt == null) {
      explorers.push(row);
      continue;
    }
    contenders.push({ row, score: yieldScore(row) });
  }

  // Exploration reserve, oldest-known-first so the queue is stable and fair.
  const exploringKept = explorers.slice(0, capacity.explorationSlots);
  const exploringOverflow = explorers.slice(capacity.explorationSlots);
  for (const row of exploringKept) {
    assignments.push({ zip: row.zip, status: "exploring", score: 0, reason: "never crawled — holding a reserved exploration slot" });
  }
  for (const row of exploringOverflow) {
    assignments.push({ zip: row.zip, status: "benched", score: 0, reason: "exploration reserve full this cycle" });
  }

  // Unused exploration slots are not wasted — they fall through to the
  // earned pool rather than idling while a productive ZIP sits benched.
  const spare = Math.max(0, capacity.explorationSlots - exploringKept.length);
  const earnedSlots = capacity.earnedSlots + spare;

  contenders.sort((a, b) => (b.score - a.score) || a.row.zip.localeCompare(b.row.zip));
  contenders.forEach((c, i) => {
    if (i < earnedSlots) {
      assignments.push({
        zip: c.row.zip,
        status: "active",
        score: c.score,
        reason: `rank ${i + 1}/${contenders.length} · ${c.row.sends ?? 0} send(s)`,
      });
    } else {
      assignments.push({
        zip: c.row.zip,
        status: "benched",
        score: c.score,
        reason: `rank ${i + 1} exceeds ${earnedSlots} earned slots — benched, returns when an incumbent decays`,
      });
    }
  });

  const counts: Record<PortfolioStatus, number> = { active: 0, exploring: 0, benched: 0, retired: 0 };
  for (const a of assignments) counts[a.status]++;
  assignments.sort((a, b) => a.zip.localeCompare(b.zip));

  return {
    capacity,
    assignments,
    counts,
    overSubscribed: counts.benched > 0,
  };
}
