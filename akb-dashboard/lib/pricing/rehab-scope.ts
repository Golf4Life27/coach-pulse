// REHAB SCOPE TIERS — price the scope, ask the agent which one it is.
// @agent: appraiser
//
// THE PROBLEM (operator, 2026-08-06): "rehab could be estimated light, medium,
// heavy ($15sqft, 30sqft, 45sqft) then our offers are dependent on the scope
// rather than concrete stamped before knowing what the interior actually is."
//
// Today a record with no vision read gets a placeholder rehab (a % of ARV),
// which the pricer correctly refuses to send — placeholder_rehab_needs_vision
// was 4 of 9 held bumps and 49 records in the pool. The record then waits on a
// vision queue. Vision infers the interior from listing photos; it is a guess
// with a rendering budget.
//
// The agent has BEEN INSIDE THE HOUSE. Asking them which scope it is costs
// nothing, arrives in minutes, and is better evidence than a model reading
// photos. On 2026-08-06 an Indianapolis agent volunteered exactly this,
// unprompted, in response to an offer: "brand new roof on both the garage and
// home itself, fully finished basement with updated mechanicals throughout" —
// the property was not a rehab at all, and nothing in the system had asked.
//
// So: derive rehab from sqft × a named scope tier, LEAD WITH THE HEAVY TIER
// (INVARIANTS §2 pessimistic rehab bounds — the number we say out loud must be
// the conservative one), and name what the light scope would support so the
// agent has a reason to correct us. Their answer is free scope intel.
//
// DOCTRINE: this is NOT a ratio of the seller's ask. rehab = sqft × $/sqft is
// derived from the PROPERTY, so the opener stays value-anchored:
//   opener = anchor × (ARV × buybox − sqft × scopePsf − fee)
// Only the rehab TERM changes basis, from "invented % of ARV" to "named scope
// at a published $/sqft". It needs no pricing-doctrine amendment.

export type RehabScope = "light" | "medium" | "heavy";

/** Operator's tiers (2026-08-06). Dollars per square foot.
 *
 *  Calibration check against a real record: 8235 Prest St carried a vision
 *  rehab of $23,970 on 940 sqft = $25.50/sqft, and the operator independently
 *  called it "light/medium" — which lands exactly between LIGHT and MEDIUM.
 *  The tiers are env-tunable; these are the launch values. */
export const SCOPE_PSF: Readonly<Record<RehabScope, number>> = {
  light: envNum("REHAB_SCOPE_LIGHT_PSF", 15),
  medium: envNum("REHAB_SCOPE_MEDIUM_PSF", 30),
  heavy: envNum("REHAB_SCOPE_HEAVY_PSF", 45),
};

/** What each tier MEANS, in the words an agent would use. The label has to be
 *  answerable by someone standing in the house, or the question is useless. */
export const SCOPE_DESCRIPTION: Readonly<Record<RehabScope, string>> = {
  light: "paint, carpet, fixtures — mechanicals and roof are sound",
  medium: "kitchen and baths, plus some mechanicals",
  heavy: "full gut — roof, mechanicals, kitchen, baths",
};

/** The scope we ASSUME when nobody has been inside. Heavy, per INVARIANTS §2:
 *  an unknown interior is priced pessimistically, and the number we say out
 *  loud is the conservative one. Better information may only RAISE it. */
export const DEFAULT_UNKNOWN_SCOPE: RehabScope = "heavy";

function envNum(key: string, dflt: number): number {
  const raw = Number(process.env[key]);
  return Number.isFinite(raw) && raw > 0 ? raw : dflt;
}

const pos = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** Pure: rehab dollars for a scope. Null without sqft — there is no honest
 *  scope estimate for a house whose size we do not know, and inventing one is
 *  the exact failure this replaces. */
export function rehabForScope(sqft: number | null | undefined, scope: RehabScope): number | null {
  if (!pos(sqft)) return null;
  return Math.round(sqft * SCOPE_PSF[scope]);
}

/** Pure: infer the scope a known rehab dollar figure implies. Used to describe
 *  a VISION result in the same vocabulary, so the agent conversation and the
 *  model output speak one language. Nearest tier by $/sqft. */
