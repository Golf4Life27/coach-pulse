// Rent-based landlord MAO lane — Track 2 (2026-06-05).
// @agent: orchestrator
//
// A second valuation lane for the INV-023 pre-contract gate. The
// existing lane (lib/pre-contract-math.ts) needs Buyer_Median, which has
// ZERO writers in prod (the InvestorBase scraper doesn't exist), so the
// gate HOLDs on every record for want of a wholesale-comp floor. The
// landlord lane gives an independent, income-based MAO from data we DO
// have in TX (rent + taxes) plus a SOURCED market cap rate.
//
// ── The math (V2.1 floor, corrected 2026-06-05) ──────────────────────
// Standard income (cap-rate) valuation:
//
//   landlord_value = annual_NOI / INVESTOR_REQUIRED_cap
//
//   annual_NOI = annual_gross_rent − annual_taxes − annual_opex
//   annual_gross_rent = monthly_rent × 12
//   annual_opex = annual_gross_rent × opex_ratio   (FULL non-tax load:
//                 insurance + vacancy + maintenance + management — taxes
//                 are explicit + separate; see NON_TAX_OPEX)
//
// ⚠️ `capRate` here MUST be the SOURCED, conservatively-high
// INVESTOR-REQUIRED cap (lib/investor-cap.ts), NOT the retail
// market-implied cap (RentCast median-sale ÷ rent) — that's retail,
// AVM-contaminated, and overstates MAO. Downstream (V2.1 floor):
//   Investor_MAO = landlord_value − Est_Rehab
//   Your_MAO     = Investor_MAO − Wholesale_Fee
//
// NOTE on the brief's shorthand: the brief wrote "landlord_max =
// cap_rate × net_rent". Dimensionally a cap-rate valuation is
// value = NOI / cap_rate (÷, not ×) — `× net_rent` is ~2 orders of
// magnitude off (e.g. 0.08 × $15k = $1,200, nonsense; $15k / 0.08 =
// $187,500, sane). This module implements the financially-correct ÷
// form. The cap rate + every assumption is surfaced to Maverick for
// source-confirmation before any live offer (per the brief).
//
// ── No fabricated defaults ───────────────────────────────────────────
// Every input that isn't known is a HOLD, never a guess: missing
// monthly_rent → hold; missing cap_rate (unsourced) → hold; missing
// taxes → hold. opex_ratio is the one modeling assumption and is passed
// in EXPLICITLY by the caller (sourced/confirmed), never defaulted here.
//
// Pure + unit-tested. No I/O.

// Full conservative NON-TAX operating-expense load (fraction of gross
// rent), corrected 2026-06-05 per operator: NOI must carry insurance +
// vacancy + maintenance + management — NOT taxes only. County property
// taxes are applied SEPARATELY as an explicit $ amount (see
// LandlordLaneInputs.annualTaxes). This ratio + its source are surfaced
// in every report for confirmation.
export const NON_TAX_OPEX = {
  vacancy: 0.08,
  maintenance: 0.1,
  management: 0.1,
  insurance: 0.07,
  /** Sum of the above = full non-tax load applied to gross rent. */
  ratio: 0.35,
  source:
    "Conservative SFR buy-hold underwriting: vacancy 8% + maintenance 10% + management 10% + insurance 7% = 35% of gross rent, " +
    "EXCLUDING county property taxes (applied separately as an explicit $ amount). Near the '50% rule' less taxes. " +
    "PENDING operator confirmation.",
} as const;

export interface LandlordLaneInputs {
  /** Subject monthly market rent (RentCast rent AVM). */
  monthlyRent: number | null | undefined;
  /** Subject annual property taxes in dollars (RentCast property record
   *  / TX county derivation). */
  annualTaxes: number | null | undefined;
  /** Operating-expense ratio as a fraction of gross rent (vacancy +
   *  insurance + maintenance + mgmt; EXCLUDES taxes, handled separately).
   *  Caller supplies an explicit, sourced/confirmed value — this module
   *  never defaults it. Must be in [0, 1). */
  opexRatio: number | null | undefined;
  /** Market cap rate as a fraction (e.g. 0.08 for 8%). MUST be sourced
   *  (RentCast market stats / cited report) and confirmed — never a
   *  guessed default. Must be > 0. */
  capRate: number | null | undefined;
}

export type LandlordLaneStatus = "ok" | "hold";

