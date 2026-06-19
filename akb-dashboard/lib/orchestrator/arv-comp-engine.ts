// ARV Comp Engine — auto-completes DD-1 from per-ZIP renovated comp seeds.
// CONVEYOR Milestone 3. @agent: appraiser
//
// THE CARDINAL PRINCIPLE: a check goes green because the engine produced REAL
// validated comp data — never because a human or the engine waved it through.
//   VALIDATED → STRONG seed + sqft known + comp_count ≥ 3 + fresh + class match.
//               ARV is the CONSERVATIVE low end (Arv_Low_PerSqft × sqft) — never
//               overestimate the resale.
//   ESCALATE  → a seed exists but is thin (THIN tier, <3 comps, stale, missing
//               sqft, no low-end, or non-SFR class). Routes to the operator
//               (Manual Review). Type 2C — must reach a human, never auto-pass.
//   BLOCKED   → no seed for the ZIP, or a DONT_PRICE-tier ZIP. Never price.
//
// HARD CONSTRAINTS:
//   - NEVER reads a RentCast AVM (/v1/avm/value) as ARV — that is an AS-IS
//     value and is what caused 23 Fields. The ONLY source is the renovated
//     comp seed (lib/zip-arv-seed-store). `source` is "seed_renovated_low" or
//     "none"; there is no AVM code path here.
//   - Does NOT trust the contaminated stored Real_ARV_Median field.
//   - Confidence is a transparent function of (tier, comp_count, freshness,
//     sqft-known, class-match) — never fabricated.
//
// PURE. Takes a subject + a pre-fetched ZipArvSeed (the live path fetches the
// seed via getZipArvSeed and calls this). Compose, don't reinvent.

import type { ZipArvSeed } from "@/lib/zip-arv-seed-store";

export type ArvDecision = "VALIDATED" | "ESCALATE" | "BLOCKED";
export type ArvConfidence = "high" | "med" | "low";
export type ArvSeedTier = "STRONG" | "THIN" | "DONT_PRICE" | "NONE";

export interface ArvSubject {
  recordId?: string | null;
  zip: string | null;
  sqft: number | null;
  propertyType?: string | null;
}

export interface ArvEngineResult {
  recordId: string | null;
  zip: string | null;
  decision: ArvDecision;
  reason: string;
  /** CONSERVATIVE ARV = Arv_Low_PerSqft × sqft (the low end). Null when not computable. */
  engineArv: number | null;
  arvLowPerSqft: number | null;
  /** Renovated (median) $/sqft — surfaced for transparency; NOT the ARV the gate uses. */
  renovatedPerSqft: number | null;
  sqft: number | null;
  compCount: number | null;
  seedTier: ArvSeedTier;
  freshness: { fetchedAt: string | null; ageDays: number | null; stale: boolean };
  confidence: ArvConfidence | null;
  /** Always seed-derived; never an AVM. */
  source: "seed_renovated_low" | "none";
  arvBasis: "renovated_comp_low_end_per_sqft";
  classMatch: boolean | null;
  issues: string[];
}

/** Max seed age before the ARV is treated as stale (ZIP-level comp pull, not
 *  per-property — env-tunable). */