export function scopeForRehab(
  rehab: number | null | undefined,
  sqft: number | null | undefined,
): RehabScope | null {
  if (!pos(rehab) || !pos(sqft)) return null;
  const psf = rehab / sqft;
  let best: RehabScope = "light";
  let bestGap = Infinity;
  for (const s of ["light", "medium", "heavy"] as const) {
    const gap = Math.abs(psf - SCOPE_PSF[s]);
    if (gap < bestGap) { bestGap = gap; best = s; }
  }
  return best;
}

export interface ScopedOpenerInput {
  sqft: number | null | undefined;
  arv: number | null | undefined;
  /** Market buy-box (arv_pct_max). */
  arvPctMax: number | null | undefined;
  fee: number | null | undefined;
  /** Anchor applied to the ceiling. */
  anchor: number | null | undefined;
  /** Rounding step for the sent number. */
  roundTo?: number;
}

export interface ScopedOpener {
  scope: RehabScope;
  rehab: number;
  /** ARV × buybox − rehab − fee. This IS the MAO at this scope. */
  mao: number;
  /** anchor × mao, rounded. Null when the scope leaves nothing to offer. */
  opener: number | null;
}

/** Pure: the opener at each scope tier.
 *
 *  A tier whose MAO lands at or below zero returns opener null — the house
 *  does not pencil at that scope, which is itself the answer. */
export function scopedOpeners(input: ScopedOpenerInput): ScopedOpener[] {
  const { sqft, arv, arvPctMax, fee, anchor } = input;
  const round = pos(input.roundTo) ? input.roundTo : 250;
  if (!pos(sqft) || !pos(arv) || !pos(arvPctMax) || fee == null || !pos(anchor)) return [];

  return (["light", "medium", "heavy"] as const).map((scope) => {
    const rehab = Math.round(sqft * SCOPE_PSF[scope]);
    const mao = arv * arvPctMax - rehab - fee;
    const opener = mao > 0 ? Math.round((anchor * mao) / round) * round : null;
    return { scope, rehab, mao: Math.round(mao), opener: opener != null && opener > 0 ? opener : null };
  });
}

/** Pure: pick one tier out of a computed set. */
export function openerAtScope(openers: readonly ScopedOpener[], scope: RehabScope): ScopedOpener | null {
  return openers.find((o) => o.scope === scope) ?? null;
}

/** Pure: the number we SAY — the pessimistic tier's opener (INVARIANTS §2).
 *  Falls back down the tiers only when a heavier scope does not pencil at all,
 *  because "no offer" is not a conversation. */
export function pessimisticOpener(openers: readonly ScopedOpener[]): ScopedOpener | null {
  for (const s of ["heavy", "medium", "light"] as const) {
    const o = openerAtScope(openers, s);
    if (o && o.opener != null) return o;
  }
  return null;
}

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/** Pure: the scope question, appended to an opener.
 *
 *  It states the conservative number, names what a lighter scope would support,
 *  and asks which it is. The agent has stood in the house; their correction is
 *  free, arrives in minutes, and beats a vision model reading listing photos.
 *
 *  Never promises the higher number — "could go to" is the ceiling of a lighter
 *  scope, contingent on their answer, and INVARIANTS §3 stickiness still binds
 *  whatever we actually send. */
export function scopeQuestion(opts: {
  pessimistic: ScopedOpener;
  lighter: ScopedOpener | null;
}): string {
  const { pessimistic, lighter } = opts;
  const base =
    `That assumes a ${pessimistic.scope} scope — ${SCOPE_DESCRIPTION[pessimistic.scope]}.`;
  if (!lighter || lighter.opener == null || lighter.opener <= pessimistic.opener!) {
    return `${base} If the interior is in better shape than that, tell me what it needs and I'll rework the number.`;
  }
  return (
    `${base} If it's really ${lighter.scope} — ${SCOPE_DESCRIPTION[lighter.scope]} — ` +
    `I can go to ${usd(lighter.opener)}. Which is it?`
  );
}

/** Pure: the lighter tier worth naming next to the pessimistic one — one step
 *  up, and only when it actually pencils to a better number. */
