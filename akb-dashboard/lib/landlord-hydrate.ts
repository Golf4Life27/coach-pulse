// V2.1 economics hydration — 2026-06-05.
// @agent: orchestrator / appraiser
//
// WHY THIS EXISTS — the legacy-field quarantine.
// The Airtable economics fields Your_MAO / Investor_MAO / Real_ARV_Median
// are LEGACY: they were written by the old ARV-driven formula whose
// wholesale-fee/profit constants ($15k + $30k = the −45,000 sentinel)
// predate V2.1, and whose value basis (Real_ARV_Median) is an
// AVM-contaminated, banned offer-math input in non-disclosure TX. NOTHING
// may treat those persisted fields as economic truth.
//
// This module is the clean replacement: it computes the V2.1 landlord-lane
// MAO from SOURCED inputs (rent + county taxes + sourced investor-required
// cap + Est_Rehab) using the exact endpoint logic (lib/landlord-lane +
// lib/pre-contract-math), and stamps a provenance marker so a consumer can
// tell a V2.1-clean number from a legacy one. The flipper lane stays
// uncomputable in TX (no Buyer_Median writers) → landlord is operative;
// lower-of-two-lanes applies once flipper ships.
//
//   landlord_value = annual_NOI / investor_required_cap
//   Investor_MAO   = landlord_value − Est_Rehab        (V2.1 floor)
//   Your_MAO       = Investor_MAO − $5,000 wholesale fee
//
// Missing rent / taxes / rehab / cap → HOLD (no fabricated numbers).
//
// Pure. No I/O — the caller fetches rent/taxes and persists the result.

import { computeLandlordMax, NON_TAX_OPEX } from "./landlord-lane";
import { computeInvestorMao, computeYourMao, DEFAULT_WHOLESALE_FEE } from "./pre-contract-math";

// ── Tax-plausibility guard (TX) ────────────────────────────────────────
// RentCast /properties returns county-only or partial taxes for many TX
// records (e.g. $555/yr on 5435 Callaghan in Bexar — implies 0.28% effective
// rate against the $196k assessed value, impossible: TX floor is 1.5–2%+).
// Persisting a V2.1 MAO from a tax this corrupt poisons the field of record.
//
// Posture: same as the cap gate — never compute on an input we can't trust.
// Effective rate = taxes / assessedValue. If < TX_TAX_RATE_FLOOR (1.2% — a
// safety margin below the empirical 1.5–2%+ floor that catches the $555 class
// but lets a legitimately-low Bexar record through), the tax is treated as
// UNRELIABLE → missing input → caller HOLDs (null taxes → V2.1 HOLD).
//
// TX-only by design. TN already HOLDs on the cap-confirmation gate, so the
// guard is moot there; other states aren't in scope yet.

export const TX_TAX_RATE_FLOOR = 0.012;

export interface TaxPlausibilityResult {
  plausible: boolean;
  /** Implied effective rate (taxes / assessedValue), or null when not
   *  computable. */
  effectiveRate: number | null;
  reason: string;
}

/** Pure: TX tax-plausibility check. For non-TX, returns plausible:true
 *  (out of scope; TN HOLDs upstream on cap). Returns plausible:true when
 *  assessedValue isn't available (can't reject what we can't measure —
 *  this matches the "no fabricated rejection" posture). */
export function checkTxTaxPlausibility(
  state: string | null | undefined,
  annualTaxes: number | null | undefined,
  assessedValue: number | null | undefined,
): TaxPlausibilityResult {
  const s = (state ?? "").trim().toUpperCase();
  if (s !== "TX") {
    return { plausible: true, effectiveRate: null, reason: "non-TX (guard scope is TX only)" };
  }
  if (typeof annualTaxes !== "number" || !Number.isFinite(annualTaxes) || annualTaxes <= 0) {
    // No taxes to check — caller already HOLDs on missing taxes.
    return { plausible: true, effectiveRate: null, reason: "no taxes to evaluate" };
  }
  if (typeof assessedValue !== "number" || !Number.isFinite(assessedValue) || assessedValue <= 0) {
    // Without assessed value we can't compute the rate. Pass through (the
    // V2.1 lane will still HOLD if other inputs missing); don't manufacture
    // a rejection on a missing comparator.
    return { plausible: true, effectiveRate: null, reason: "no assessed value to compute rate" };
  }
  const rate = annualTaxes / assessedValue;
  if (rate < TX_TAX_RATE_FLOOR) {
    return {
      plausible: false,
      effectiveRate: rate,
      reason: `TX tax-plausibility FAIL — effective rate ${(rate * 100).toFixed(3)}% < floor ${(TX_TAX_RATE_FLOOR * 100).toFixed(1)}% (TX is 1.5–2%+). Taxes $${annualTaxes.toLocaleString()} vs assessed $${assessedValue.toLocaleString()} — unreliable, treat as missing input.`,
    };
  }
  return {
    plausible: true,
    effectiveRate: rate,
    reason: `TX tax-plausibility OK — effective rate ${(rate * 100).toFixed(3)}% ≥ floor ${(TX_TAX_RATE_FLOOR * 100).toFixed(1)}%.`,
  };
}

