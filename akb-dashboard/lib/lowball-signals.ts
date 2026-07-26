// Proxy distress-signal mappers for the lowball-eligibility front gate.
// @agent: crier/appraiser
//
// EXTRACTED to a shared module (2026-07-26) so the read-only preview
// (app/api/admin/opener-dry-run) and the LIVE send path
// (app/api/cron/h2-outreach) share ONE implementation. Before this the
// mappers lived only inside the dry-run route, which meant the preview could
// never be trusted as a forecast of the live gate — there was no live gate,
// and any future live copy would have drifted.
//
// These approximate the live distress signals from stored cohort fields. The
// crawler computes them fresh from Firecrawl (listing language) + rehab
// vision; over the existing cohort we PROXY: intake distressScore /
// distressBucket stands in for listing-language distress, parsed redFlags for
// the vision read. DOM is exact (lib/attom/cumulative-dom).
//
// Labeled as a proxy everywhere it surfaces so it is never mistaken for live.
// Pure. No I/O.

import type { Listing } from "@/lib/types";

/** Listing-LANGUAGE distress proxy: the intake distress score / bucket. */
export function listingLanguageDistress(l: Listing): boolean {
  if (typeof l.distressScore === "number" && l.distressScore > 0) return true;
  const b = (l.distressBucket ?? "").toLowerCase();
  return b.includes("distress") || b.includes("motivated") || b.includes("high");
}

/** VISUAL-read distress proxy: any parsed rehab red flag on the record. */
export function visionDistress(l: Listing): boolean {
  const rf = l.redFlags ?? l.rehabRedFlags ?? null;
  if (Array.isArray(rf)) return rf.length > 0;
  if (typeof rf === "string") return rf.trim().length > 0 && rf.trim() !== "[]";
  return false;
}
