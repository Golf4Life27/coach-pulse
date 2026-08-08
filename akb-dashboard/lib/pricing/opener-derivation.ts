// OPENER DERIVATION RECEIPT — store the arithmetic, not just the answer.
// @agent: appraiser
//
// WHY (audit 2026-08-06). The operator asked what the MAO was on 8235 Prest St
// and I could not tell him from the record. It stored Opener_Basis
// "arv_buybox_seed" and a $26,000 opener, and NOTHING ELSE — no ARV, no rehab,
// no fee, no anchor, no buy-box percentage. Twelve different combinations of
// (arv_pct_max, fee, anchor, psf) all round to $26,000, so the number could not
// be reproduced even knowing the property, the seed and the formula.
//
// The pricing doctrine already requires better: a priced record must carry
// "the derived opener (or the HOLD reason), both MAO lanes with the binding one
// named, the pricing_mode, and the inputs it was derived from — so any session
// can recompute it cold." It also requires, as standard 1, that every opener be
// RECOMPUTED and matched before queueing. Neither is enforceable against a
// record that kept only the answer.
//
// That is why the math FEELS untrustworthy even where it is correct. An
// unauditable right answer and a wrong one are indistinguishable from outside,
// and every question turns into reverse-engineering.
//
// So: priceOpenerWithSeed already computes every term (arvUsed, rehabUsed,
// anchorPct, ceiling, placeholderRehab, arvSource, corroborationFlags). This
// serialises them into ONE receipt field, and — the part that actually makes
// the standard enforceable — provides verifyDerivation(), which recomputes the
// opener FROM THE RECEIPT and reports whether it reproduces. A receipt that
// cannot reproduce its own opener is evidence, not a rounding quirk.

/** Everything needed to recompute an opener cold. Versioned: a reader must be
 *  able to tell which arithmetic produced a receipt it did not write. */
export const DERIVATION_SCHEMA_VERSION = 1;

export interface OpenerDerivation {
  v: number;
  /** The number that would be sent, or null on a HOLD. */
  opener: number | null;
  /** Compact basis/HOLD label (Opener_Basis). */
  basis: string;
  // ── the inputs, in the order the formula consumes them ──
  /** Renovated $/sqft actually used (seed median/low), when seed-derived. */
  psf: number | null;
  sqft: number | null;
  /** ARV the pricer used = psf × sqft, or the stored ARV. */
  arv: number | null;
  /** Which basis fed it — seed_renovated / stored / none. */
  arvSource: string;
  /** Market buy-box (markets.json arv_pct_max, or the national default). */
  arvPctMax: number | null;
  rehab: number | null;
  /** TRUE when rehab was a %-of-ARV guess rather than a vision read. */
  rehabPlaceholder: boolean;
  fee: number | null;
  /** Anchor applied to the ceiling to produce the opener. */
  anchor: number | null;
  // ── the intermediate the formula produces ──
  /** arv × arvPctMax − rehab − fee. This IS the MAO. */
  ceiling: number | null;
  /** Rounding increment applied to anchor × ceiling. */
  roundTo: number | null;
  /** Corroboration flags that held the number, if any. */
  flags: string[];
}