// ── Confirmed-override resolution ──────────────────────────────────────
// Verified facts (operator/Maverick-sourced or county-CAD-scraped) must
// survive autonomous re-runs — the structural anti-regression. When a
// confirmed value lives on the record, the cron uses it and NEVER
// overwrites it.
//
// PRECEDENCE (2026-06-06 — ATTOM assessor becomes the primary auto path):
//   (1) Annual_Taxes_Confirmed (operator/CAD-confirmed) — wins absolutely.
//   (2) ATTOM assessor — nationwide tax-roll data; authoritative even in
//       non-disclosure states. Tax-plausibility guard still applies as a
//       backstop (the guard catches the few records where the tax roll
//       lookup itself fails to a known-bad value).
//   (3) RentCast /properties — fallback only, with plausibility guard.
//   (4) null → V2.1 HOLD.

export type TaxSource =
  | "confirmed"
  | "attom_assessor"
  | "attom_assessor_implausible"
  | "rentcast_auto"
  | "rentcast_implausible"
  | "missing";

export interface TaxResolution {
  /** The taxes the V2.1 computation should use. null → HOLD. */
  annualTaxes: number | null;
  source: TaxSource;
  /** When source==='confirmed', the operator-supplied provenance label. */
  confirmedLabel?: string | null;
  /** When the auto path was rejected by plausibility, the rejection reason. */
  plausibilityReason?: string;
  /** True when the cron should NOT write back this field (confirmed values
   *  are immutable from the cron's perspective). */
  freezeWrite: boolean;
}

/** Pure: resolve which tax value to use, applying confirmed-override
 *  precedence, ATTOM-then-RentCast fallback, and the TX plausibility guard. */
export function resolveAnnualTaxes(input: {
  state: string | null | undefined;
  confirmedTaxes: number | null | undefined;
  confirmedLabel: string | null | undefined;
  attomTaxes?: number | null | undefined;
  attomAssessedValue?: number | null | undefined;
  rentcastTaxes: number | null | undefined;
  /** Subject assessed value (for the plausibility check). ATTOM-sourced
   *  is preferred; rentcast-sourced is the fallback. */
  assessedValue: number | null | undefined;
}): TaxResolution {
  // (1) Confirmed value wins, full stop. Never overwritten by the cron.
  if (typeof input.confirmedTaxes === "number" && Number.isFinite(input.confirmedTaxes) && input.confirmedTaxes > 0) {
    return {
      annualTaxes: Math.round(input.confirmedTaxes),
      source: "confirmed",
      confirmedLabel: input.confirmedLabel ?? null,
      freezeWrite: true,
    };
  }
  // (2) ATTOM assessor (preferred auto-path). Use ATTOM's own assessed value
  //     for the plausibility check when available; otherwise the RentCast
  //     assessed value.
  if (typeof input.attomTaxes === "number" && Number.isFinite(input.attomTaxes) && input.attomTaxes > 0) {
    const attomAssessed = input.attomAssessedValue ?? input.assessedValue;
    const plaus = checkTxTaxPlausibility(input.state, input.attomTaxes, attomAssessed);
    if (!plaus.plausible) {
      return {
        annualTaxes: null,
        source: "attom_assessor_implausible",
        plausibilityReason: plaus.reason,
        freezeWrite: false,
      };
    }
    return {
      annualTaxes: Math.round(input.attomTaxes),
      source: "attom_assessor",
      freezeWrite: false,
    };
  }
  // (3) RentCast fallback with the same plausibility guard.
  const plaus = checkTxTaxPlausibility(input.state, input.rentcastTaxes, input.assessedValue);
  if (!plaus.plausible) {
    return {
      annualTaxes: null,
      source: "rentcast_implausible",
      plausibilityReason: plaus.reason,
      freezeWrite: false,
    };
  }
  if (typeof input.rentcastTaxes === "number" && Number.isFinite(input.rentcastTaxes) && input.rentcastTaxes > 0) {
    return {
      annualTaxes: Math.round(input.rentcastTaxes),
      source: "rentcast_auto",
      freezeWrite: false,
    };
  }
  return { annualTaxes: null, source: "missing", freezeWrite: false };
}

