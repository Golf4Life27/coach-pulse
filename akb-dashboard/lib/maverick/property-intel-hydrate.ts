// INV-022 — Property_Intel hydration pure helpers.
// @agent: data_federation
//
// Sprint 1: pure logic only — NO network calls, NO Airtable I/O. The cron
// orchestration + vendor fetches land in Sprint 2/3. These helpers are the
// testable core: eligibility predicate, freshness window, payoff total,
// flood/price-drift classification, and the discrepancy taxonomy assembly
// (Q5). Mirrors the INV-006 / INV-005 pure-helper-with-unit-tests split.

import type {
  DiscrepancyFlag,
  DiscrepancySeverity,
  LienInputs,
  MortgageType,
} from "@/lib/property-intel";

/** Outreach_Status values that make a record eligible for DD-phase
 *  hydration. Mirrors INV-006's ELIGIBLE_SOURCE_STATES discipline. */
export const HYDRATION_ELIGIBLE_STATES: ReadonlySet<string> = new Set([
  "Negotiating",
  "Offer Accepted",
]);

/** Default freshness window (hours). A record hydrated more recently than
 *  this is skipped unless force=true. 24h keeps the daily cron from
 *  re-pulling the same record every tick (and respects RENTCAST_MONTHLY_CAP). */
export const FRESHNESS_WINDOW_HOURS = 24;

/** Price-drift threshold: AS-IS value more than this % off contract price
 *  surfaces a Type 2C discrepancy. */
export const PRICE_DRIFT_THRESHOLD_PCT = 20;

/** FEMA Special Flood Hazard Area zone prefixes. Any zone starting with
 *  these is a mandatory-insurance area → amber discrepancy. Zones X / C / B
 *  / D are outside the SFHA (no flag). */
export const SFHA_ZONE_PREFIXES = ["A", "V"] as const;

export interface HydrationCandidate {
  outreachStatus: string | null;
  /** ISO 8601, or null if never hydrated. */
  lastHydratedAt: string | null;
}

export interface HydrationDecision {
  action: "hydrate" | "skip";
  reason: "status_not_eligible" | "within_freshness_window" | "should_hydrate";
}

/** Pure: should this record be hydrated on the current cron tick? */
export function shouldHydrate(
  candidate: HydrationCandidate,
  now: Date = new Date(),
  force = false,
): HydrationDecision {
  if (
    !candidate.outreachStatus ||
    !HYDRATION_ELIGIBLE_STATES.has(candidate.outreachStatus)
  ) {
    return { action: "skip", reason: "status_not_eligible" };
  }
  if (!force && !isFreshnessWindowExpired(candidate.lastHydratedAt, now)) {
    return { action: "skip", reason: "within_freshness_window" };
  }
  return { action: "hydrate", reason: "should_hydrate" };
}

/** Pure: has the freshness window elapsed since lastHydratedAt? Null/empty
 *  (never hydrated) → true (always eligible). Unparseable → true (treat as
 *  stale rather than silently skipping). */
export function isFreshnessWindowExpired(
  lastHydratedAt: string | null,
  now: Date = new Date(),
  windowHours: number = FRESHNESS_WINDOW_HOURS,
): boolean {
  if (!lastHydratedAt) return true;
  const t = Date.parse(lastHydratedAt);
  if (Number.isNaN(t)) return true;
  return now.getTime() - t >= windowHours * 3_600_000;
}

/** Pure: sum all lien components into the payoff total INV-023 reads.
 *  Null/undefined components count as 0. Negative inputs are clamped to 0
 *  (a negative lien is nonsense; don't let it deflate the total). */
export function computePayoffTotal(liens: LienInputs): number {
  const parts = [
    liens.firstMortgageAmount,
    liens.secondMortgageAmount,
    liens.judgmentLiensTotal,
    liens.mechanicLiensTotal,
    liens.taxLiensTotal,
  ];
  return parts.reduce<number>((sum, v) => {
    if (v == null || !Number.isFinite(v) || v < 0) return sum;
    return sum + v;
  }, 0);
}

/** Pure: is a FEMA zone inside a Special Flood Hazard Area? */
export function isSpecialFloodHazardZone(zone: string | null | undefined): boolean {
  if (!zone) return false;
  const z = zone.trim().toUpperCase();
  if (z === "") return false;
  // X, C, B, D are outside the SFHA even though some start with letters near
  // A/V — none of those collide with the A*/V* prefixes, so a prefix test
  // is safe.
  return SFHA_ZONE_PREFIXES.some((p) => z.startsWith(p));
}

export interface PriceDriftResult {
  driftPct: number;
  exceedsThreshold: boolean;
  /** signed: positive = AS-IS above contract, negative = below. */
  delta: number;
}

