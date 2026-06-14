// V21 writer fire-decision (keystone 2026-06-13, spine recUA3woaBnF5SBK5,
// Maverick ruling A-prime). @agent: appraiser
//
// THE PRECISE CONTRACT lane. Decides whether a fresh record should get a
// landlord V2.1 Your_MAO written, and at what CONFIDENCE TIER.
//
// Ruling A-prime (supersedes "all 5 HOLD"):
//   1. resolveCohortTrack stays the SINGLE distress predicate system-wide.
//      water_damage / as-is condition redflags DO count as distress. No
//      forked predicate (that's the drift we kill).
//   2. BUT a redflag-only classification (null distressScore, distress
//      resting on VISION alone) is not trustworthy enough to AUTHORIZE a
//      contract write — vision is the known-lying input (Rosemary: vision
//      flagged water_damage + $25,769 rehab on a renovated house).
//   3. So the landlord set splits by confidence TIER (not by predicate):
//        landlord            — distressScore > 0: human/scored signal,
//                              authorized to write a real V21 now.
//        landlord_provisional— redflag-only (vision-only): write V21 but
//                              mark provisional; it CANNOT authorize a
//                              contract/send until the DD loop corroborates
//                              the condition with the agent. Agent confirms
//                              damage → promote; agent says renovated →
//                              vision noise → fall back to flipper, no
//                              number was ever authorized on a hallucination.
//
// PRINCIPLE: a vision-only signal informs and routes, it never authorizes.
// Same doctrine as rough-opener-vs-precise-contract and DD-pins-rehab.
//
// Idempotent: never recompute a record that already has Your_MAO_V21.

import { resolveCohortTrack } from "@/lib/track-aware-underwrite";

export type V21Lane = "landlord" | "landlord_provisional";

export type V21WriteDecision =
  | { write: true; lane: V21Lane }
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
  ctx: { priceable: boolean; allowReprice?: boolean },
): V21WriteDecision {
  if (!ctx.priceable) return { write: false, reason: "not_priceable" };
  if ((listing.liveStatus ?? "").trim().toLowerCase() !== "active") {
    return { write: false, reason: "not_active" };
  }
  // Idempotent — never overwrite a live V21 value on the INITIAL-underwrite
  // path (the V21-fresh cron fires once per cold priceable record).
  //
  // EXCEPTION — reply-triggered RE-PRICE (Maverick 2026-06-14, "fresh paid
  // pulls on an ALREADY-underwritten record, fires ONLY on a seller reply").
  // When ctx.allowReprice is set the caller is the reply trigger deliberately
  // recomputing an existing number off fresh inputs, so the idempotency guard
  // is bypassed. Re-price still demands priceable + active + landlord-track
  // below — a flipper-track record's re-price is its ARV refresh, not this.
  if (!ctx.allowReprice && typeof listing.yourMao === "number" && Number.isFinite(listing.yourMao) && listing.yourMao > 0) {
    return { write: false, reason: "already_has_v21" };
  }
  // Ruling #1: resolveCohortTrack is the SINGLE distress predicate.
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
  // Rulings #2/#3: confidence tier on the SAME predicate's landlord output.
  // distressScore > 0 = scored/authorized; redflag-only = vision-only =
  // PROVISIONAL (must be DD-corroborated before it authorizes anything).
  const scoreBacked = typeof listing.distressScore === "number" && listing.distressScore > 0;
  return { write: true, lane: scoreBacked ? "landlord" : "landlord_provisional" };
}