// ── Investor-required cap: ONLY operator-CONFIRMED markets default ─────
// Confirmation gates the computation. An unconfirmed cap silently
// defaulting in is the false-dispose machine: a too-high cap understates
// value → negative MAO → a live deal silently buried on a parameter
// nobody confirmed. So unconfirmed market === missing input === HOLD
// (return null), NEVER a guessed band default.
//
// CONFIRMED (operator, 2026-06-05): 78228-transitional 10%, other TX 9%.
// NOT confirmed: Memphis/TN — 10–12% is a CANDIDATE band only (see
// lib/investor-cap.ts), so TN returns null → HOLD until confirmed.
export const TRANSITIONAL_ZIPS: ReadonlySet<string> = new Set<string>([
  "78228", // 5435 Callaghan Rd
]);

export function defaultInvestorCapFor(
  state: string | null | undefined,
  zip: string | null | undefined,
): number | null {
  const z = (zip ?? "").trim();
  if (z && TRANSITIONAL_ZIPS.has(z)) return 0.1; // confirmed transitional
  const s = (state ?? "").trim().toUpperCase();
  if (s === "TX") return 0.09; // confirmed SA / TX-metro
  // TN (Memphis) is a CANDIDATE band, NOT confirmed → HOLD, never default.
  return null;
}

export interface V21MaoInputs {
  monthlyRent: number | null | undefined;
  annualTaxes: number | null | undefined;
  estRehab: number | null | undefined;
  capRate: number | null | undefined;
  /** Non-tax opex ratio (defaults to the sourced NON_TAX_OPEX.ratio). */
  opexRatio?: number;
  /** Wholesale fee (defaults to V2.1 DEFAULT_WHOLESALE_FEE = $5,000). */
  wholesaleFee?: number;
}

export interface V21MaoResult {
  /** "ok" only when rent + taxes + cap + rehab all present AND NOI>0. */
  status: "ok" | "hold";
  landlordValue: number | null;
  investorMao: number | null;
  yourMao: number | null;
  cap: number | null;
  /** Inputs actually used (provenance). */
  used: { monthlyRent: number | null; annualTaxes: number | null; estRehab: number | null; capRate: number | null; opexRatio: number; wholesaleFee: number };
  reason: string;
}

/**
 * Pure: the V2.1 landlord-lane Your_MAO from sourced inputs. Composes the
 * endpoint's own libs (computeLandlordMax → computeInvestorMao →
 * computeYourMao). HOLD on any missing input — never a fabricated number.
 */
export function computeV21LandlordMao(inp: V21MaoInputs): V21MaoResult {
  const opexRatio = inp.opexRatio ?? NON_TAX_OPEX.ratio;
  const wholesaleFee = inp.wholesaleFee ?? DEFAULT_WHOLESALE_FEE;
  const capRate = typeof inp.capRate === "number" && Number.isFinite(inp.capRate) ? inp.capRate : null;
  const estRehab = typeof inp.estRehab === "number" && Number.isFinite(inp.estRehab) ? inp.estRehab : null;
  const used = {
    monthlyRent: typeof inp.monthlyRent === "number" && Number.isFinite(inp.monthlyRent) ? inp.monthlyRent : null,
    annualTaxes: typeof inp.annualTaxes === "number" && Number.isFinite(inp.annualTaxes) ? inp.annualTaxes : null,
    estRehab,
    capRate,
    opexRatio,
    wholesaleFee,
  };

  const ll = computeLandlordMax({ monthlyRent: inp.monthlyRent, annualTaxes: inp.annualTaxes, opexRatio, capRate });
  if (ll.status !== "ok") {
    return { status: "hold", landlordValue: ll.landlordValue, investorMao: null, yourMao: null, cap: capRate, used, reason: ll.reason };
  }
  const investorMao = computeInvestorMao(ll.landlordValue, estRehab);
  if (investorMao == null) {
    return {
      status: "hold",
      landlordValue: ll.landlordValue,
      investorMao: null,
      yourMao: null,
      cap: capRate,
      used,
      reason: `V2.1 HOLD — Est_Rehab missing/invalid (need rehab to compute Investor_MAO from landlord value $${ll.landlordValue?.toLocaleString()}).`,
    };
  }
  const yourMao = computeYourMao(investorMao, wholesaleFee);
  return {
    status: "ok",
    landlordValue: ll.landlordValue,
    investorMao,
    yourMao,
    cap: capRate,
    used,
    reason: `V2.1 landlord Your_MAO=$${yourMao?.toLocaleString()} = (NOI/cap $${ll.landlordValue?.toLocaleString()} − rehab $${estRehab?.toLocaleString()} − fee $${wholesaleFee.toLocaleString()}).`,
  };
}