export interface LandlordLaneResult {
  status: LandlordLaneStatus;
  /** landlord_value = annual_NOI / cap_rate, rounded. null on hold. */
  landlordValue: number | null;
  /** Annual net operating income (gross rent − taxes − opex). null on hold. */
  annualNoi: number | null;
  annualGrossRent: number | null;
  annualOpex: number | null;
  /** Echo of the inputs actually used (for provenance / audit). */
  used: {
    monthlyRent: number | null;
    annualTaxes: number | null;
    opexRatio: number | null;
    capRate: number | null;
  };
  /** Which inputs were missing/invalid (drives the HOLD). */
  missing: string[];
  reason: string;
}

function validNumber(v: unknown, opts: { min?: number; max?: number; minInclusive?: boolean } = {}): boolean {
  if (typeof v !== "number" || !Number.isFinite(v)) return false;
  if (opts.min != null) {
    if (opts.minInclusive ? v < opts.min : v <= opts.min) return false;
  }
  if (opts.max != null && v >= opts.max) return false;
  return true;
}

/**
 * Pure: compute the income-based landlord MAO. HOLD (status:"hold",
 * landlordValue:null) when ANY required input is missing/invalid — no
 * fabricated default. The cap rate must be a positive sourced fraction;
 * opex_ratio must be in [0,1); rent and taxes non-negative.
 */
export function computeLandlordMax(inputs: LandlordLaneInputs): LandlordLaneResult {
  const missing: string[] = [];

  const monthlyRent = inputs.monthlyRent;
  const annualTaxes = inputs.annualTaxes;
  const opexRatio = inputs.opexRatio;
  const capRate = inputs.capRate;

  if (!validNumber(monthlyRent, { min: 0, minInclusive: false })) missing.push("monthly_rent");
  // Taxes may legitimately be 0 (rare) — accept ≥ 0.
  if (!validNumber(annualTaxes, { min: 0, minInclusive: true })) missing.push("annual_taxes");
  if (!validNumber(opexRatio, { min: 0, max: 1, minInclusive: true })) missing.push("opex_ratio");
  if (!validNumber(capRate, { min: 0, minInclusive: false })) missing.push("cap_rate");

  const used = {
    monthlyRent: validNumber(monthlyRent, { min: 0, minInclusive: false }) ? (monthlyRent as number) : null,
    annualTaxes: validNumber(annualTaxes, { min: 0, minInclusive: true }) ? (annualTaxes as number) : null,
    opexRatio: validNumber(opexRatio, { min: 0, max: 1, minInclusive: true }) ? (opexRatio as number) : null,
    capRate: validNumber(capRate, { min: 0, minInclusive: false }) ? (capRate as number) : null,
  };

  if (missing.length > 0) {
    return {
      status: "hold",
      landlordValue: null,
      annualNoi: null,
      annualGrossRent: null,
      annualOpex: null,
      used,
      missing,
      reason: `Landlord lane HOLD — missing/invalid input(s): ${missing.join(", ")}. No fabricated defaults; hydrate or source before computing.`,
    };
  }

  const mRent = monthlyRent as number;
  const taxes = annualTaxes as number;
  const opex = opexRatio as number;
  const cap = capRate as number;

  const annualGrossRent = Math.round(mRent * 12);
  const annualOpex = Math.round(annualGrossRent * opex);
  const annualNoi = annualGrossRent - annualOpex - Math.round(taxes);
  const landlordValue = Math.round(annualNoi / cap);

  // A non-positive NOI means the property doesn't cash-flow at all at
  // these rents/expenses — the income approach yields a non-positive or
  // meaningless value. Surface as HOLD (the deal isn't a landlord deal),
  // not a fake number.
  if (annualNoi <= 0) {
    return {
      status: "hold",
      landlordValue: null,
      annualNoi,
      annualGrossRent,
      annualOpex,
      used,
      missing: [],
      reason: `Landlord lane HOLD — annual NOI is ${annualNoi} (≤0). At gross rent $${annualGrossRent.toLocaleString()}, opex $${annualOpex.toLocaleString()}, taxes $${Math.round(taxes).toLocaleString()} the property does not cash-flow; income valuation is not meaningful.`,
    };
  }

  return {
    status: "ok",
    landlordValue,
    annualNoi,
    annualGrossRent,
    annualOpex,
    used,
    missing: [],
    reason: `Landlord value = NOI $${annualNoi.toLocaleString()} / cap ${(cap * 100).toFixed(2)}% = $${landlordValue.toLocaleString()} (gross rent $${annualGrossRent.toLocaleString()} − opex $${annualOpex.toLocaleString()} − taxes $${Math.round(taxes).toLocaleString()}).`,
  };
}
