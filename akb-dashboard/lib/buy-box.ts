// THE TARGET — one definition of what we are hunting. (operator 2026-08-05)
// @agent: scout
//
// This is the first thing a wholesaler decides and it did not exist in one
// place. It was scattered across three surfaces that disagreed:
//   - code: INTAKE_RULES = { minBeds: 2, $20k-$400k }. Three numbers, and a
//     $400,000 ceiling no metro we work can produce a wholesale deal at —
//     which is how a $375,000 Atlanta listing entered the pool and an
//     autonomous $266,250 offer became possible at all.
//   - spine recdOVNVKOoTwXS3j: the operator's OWN cash-on-cash ruling
//     (12%+ JUMP / 10-12% WORK / <10% KILL) — unreachable, because intake is
//     single-family only and 0 of 6,520 records are multi-family.
//   - spine recNYeSwQtoe5lpUn: a 7-dimension screening schema, never wired.
//
// Everything here is ONE source of truth: intake filters on it, the hunter
// searches for it, the pricer reads its economics. Change it here or nowhere.

/** Metro tiers by what a RENOVATED house is actually worth there. The ask
 *  ceiling is derived from the economics below, not guessed: a deal needs
 *  ask <= ARV*buyBox - rehab - fee, so an ask above roughly 60% of the tier's
 *  top ARV cannot pencil no matter how motivated the seller is. */
export type MetroTier = "rust_belt" | "southern_mid";

export interface TierBand {
  tier: MetroTier;
  /** Metro labels (lowercased match against city). */
  metros: string[];
  /** Typical renovated ARV range for the stock we target. */
  arvLow: number;
  arvHigh: number;
  /** Hard ask ceiling for intake. Above this, stop paying to look. */
  maxAsk: number;
  minAsk: number;
}

export const TIER_BANDS: readonly TierBand[] = [
  {
    tier: "rust_belt",
    metros: ["detroit", "cleveland", "dayton", "youngstown", "akron", "toledo"],
    arvLow: 60_000,
    arvHigh: 140_000,
    // 0.70*140k - 35k rehab - 10k fee = $53k. A $90k ask needs ~$193k ARV,
    // which this stock does not reach — so $90k is the outer edge, not a target.
    maxAsk: 90_000,
    minAsk: 15_000,
  },
  {
    tier: "southern_mid",
    metros: ["atlanta", "indianapolis", "birmingham", "memphis"],
    arvLow: 100_000,
    arvHigh: 250_000,
    // 0.70*250k - 50k rehab - 10k fee = $115k.
    maxAsk: 150_000,
    minAsk: 25_000,
  },
];

/** Absolute ceiling across every market. Nothing above this is looked at.
 *  Replaces INTAKE_RULES.maxListPrice = $400,000. */
export const MAX_ASK_ANY_MARKET = 150_000;

// ── ECONOMICS — what makes it a deal ────────────────────────────────────────

/** Flip buy-box: the share of ARV an end buyer's all-in can reach. */
export const ARV_BUY_BOX_PCT = 0.70;
/** Assignment fee we underwrite to, and the floor below which it is not worth
 *  the work. NOTE: three conflicting fee defaults exist across mao-flip,
 *  decision-math and buyer-intelligence ($5k/$10k/$15k) — open item, the
 *  operator-locked floor is $5,000. */
export const TARGET_ASSIGNMENT_FEE = 10_000;
export const MIN_ASSIGNMENT_FEE = 5_000;

/** Multi-family cash-on-cash tiers — OPERATOR RULING 2026-08-01
 *  (spine recdOVNVKOoTwXS3j). Not a suggestion, not re-derivable here. */
export const MF_COC_JUMP = 0.12;
export const MF_COC_FLOOR = 0.10;

// ── PROPERTY SHAPE — sets the ARV ceiling; does NOT create the deal ─────────

export const SHAPE = {
  /** 2-4 units included: the operator's MF ruling has nothing to act on while
   *  intake is single-family only. */
  propertyTypes: ["single_family", "duplex", "triplex", "fourplex"] as const,
  minBeds: 2,
  targetBeds: 3,
  /** 1 bath is the dominant Rust Belt stock — excluding it would delete most
   *  Detroit/Cleveland/Dayton inventory. 2+ scores higher, never gates. */
  minBaths: 1,
  minSqft: 800,
  maxSqft: 2_200,
  /** Detroit/Cleveland stock is heavily 1910-1950; a 1920 floor would cut real
   *  inventory. Post-1995 is rarely distressed enough to discount. */
  minYearBuilt: 1900,
  maxYearBuilt: 1995,
  /** HOA fees and approvals kill assignments. */
  allowHoa: false,
} as const;

// ── DISTRESS — this is what actually creates the deal ───────────────────────

/** Cumulative time on market that qualifies as motivation on its own. */
export const DISTRESS_DOM_DAYS = 60;
/** A price cut only signals motivation at real size. The 2% cut on 2943
 *  Hillside after 81 days is anchoring, not distress. */
export const DISTRESS_PRICE_CUT_PCT = 0.05;

export const DISTRESS_KEYWORDS: readonly string[] = [
  "as-is", "as is", "investor special", "handyman", "tlc", "cash only",
  "needs work", "needs updating", "fixer", "estate sale", "probate",
  "vacant", "motivated seller", "bring all offers", "priced to sell",
  "sold as-is", "no repairs",
];

/** Copy that kills the deal outright. */
export const EXCLUDE_KEYWORDS: readonly string[] = [
  // Already renovated — a distress opener at a turnkey ask only burns the agent.
  "fully renovated", "newly renovated", "completely remodeled", "turnkey",
  "move-in ready", "new construction",
  // Explicitly closed to us.
  "no wholesalers", "no wholesaling", "no assignments", "not assignable",
  "end buyers only", "principal buyers only",
  // Different process entirely.
  "auction", "short sale",
];

/** LANDLORD-YIELD MARKETING — the 2943 Hillside class, and a distinction worth
 *  keeping: "investor special" is DISTRESS (good). "Ideal for investors seeking
 *  stable cash flow" is a listing already priced for the buyer we would assign
 *  TO, so the spread is gone before we arrive. */
export const LANDLORD_PITCH_KEYWORDS: readonly string[] = [
  "stable cash flow", "rental portfolio", "income potential", "cap rate",
  "turnkey rental", "tenant in place", "proforma",
];

// ── PURE HELPERS ────────────────────────────────────────────────────────────

export function tierForCity(city: string | null | undefined): TierBand | null {
  const c = (city ?? "").trim().toLowerCase();
  if (!c) return null;
  return TIER_BANDS.find((b) => b.metros.some((m) => c.includes(m))) ?? null;
}

/** The ask ceiling for a city — its tier's, else the global cap. */
export function maxAskFor(city: string | null | undefined): number {
  return tierForCity(city)?.maxAsk ?? MAX_ASK_ANY_MARKET;
}

/** Pure: the most we can pay and still clear the fee. The deal test. */
export function maoFor(input: { arv: number; rehab: number; fee?: number }): number {
  const fee = input.fee ?? TARGET_ASSIGNMENT_FEE;
  return Math.max(0, input.arv * ARV_BUY_BOX_PCT - input.rehab - fee);
}

/** Pure: does the ask leave room for a deal at all? */
export function askPencils(input: { ask: number; arv: number; rehab: number; fee?: number }): boolean {
  return input.ask <= maoFor(input);
}

export function hasAny(text: string | null | undefined, needles: readonly string[]): boolean {
  const t = (text ?? "").toLowerCase();
  return needles.some((n) => t.includes(n));
}