// ── Provenance marker (the quarantine boundary) ───────────────────────
// Stamped into Verification_Notes when V2.1 economics are persisted. Its
// presence is the ONLY way a consumer should trust the economics fields:
// a record without a fresh MAO_V2.1 marker carries legacy (quarantined)
// numbers and must be treated as economically unknown.

export const MAO_V21_SENTINEL = "MAO_V2.1";

const MARKER_RE = /\[MAO_V2\.1 [^\]]*\]/g;
// Non-global twin for stateless .test() (a /g regex's lastIndex is
// stateful across calls and would skip lines in a filter).
const MARKER_LINE_RE = /\[MAO_V2\.1 [^\]]*\]/;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export interface MaoV21Marker {
  yourMao: number | null;
  investorMao: number | null;
  cap: number | null;
  rent: number | null;
  taxes: number | null;
  status: "ok" | "hold";
  /** Confidence tier (keystone 2026-06-13, A-prime). "landlord" =
   *  scored/authorized; "landlord_provisional" = vision-only distress,
   *  CANNOT authorize a contract until the DD loop corroborates. Absent
   *  on a parsed legacy/stale-deal-triage marker → defaults "landlord". */
  lane?: "landlord" | "landlord_provisional";
}

/** Pure: build the single-line provenance marker. */
export function buildMaoV21Marker(m: MaoV21Marker, now: Date): string {
  const f = (v: number | null) => (v == null ? "-" : String(v));
  const stamp = `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())}`;
  const lane = m.lane ?? "landlord";
  return `[${MAO_V21_SENTINEL} status=${m.status} lane=${lane} your_mao=${f(m.yourMao)} investor_mao=${f(m.investorMao)} cap=${m.cap == null ? "-" : m.cap.toFixed(4)} rent=${f(m.rent)} taxes=${f(m.taxes)} @${stamp}]`;
}

/** Pure: parse the LAST MAO_V2.1 marker out of a notes blob. null when
 *  none present (→ legacy / unknown economics → must not be trusted). */
export function parseMaoV21Marker(notes: string | null | undefined): MaoV21Marker | null {
  if (!notes) return null;
  const matches = notes.match(MARKER_RE);
  if (!matches || matches.length === 0) return null;
  const last = matches[matches.length - 1];
  const get = (key: string): string | null => {
    const m = last.match(new RegExp(`${key}=([^ \\]]+)`));
    return m ? m[1] : null;
  };
  const num = (key: string): number | null => {
    const v = get(key);
    if (v == null || v === "-") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const status = get("status");
  const laneRaw = get("lane");
  return {
    status: status === "ok" ? "ok" : "hold",
    lane: laneRaw === "landlord_provisional" ? "landlord_provisional" : "landlord",
    yourMao: num("your_mao"),
    investorMao: num("investor_mao"),
    cap: num("cap"),
    rent: num("rent"),
    taxes: num("taxes"),
  };
}

/** Pure: replace any existing MAO_V2.1 marker(s) with the new one (so the
 *  record carries exactly one, current marker — notes don't accrete). The
 *  marker is kept on its own line, appended after non-marker notes. */
export function upsertMaoV21Marker(notes: string | null | undefined, marker: string): string {
  const stripped = (notes ?? "")
    .split("\n")
    .filter((line) => !MARKER_LINE_RE.test(line))
    .join("\n")
    .replace(/\s+$/u, "");
  return stripped.length > 0 ? `${stripped}\n${marker}` : marker;
}