export function lighterTierFor(
  openers: readonly ScopedOpener[],
  pessimistic: ScopedOpener,
): ScopedOpener | null {
  const order: RehabScope[] = ["heavy", "medium", "light"];
  const i = order.indexOf(pessimistic.scope);
  if (i < 0 || i + 1 >= order.length) return null;
  const next = openerAtScope(openers, order[i + 1]);
  if (!next || next.opener == null || pessimistic.opener == null) return null;
  return next.opener > pessimistic.opener ? next : null;
}

// ── THE WIRED ENTRY POINT (2026-08-07) ──────────────────────────────────────
// Used by lib/rough-opener-ceiling when a record has NO vision rehab. Replaces
// the %-of-ARV placeholder that was holding 260 of 616 eligible houses.

/** DEFAULT OFF — measured on live records, this LOWERS volume. Opt in with
 *  SCOPE_REHAB_ENABLED=true.
 *
 *  MEASURED 2026-08-07 through the shipped pricer (lib/opener-pricing), 26
 *  real records with sqft + list and no rehab estimate:
 *
 *    Detroit, 14 records:  3 sends -> 2.   Openers FELL (Kingsville
 *      $60,250 -> $45,000; 4102 Somerset $42,000 -> $28,000).
 *    Atlanta, 12 records:  0 sends -> 0.   No effect either way.
 *
 *  WHY, and it is arithmetic, not tuning. The estimate this replaces is
 *  ROUGH_REHAB_PCT_OF_ARV = 0.30 x ARV = 0.30 x psf x sqft. Against heavy at
 *  $45/sqft, the two are equal when 45 = 0.30 x psf, i.e. psf = $150. BELOW a
 *  $150/sqft renovated market the scope tier is the LARGER rehab, so it
 *  produces a SMALLER opener and more records fall under the low-opener floor.
 *  Detroit seeds run $39-$118/sqft — every Detroit ZIP is on the losing side.
 *
 *  A $/sqft rehab constant is only meaningful next to the market's value per
 *  square foot: $45/sqft on a house worth $92/sqft finished is half the
 *  finished value. The %-of-ARV estimate already self-scales to the market,
 *  which is exactly the "blanket average" behaviour we wanted, so it stays the
 *  default. Above $150/sqft the tiers help — Atlanta is $161-$333 — but there
 *  the binding constraint is the $75k unseen-rehab exposure cap (#188), which
 *  no rehab formula moves.
 *
 *  The tiers keep their real job: the QUESTION to the agent (scopeQuestion),
 *  where a named scope beats a percentage because a human can answer it. */
export const SCOPE_REHAB_ENABLED = process.env.SCOPE_REHAB_ENABLED === "true";

/** The floor an opener must clear to be worth sending: max(pct×list, $USD).
 *  Mirrors minOfferFloor in per-market-pricer; duplicated as an OPTIONAL input
 *  here so this module stays pure and dependency-free. */
export interface PickScopeInput {
  sqft: number;
  arv: number;
  arvPctMax: number;
  fee: number;
}

export interface PickedScope {
  scope: RehabScope;
  rehab: number;
  mao: number;
}

/** Pure: the most PESSIMISTIC scope the property can actually carry.
 *
 *  Walks heavy → medium → light and returns the first whose MAO is positive.
 *  Measured on the live pool: heavy-only would have sent 58 records and killed
 *  91 outright (MAO goes negative at $45/sqft on a cheap house — that is not
 *  conservatism, it is a dead record). Stepping down only when the heavier
 *  scope cannot carry a deal sends 160 while still saying the lowest number
 *  the house supports.
 *
 *  Returns null without sqft — inventing a rehab for a house of unknown size
 *  is the exact failure this replaces. */
export function pickScopeRehab(input: PickScopeInput): PickedScope | null {
  const { sqft, arv, arvPctMax, fee } = input;
  if (!pos(sqft) || !pos(arv) || !pos(arvPctMax) || !Number.isFinite(fee)) return null;
  for (const scope of ["heavy", "medium", "light"] as const) {
    const rehab = Math.round(sqft * SCOPE_PSF[scope]);
    const mao = arv * arvPctMax - rehab - fee;
    if (mao > 0) return { scope, rehab, mao: Math.round(mao) };
  }
  return null; // nothing pencils at any scope — the record genuinely does not work
}
