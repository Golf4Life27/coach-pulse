// V21 writer fire-decision (keystone 2026-06-13, spine recmgjlZSwhECn1W0,
// Maverick Flag-1 ruling). @agent: appraiser
//
// THE PRECISE CONTRACT lane. Decides whether a fresh record should get a
// landlord V2.1 Your_MAO written. Flag-1 doctrine (absolute):
//   - Write landlord V21 ONLY when distress signals are present (the
//     distressed-as-is cohort, where the landlord NOI/cap lane is the
//     correct one).
//   - A flipper-track record (no distress) returns HOLD — it does NOT
//     borrow the landlord lane. Flipper comp-ARV math is future; until
//     it ships, flipper records HOLD. HOLD is honest; a wrong-lane
//     ceiling is the exact error that killed prior deals.
//
// Idempotent: never recompute a record that already has Your_MAO_V21
// (the writer fills nulls, never overwrites a live value).
//
// Reuses lib/track-aware-underwrite.resolveCohortTrack — the SAME
// distressed→landlord resolver the rest of the system uses. No parallel
// distress predicate.

import { resolveCohortTrack } from "@/lib/track-aware-underwrite";

export type V21WriteDecision =
  | { write: true; lane: "landlord" }
  | { write: false; reason: "not_priceable" | "not_active" | "already_has_v21" | "flipper_lane_holds_no_comp_arv_math" };

export interface V21WriteCandidate {
  liveStatus?: string | null;
  yourMao?: number | null;          // Your_MAO_V21 — idempotency key
  state?: string | null;
  zip?: string | null;
  redFlags?: string[] | string | null;
  distressBucket?: string | null;
  distressScore?: number | null;
}

export function decideV21Write(
  listing: V21WriteCandidate,
  ctx: { priceable: boolean },
): V21WriteDecision {
  if (!ctx.priceable) return { write: false, reason: "not_priceable" };
  if ((listing.liveStatus ?? "").trim().toLowerCase() !== "active") {
    return { write: false, reason: "not_active" };
  }
  // Idempotent — never overwrite a live V21 value.
  if (typeof listing.yourMao === "number" && Number.isFinite(listing.yourMao) && listing.yourMao > 0) {
    return { write: false, reason: "already_has_v21" };
  }
  // Flag-1: landlord-only-on-distress. Flipper → HOLD (no comp-ARV math).
  const track = resolveCohortTrack({
    state: listing.state ?? null,
    zip: listing.zip ?? null,
    redFlags: listing.redFlags ?? null,
    distressBucket: listing.distressBucket ?? null,
    distressScore: listing.distressScore ?? null,
  });
  if (track !== "landlord") {
    return { write: false, reason: "flipper_lane_holds_no_comp_arv_math" };
  }
  return { write: true, lane: "landlord" };
}