export interface DerivationInputs {
  opener: number | null;
  basis: string;
  psf?: number | null;
  sqft?: number | null;
  arv?: number | null;
  arvSource?: string | null;
  arvPctMax?: number | null;
  rehab?: number | null;
  rehabPlaceholder?: boolean;
  fee?: number | null;
  anchor?: number | null;
  ceiling?: number | null;
  roundTo?: number | null;
  flags?: readonly string[];
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** Pure: build the receipt. */
export function buildDerivation(input: DerivationInputs): OpenerDerivation {
  return {
    v: DERIVATION_SCHEMA_VERSION,
    opener: num(input.opener),
    basis: input.basis,
    psf: num(input.psf),
    sqft: num(input.sqft),
    arv: num(input.arv),
    arvSource: input.arvSource ?? "none",
    arvPctMax: num(input.arvPctMax),
    rehab: num(input.rehab),
    rehabPlaceholder: input.rehabPlaceholder === true,
    fee: num(input.fee),
    anchor: num(input.anchor),
    ceiling: num(input.ceiling),
    roundTo: num(input.roundTo),
    flags: [...(input.flags ?? [])],
  };
}

/** Pure: the receipt as the compact JSON that goes in the Airtable field. */
export function serializeDerivation(d: OpenerDerivation): string {
  return JSON.stringify(d);
}

/** Pure: parse a stored receipt. Returns null on anything unreadable — a
 *  corrupt receipt must never masquerade as a verified one. */
export function parseDerivation(raw: string | null | undefined): OpenerDerivation | null {
  if (!raw || typeof raw !== "string") return null;
  try {
    const o = JSON.parse(raw) as Partial<OpenerDerivation>;
    if (typeof o !== "object" || o === null) return null;
    if (typeof o.v !== "number" || typeof o.basis !== "string") return null;
    return buildDerivation(o as DerivationInputs);
  } catch {
    return null;
  }
}

export type VerifyStatus =
  | "reproduced"        // the receipt's inputs regenerate the stored opener
  | "mismatch"          // they regenerate a DIFFERENT number — the finding that matters
  | "hold_no_opener"    // a HOLD; nothing to reproduce
  | "incomplete";       // the receipt is missing a term, so it cannot be checked

export interface VerifyResult {
  status: VerifyStatus;
  /** What the receipt's own inputs produce. */
  recomputed: number | null;
  /** recomputed − stored. */
  delta: number | null;
  detail: string;
}

/** Rounding tolerance. The stored opener is rounded; the recompute must land
 *  within one rounding increment (or $1 when none was recorded). Anything
 *  wider is a genuine disagreement, not a rounding artifact. */
function toleranceFor(d: OpenerDerivation): number {
  const r = d.roundTo;
  return r != null && r > 0 ? r : 1;
}

/** Pure: does this receipt reproduce its own opener?
 *
 *  THIS is the enforcement the doctrine's recompute standard was missing. It
 *  needs no vendor call and no Airtable read — the receipt is self-contained,
 *  which is the whole point. */
export function verifyDerivation(d: OpenerDerivation | null): VerifyResult {
  if (!d) return { status: "incomplete", recomputed: null, delta: null, detail: "no derivation receipt on the record" };
  if (d.opener == null) {
    return { status: "hold_no_opener", recomputed: null, delta: null, detail: `HOLD (${d.basis}) — no opener to verify` };
  }
  const { arv, arvPctMax, rehab, fee, anchor } = d;
  if (arv == null || arvPctMax == null || rehab == null || fee == null || anchor == null) {
    const missing = [
      arv == null && "arv",
      arvPctMax == null && "arvPctMax",
      rehab == null && "rehab",
      fee == null && "fee",
      anchor == null && "anchor",
    ].filter(Boolean).join(", ");
    return { status: "incomplete", recomputed: null, delta: null, detail: `receipt missing: ${missing}` };
  }

  const ceiling = arv * arvPctMax - rehab - fee;
  const raw = anchor * ceiling;
  const r = d.roundTo;
  const recomputed = r != null && r > 0 ? Math.round(raw / r) * r : Math.round(raw);
  const delta = recomputed - d.opener;
  const tol = toleranceFor(d);

  if (Math.abs(delta) <= tol) {
    return {
      status: "reproduced",
      recomputed,
      delta,
      detail:
        `$${d.opener.toLocaleString()} = ${d.anchor} × (ARV $${arv.toLocaleString()} × ${arvPctMax} ` +
        `− rehab $${rehab.toLocaleString()} − fee $${fee.toLocaleString()})`,
    };
  }
  return {
    status: "mismatch",
    recomputed,
    delta,
    detail:
      `STORED $${d.opener.toLocaleString()} but its own inputs produce $${recomputed.toLocaleString()} ` +
      `(off by $${Math.abs(delta).toLocaleString()}) — ARV $${arv.toLocaleString()} × ${arvPctMax} ` +
      `− rehab $${rehab.toLocaleString()} − fee $${fee.toLocaleString()}, anchor ${anchor}`,
  };
}

/** Pure: the MAO the receipt implies, named. The ceiling IS the MAO — the most
 *  the deal supports before the anchor discounts it into an opening ask. The
 *  operator asked "what's MAO on Prest" and no record could answer; this is
 *  the answer, computed from the same receipt that produced the opener. */
export function maoFromDerivation(d: OpenerDerivation | null): number | null {
  if (!d) return null;
  if (d.ceiling != null) return Math.round(d.ceiling);
  const { arv, arvPctMax, rehab, fee } = d;
  if (arv == null || arvPctMax == null || rehab == null || fee == null) return null;
  return Math.round(arv * arvPctMax - rehab - fee);
}

/** Pure: one human-readable line for an operator or an SMS. */
export function explainDerivation(d: OpenerDerivation | null): string {
  if (!d) return "no derivation on file";
  const mao = maoFromDerivation(d);
  if (d.opener == null) return `HOLD (${d.basis})${mao != null ? ` — MAO would be $${mao.toLocaleString()}` : ""}`;
  const v = verifyDerivation(d);
  const head = `$${d.opener.toLocaleString()} [${d.basis}]`;
  const maoTxt = mao != null ? ` | MAO $${mao.toLocaleString()}` : "";
  return v.status === "reproduced" ? `${head}${maoTxt} — ${v.detail}` : `${head}${maoTxt} — ⚠ ${v.detail}`;
}
