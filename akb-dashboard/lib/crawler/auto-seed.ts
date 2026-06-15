// Market auto-seed — the national crawler's frontier engine (Maverick
// 2026-06-14, HALF 2 step 3). @agent: scout/appraiser
//
// When the crawler hits a ZIP with no ARV seed yet, it seeds the ZIP itself
// from ONE representative comp pull: pull renovated sold comps for a
// representative listing → derive the ZIP's renovated $/sqft (lib/arv-
// intelligence) → cache it in ZIP_ARV_Seed. After that every listing in the
// ZIP prices for free. THIS is what makes the crawler national instead of
// Detroit-only: a market does NOT need full verification to send a
// conservative opener — it needs a rough, conservative, RECEIPTED number.
//
// COST: one paid comp pull per NEW ZIP seed (getSaleComparables audits its
// own paid_api_call), clamped by the daily budget governor (lib/spend/
// daily-budget) — the cap governs FRONTIER GROWTH, not steady-state pricing.
//
// SAFETY: restricted states (IL/MO/SC/NC/OK/ND) are never seeded (load-
// frozen in the market registry). A brand-new market's first seed is meant
// to be operator-eyeballed (seed + comp receipts) before its openers go
// live — that gate lives at the SEND layer (per-market auto-promote), not
// here; this module only produces the receipted seed.
//
// The gating decision is pure (decideAutoSeed) for tests; runAutoSeed
// composes the existing I/O (RentCast comps → ARV intel → seed store).

import { getSaleComparables } from "@/lib/rentcast";
import { computeArvIntelligence } from "@/lib/arv-intelligence";
import { getRestrictedStates } from "@/lib/markets/registry";
import {
  seedFromArvIntelligence,
  upsertZipArvSeed,
  type ZipArvSeed,
} from "@/lib/zip-arv-seed-store";

export type AutoSeedSkipReason =
  | "zip_invalid"
  | "restricted_state"
  | "already_seeded"
  | "budget_exhausted"
  | "no_representative_subject";

export interface AutoSeedDecision {
  seed: boolean;
  reason: AutoSeedSkipReason | "ok";
  detail: string;
}

export interface DecideAutoSeedInput {
  zip: string | null | undefined;
  state: string | null | undefined;
  /** ZIP already carries an ARV seed (listArvSeededZips). */
  alreadySeeded: boolean;
  /** Daily seed budget has headroom (lib/spend/daily-budget). */
  canSeed: boolean;
  /** A representative listing (address + ideally sqft) exists to pull comps
   *  against — RentCast comps are address-based. */
  hasRepresentativeSubject: boolean;
}

/** Pure: should the crawler spend a comp pull to seed this ZIP right now?
 *  Restricted-state skip first (never spend on a structurally-dead market),
 *  then already-seeded, then budget, then data availability. */
export function decideAutoSeed(input: DecideAutoSeedInput): AutoSeedDecision {
  const zip = String(input.zip ?? "").trim();
  if (!/^\d{5}$/.test(zip)) return { seed: false, reason: "zip_invalid", detail: `"${input.zip}" is not a 5-digit ZIP` };

  const state = (input.state ?? "").trim().toUpperCase();
  if (state && getRestrictedStates().has(state)) {
    return { seed: false, reason: "restricted_state", detail: `${state} is wholesale-restricted — never seeded` };
  }
  if (input.alreadySeeded) {
    return { seed: false, reason: "already_seeded", detail: `ZIP ${zip} already has an ARV seed — pricing is free, no pull` };
  }
  if (!input.canSeed) {
    return { seed: false, reason: "budget_exhausted", detail: "daily seed budget exhausted — frontier paused (seeded ZIPs keep pricing)" };
  }
  if (!input.hasRepresentativeSubject) {
    return { seed: false, reason: "no_representative_subject", detail: `ZIP ${zip} has no representative listing to pull comps against` };
  }
  return { seed: true, reason: "ok", detail: `ZIP ${zip} unseeded, budget OK, subject available — seed it` };
}

export interface RepresentativeSubject {
  address: string;
  city: string;
  state: string;
  zip: string;
  bedrooms?: number | null;
  bathrooms?: number | null;
  squareFootage?: number | null;
}

export interface AutoSeedResult {
  ok: boolean;
  zip: string;
  seeded: boolean;
  confidence?: ZipArvSeed["confidence"];
  renovatedPerSqft?: number | null;
  compCount?: number;
  reason: string;
}

/** Async: seed one ZIP from a representative subject. Pulls RentCast comps
 *  (one paid call, self-audited), derives the renovated $/sqft via the
 *  Appraiser ARV engine, and upserts the seed. Targets the RENOVATED
 *  headline (condition_target=renovated) so the $/sqft is retail-ARV, not
 *  as-is. Zero comps → no seed (visible, not a fabricated number). */
export async function runAutoSeed(subject: RepresentativeSubject): Promise<AutoSeedResult> {
  const zip = subject.zip.trim();
  let comps;
  try {
    comps = await getSaleComparables({
      address: subject.address,
      city: subject.city,
      state: subject.state,
      zip,
      bedrooms: subject.bedrooms ?? null,
      bathrooms: subject.bathrooms ?? null,
      squareFootage: subject.squareFootage ?? null,
    });
  } catch (err) {
    return { ok: false, zip, seeded: false, reason: `comp_pull_failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!comps || comps.length === 0) {
    return { ok: true, zip, seeded: false, reason: "zero_comps_returned — ZIP left unseeded (no fabricated $/sqft)" };
  }

  const arv = computeArvIntelligence(comps, {
    zip,
    beds: subject.bedrooms ?? null,
    baths: subject.bathrooms ?? null,
    sqft: subject.squareFootage ?? null,
    condition_target: "renovated", // seed the RETAIL renovated $/sqft
  });

  const write = seedFromArvIntelligence(arv, "rentcast_avm", { state: subject.state });
  if (!write) {
    return { ok: true, zip, seeded: false, reason: "no_usable_per_sqft — comps had no clean $/sqft; ZIP left unseeded" };
  }

  try {
    await upsertZipArvSeed(write);
  } catch (err) {
    return { ok: false, zip, seeded: false, reason: `seed_upsert_failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  return {
    ok: true,
    zip,
    seeded: true,
    confidence: arv.comp_count_used >= 5 ? "STRONG" : "THIN",
    renovatedPerSqft: write.renovatedPerSqft,
    compCount: write.compCount,
    reason: `seeded ZIP ${zip}: $${write.renovatedPerSqft}/sqft from ${write.compCount} comps (${arv.comp_count_used >= 5 ? "STRONG" : "THIN"})`,
  };
}
