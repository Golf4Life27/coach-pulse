// THE HUNTER'S CIRCUIT — a train track around the metros (operator 2026-08-05).
// @agent: scout
//
// THE PROBLEM IT SOLVES. Lead discovery was gated on RentCast, whose monthly
// plan divided by days left IS the daily crawl budget (~30 ZIP scans/day, see
// computeDailyCrawlBudget). So the number of new leads the business could find
// was pinned to the cheapest input in the system, and the operator could not
// get volume without upgrading a plan he reasonably refuses to upgrade until
// he sees volume. That circle is the actual reason the top of the funnel has
// been quiet for weeks.
//
// THE REORDER (operator's design): cast wide with the ABUNDANT vendor, then
// spend the SCARCE one only on what already qualified.
//   - Firecrawl: ~90,700 credits on hand, ~2 per search. A full circuit of
//     every priceable metro is ~500 credits — roughly 170 complete national
//     sweeps already paid for. Discovery is effectively free.
//   - RentCast: 1,000 calls/month, and the only source of the AGENT PHONE
//     that makes a listing textable. Spent per-qualifier, never per-scan.
//   - Vision: costliest. Runs only when listing TEXT leaves rehab scope
//     genuinely ambiguous on a deal that already prices.
//
// WHY A CIRCUIT INSTEAD OF A DAILY NATIONAL SWEEP — and why nothing is lost:
// the distress gate requires DOM >= 60. A property listed the day after the
// train leaves a metro is not ELIGIBLE for another 60 days. So any circuit
// period under 60 days discovers every property before it could ever qualify.
// Re-sweeping daily would re-read the same inventory to find nothing new that
// matters. The one thing that becomes eligible WITHOUT aging is a price cut,
// and that happens to records already in the database — a cheap re-check of
// known listings, not a discovery problem. (See DEFAULT_CIRCUIT_DAYS.)

/** The distress gate's time-on-market threshold. The circuit period is
 *  derived from this, so if the gate moves the circuit must be re-derived —
 *  pinned by a premise test rather than left as a coincidence. */
export const DISTRESS_DOM_DAYS = 60;

/** Days for one full circuit of every metro. Must stay comfortably under
 *  DISTRESS_DOM_DAYS: at 21 days a newly-listed property is seen at least
 *  twice before it becomes eligible, leaving room for a metro to be skipped
 *  on a bad day without opening a real gap. */
export const DEFAULT_CIRCUIT_DAYS = 21;

/** ZIPs swept in one leg. A leg is one metro's worth of work in one run;
 *  Firecrawl cost is ~2 credits per ZIP search, so this is bounded by run
 *  wall-clock, not by budget. */
export const DEFAULT_LEG_ZIP_CAP = 25;

export interface MetroCircuitRow {
  /** Metro label — the unit the train stops at. */
  metro: string;
  zip: string;
  /** ISO timestamp this ZIP was last SWEPT for discovery (distinct from
   *  Last_Verified, which is about a single known listing). Null = never. */
  lastSweptAt: string | null;
}

export interface CircuitLeg {
  metro: string;
  zips: string[];
  /** Oldest sweep timestamp in this metro (null when never swept). */
  stalestAt: string | null;
  /** Whole days since that oldest sweep; null when never swept. */
  ageDays: number | null;
  reason: "never_swept" | "stalest_metro";
}

function ts(iso: string | null): number {
  if (!iso) return Number.NEGATIVE_INFINITY;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

/** Pure: how many metros must be swept per day to complete a circuit in
 *  `circuitDays`. Always at least 1 — a circuit that rounds to zero would
 *  stall the train. */
export function metrosPerDay(metroCount: number, circuitDays: number = DEFAULT_CIRCUIT_DAYS): number {
  if (metroCount <= 0) return 0;
  return Math.max(1, Math.ceil(metroCount / Math.max(1, circuitDays)));
}

/**
 * Pure: the next stop on the circuit — the metro whose OLDEST ZIP sweep is
 * stalest, never-swept metros first.
 *
 * Selecting on a metro's oldest ZIP (rather than its average or newest) means
 * a metro is not considered done until every ZIP in it has been covered, so a
 * partially-swept metro is finished before the train moves on. That is what
 * makes "by the time it comes back the metro is full again" true — the train
 * actually empties each stop.
 */
export function selectNextLeg(
  rows: MetroCircuitRow[],
  now: Date,
  zipCap: number = DEFAULT_LEG_ZIP_CAP,
): CircuitLeg | null {
  const byMetro = new Map<string, MetroCircuitRow[]>();
  for (const r of rows) {
    if (!r.metro || !/^\d{5}$/.test(r.zip)) continue;
    const list = byMetro.get(r.metro) ?? [];
    list.push(r);
    byMetro.set(r.metro, list);
  }
  if (byMetro.size === 0) return null;

  let best: { metro: string; list: MetroCircuitRow[]; oldest: number } | null = null;
  for (const [metro, list] of byMetro) {
    const oldest = Math.min(...list.map((r) => ts(r.lastSweptAt)));
    // Tie-break on metro name so the circuit order is deterministic across
    // runs — an unstable order would let one metro starve.
    if (best === null || oldest < best.oldest || (oldest === best.oldest && metro < best.metro)) {
      best = { metro, list, oldest };
    }
  }
  if (!best) return null;

  // Stalest ZIPs first within the leg, so a capped leg still makes progress
  // against the metro's oldest corners instead of re-reading fresh ones.
  const ordered = [...best.list].sort((a, b) => ts(a.lastSweptAt) - ts(b.lastSweptAt));
  const zips = ordered.slice(0, Math.max(1, zipCap)).map((r) => r.zip);
  const neverSwept = best.oldest === Number.NEGATIVE_INFINITY;
  const stalestAt = neverSwept ? null : new Date(best.oldest).toISOString();

  return {
    metro: best.metro,
    zips,
    stalestAt,
    ageDays: neverSwept ? null : Math.floor((now.getTime() - best.oldest) / 86_400_000),
    reason: neverSwept ? "never_swept" : "stalest_metro",
  };
}

/** Pure: is the circuit keeping its promise — has every metro been swept
 *  within the period that guarantees no property ages into eligibility
 *  unseen? Returns the metros that have fallen behind. */
export function metrosBehindSchedule(
  rows: MetroCircuitRow[],
  now: Date,
  circuitDays: number = DEFAULT_CIRCUIT_DAYS,
): Array<{ metro: string; ageDays: number | null }> {
  const byMetro = new Map<string, number>();
  for (const r of rows) {
    if (!r.metro || !/^\d{5}$/.test(r.zip)) continue;
    const t = ts(r.lastSweptAt);
    const prev = byMetro.get(r.metro);
    if (prev === undefined || t < prev) byMetro.set(r.metro, t);
  }
  const cutoff = now.getTime() - circuitDays * 86_400_000;
  const behind: Array<{ metro: string; ageDays: number | null }> = [];
  for (const [metro, t] of byMetro) {
    if (t === Number.NEGATIVE_INFINITY) {
      behind.push({ metro, ageDays: null });
    } else if (t < cutoff) {
      behind.push({ metro, ageDays: Math.floor((now.getTime() - t) / 86_400_000) });
    }
  }
  return behind.sort((a, b) => (b.ageDays ?? Infinity) - (a.ageDays ?? Infinity));
}