/** Pure: AS-IS value vs contract price drift, relative to contract price. */
export function computePriceDrift(
  asIsValue: number | null | undefined,
  contractPrice: number | null | undefined,
): PriceDriftResult {
  if (
    asIsValue == null ||
    contractPrice == null ||
    !Number.isFinite(asIsValue) ||
    !Number.isFinite(contractPrice) ||
    contractPrice <= 0
  ) {
    return { driftPct: 0, exceedsThreshold: false, delta: 0 };
  }
  const delta = asIsValue - contractPrice;
  const driftPct = (Math.abs(delta) / contractPrice) * 100;
  return {
    driftPct,
    exceedsThreshold: driftPct > PRICE_DRIFT_THRESHOLD_PCT,
    delta,
  };
}

// ── Discrepancy taxonomy (Q5) ───────────────────────────────────────

const SEVERITY_RANK: Record<DiscrepancySeverity, number> = {
  none: 0,
  info: 1,
  amber: 2,
  red: 3,
};

/** Pure: the maximum severity across a set of flags. Empty → "none". */
export function maxSeverity(flags: DiscrepancyFlag[]): DiscrepancySeverity {
  return flags.reduce<DiscrepancySeverity>((max, f) => {
    return SEVERITY_RANK[f.severity] > SEVERITY_RANK[max] ? f.severity : max;
  }, "none");
}

export interface DiscrepancyInputs {
  ownerOfRecord?: string | null;
  statedSeller?: string | null;
  liens?: LienInputs;
  firstMortgageType?: MortgageType | null;
  femaFloodZone?: string | null;
  asIsValue?: number | null;
  contractPrice?: number | null;
  /** true when the subject sits in a Memphis assignment-restricted context. */
  memphisAssignmentApplies?: boolean;
}

export interface DiscrepancyResult {
  flags: DiscrepancyFlag[];
  severityMax: DiscrepancySeverity;
}

/** Pure: assemble the discrepancy flag set from hydrated inputs. Each branch
 *  is independent; absence of an input simply omits its flag (never guesses).
 *  Severity tiers per Q5 taxonomy. Lien-presence is flagged here as a
 *  surface; the actual payoff_headroom math lives in INV-023. */
export function buildDiscrepancyFlags(
  input: DiscrepancyInputs,
  now: Date = new Date(),
): DiscrepancyResult {
  const at = now.toISOString();
  const flags: DiscrepancyFlag[] = [];

  // Owner mismatch — only when both sides are present and differ.
  if (
    input.ownerOfRecord &&
    input.statedSeller &&
    normalizeName(input.ownerOfRecord) !== normalizeName(input.statedSeller)
  ) {
    flags.push({
      type: "owner_mismatch",
      severity: "amber",
      detail: `Owner of record "${input.ownerOfRecord}" differs from stated seller "${input.statedSeller}". Verify chain of title before contract.`,
      detected_at: at,
    });
  }

  // Lien presence — flag if any payoff obligation exists. Revolving first
  // mortgage elevates to red (recorded amount is a lower bound; current
  // balance may exceed it — the 23 Fields learning).
  const payoff = input.liens ? computePayoffTotal(input.liens) : 0;
  if (payoff > 0) {
    const revolving = input.firstMortgageType === "revolving";
    flags.push({
      type: "lien_presence",
      severity: revolving ? "red" : "amber",
      detail: revolving
        ? `Payoff total $${payoff.toLocaleString("en-US")} includes a REVOLVING first mortgage — recorded amount is a lower bound; confirm current balance with listing agent before EMD wire.`
        : `Payoff total $${payoff.toLocaleString("en-US")} in recorded liens. Feeds INV-023 payoff-headroom check.`,
      detected_at: at,
    });
  }

  // Flood zone — SFHA zones (A*/V*) are amber.
  if (isSpecialFloodHazardZone(input.femaFloodZone)) {
    flags.push({
      type: "flood_zone",
      severity: "amber",
      detail: `FEMA zone ${input.femaFloodZone} is a Special Flood Hazard Area; mandatory flood insurance + assignee disclosure impact.`,
      detected_at: at,
    });
  }

  // Price drift — AS-IS more than threshold off contract.
  const drift = computePriceDrift(input.asIsValue, input.contractPrice);
  if (drift.exceedsThreshold) {
    flags.push({
      type: "price_drift",
      severity: "amber",
      detail: `RentCast AS-IS $${Math.round(input.asIsValue!).toLocaleString("en-US")} vs contract $${Math.round(input.contractPrice!).toLocaleString("en-US")} — ${drift.driftPct.toFixed(1)}% ${drift.delta > 0 ? "above" : "below"} contract.`,
      detected_at: at,
    });
  }

  // Memphis assignment clause — hard precondition surface (per memory).
  if (input.memphisAssignmentApplies) {
    flags.push({
      type: "memphis_assignment",
      severity: "amber",
      detail: "Memphis-specific assignment-clause check required before contract advance.",
      detected_at: at,
    });
  }

  return { flags, severityMax: maxSeverity(flags) };
}

/** Pure: normalize a name for comparison (lowercase, collapse whitespace,
 *  strip common business suffixes + punctuation). Conservative — only used
 *  to suppress false owner-mismatch flags on trivial formatting diffs. */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,]/g, "")
    .replace(/\b(llc|inc|corp|co|ltd|trust)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