export const ARV_SEED_FRESHNESS_DAYS = (() => {
  const raw = Number(process.env.ARV_SEED_FRESHNESS_DAYS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 45;
})();
export const ARV_MIN_COMPS = 3;

/** DEFAULT-OFF. Gates writing the engine ARV to records + auto-ticking DD-1 in
 *  production. OFF ⇒ watched mode (compute + trace, write nothing). */
export function isArvEngineAutocompleteLive(): boolean {
  return process.env.ARV_ENGINE_AUTOCOMPLETE_LIVE === "true";
}

const SFR_CLASSES: ReadonlySet<string> = new Set([
  "single family",
  "single family residence",
  "single family residential",
  "single family home",
  "single family detached",
  "sfr",
  "sf detached",
  "residential",
]);

function classMatchOf(propertyType: string | null | undefined): boolean | null {
  if (propertyType == null || propertyType.trim() === "") return null; // unknown
  return SFR_CLASSES.has(propertyType.trim().toLowerCase());
}

const pos = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

function deriveConfidence(strong: boolean, comps: number, fresh: boolean, sqftKnown: boolean, classMatched: boolean): ArvConfidence {
  if (strong && comps >= 5 && fresh && sqftKnown && classMatched) return "high";
  if (strong && comps >= ARV_MIN_COMPS && fresh && sqftKnown) return "med";
  return "low";
}

/** Pure: evaluate a subject against its ZIP's renovated-comp seed. */
export function evaluateArvFromSeed(
  subject: ArvSubject,
  seed: ZipArvSeed | null,
  now: Date = new Date(),
): ArvEngineResult {
  const zip = subject.zip ?? null;
  const sqft = pos(subject.sqft) ? subject.sqft : null;
  const base = {
    recordId: subject.recordId ?? null,
    zip,
    sqft,
    source: "none" as const,
    arvBasis: "renovated_comp_low_end_per_sqft" as const,
    engineArv: null,
    arvLowPerSqft: null,
    renovatedPerSqft: null,
    compCount: null as number | null,
    confidence: null as ArvConfidence | null,
    classMatch: null as boolean | null,
    issues: [] as string[],
    freshness: { fetchedAt: null as string | null, ageDays: null as number | null, stale: false },
  };

  // No seed → BLOCKED (launch-market ZIPs are unseeded; next milestone).
  if (!seed) {
    return { ...base, decision: "BLOCKED", reason: `No renovated-comp seed for ZIP ${zip ?? "(unknown)"} — cannot validate ARV.`, seedTier: "NONE" };
  }

  const fetchedAt = seed.fetchedAt ?? null;
  const t = fetchedAt ? Date.parse(fetchedAt) : NaN;
  const ageDays = Number.isNaN(t) ? null : (now.getTime() - t) / 86_400_000;
  const stale = ageDays != null && ageDays > ARV_SEED_FRESHNESS_DAYS;
  const freshness = { fetchedAt, ageDays: ageDays == null ? null : Number(ageDays.toFixed(1)), stale };

  const tier: ArvSeedTier = seed.confidence === "STRONG" ? "STRONG" : seed.confidence === "DONT_PRICE" ? "DONT_PRICE" : "THIN";
  const compCount = pos(seed.compCount) ? seed.compCount : seed.compCount ?? 0;
  const arvLow = pos(seed.arvLowPerSqft) ? seed.arvLowPerSqft : null;
  const reno = pos(seed.renovatedPerSqft) ? seed.renovatedPerSqft : null;
  const classMatch = classMatchOf(subject.propertyType);

  // DONT_PRICE → BLOCKED (never price off a do-not-price ZIP).
  if (seed.dontPrice || seed.confidence === "DONT_PRICE") {
    return {
      ...base,
      seedTier: "DONT_PRICE",
      compCount,
      arvLowPerSqft: arvLow,
      renovatedPerSqft: reno,
      freshness,
      decision: "BLOCKED",
      reason: `ZIP ${zip} is DONT_PRICE tier (comps too few / too dispersed) — never price off this seed.`,
    };
  }

  // CONSERVATIVE ARV: the LOW end of the renovated band. Deliberately lower
  // than the renovated $/sqft used for sticker pricing — never overestimate.
  const engineArv = sqft != null && arvLow != null ? Math.round(arvLow * sqft) : null;

  const issues: string[] = [];
  if (seed.confidence !== "STRONG") issues.push(`seed tier ${tier} (not STRONG)`);
  if (sqft == null) issues.push("subject sqft unknown");
  if (compCount < ARV_MIN_COMPS) issues.push(`comp_count ${compCount} < ${ARV_MIN_COMPS}`);
  if (stale) issues.push(`seed stale (${freshness.ageDays}d > ${ARV_SEED_FRESHNESS_DAYS}d)`);
  if (arvLow == null) issues.push("seed has no Arv_Low_PerSqft (no conservative low end)");
  if (classMatch === false) issues.push("property class is not SFR (seed is SFR-distressed)");
  if (classMatch === null) issues.push("property class unknown — can't confirm SFR match");

  const confidence = deriveConfidence(seed.confidence === "STRONG", compCount, !stale, sqft != null, classMatch === true);
  const common = {
    ...base,
    source: "seed_renovated_low" as const,
    seedTier: tier,
    compCount,
    arvLowPerSqft: arvLow,
    renovatedPerSqft: reno,
    engineArv,
    freshness,
    confidence,
    classMatch,
    issues,
  };

  if (issues.length === 0) {
    return {
      ...common,
      decision: "VALIDATED",
      reason: `VALIDATED — STRONG seed, ${compCount} comps; conservative ARV $${engineArv!.toLocaleString()} = Arv_Low_PerSqft $${arvLow} × ${sqft} sqft (fresh ${freshness.ageDays}d).`,
    };
  }
  return {
    ...common,
    decision: "ESCALATE",
    reason: `ESCALATE to operator (Manual Review): ${issues.join("; ")}. Partial ARV ${engineArv != null ? "$" + engineArv.toLocaleString() : "uncomputable"}.`,
  };
}
