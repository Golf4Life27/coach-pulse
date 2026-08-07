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
