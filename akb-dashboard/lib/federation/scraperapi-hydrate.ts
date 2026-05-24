// INV-022 Sprint 2 — Photo hydration for Property_Intel.
// @agent: data_federation
//
// Reuses lib/photo-sources.ts collectPhotos AS-IS (ScraperAPI Redfin photos
// + Google Street View fallback) and shapes the result into a Property_Intel
// photo contribution. Stores the URL set so INV-023 has visual-evidence refs
// without re-scraping. Does not modify the photo pipeline.

import { collectPhotos, type CollectedPhoto } from "@/lib/photo-sources";
import type { PhotoContribution } from "@/lib/federation/property-intel-store";
import type { VendorSource } from "@/lib/property-intel";

/** Pure: derive the top-level Photos_Source provenance from the per-photo
 *  sources collectPhotos returns. "listing" → scraperapi; "streetview" →
 *  streetview; both present → mixed; empty → manual_operator placeholder is
 *  NOT used (empty set means no photo hydration happened). */
export function summarizePhotoSource(
  photos: CollectedPhoto[],
): VendorSource {
  const hasListing = photos.some((p) => p.source === "listing");
  const hasStreet = photos.some((p) => p.source === "streetview");
  if (hasListing && hasStreet) return "mixed";
  if (hasListing) return "scraperapi";
  if (hasStreet) return "streetview";
  // Empty — caller should not write a photo contribution at all.
  return "scraperapi";
}

/** Pure: map collected photos to the stored {url, source} array shape. */
export function mapPhotosForStore(
  photos: CollectedPhoto[],
): Array<{ url: string; source: string }> {
  return photos.map((p) => ({ url: p.url, source: p.source }));
}

export interface PhotoHydrateInput {
  verificationUrl: string | null;
  fullAddress: string;
}

/** Hydrate the photo set. Returns null when collectPhotos comes back empty
 *  (no photo contribution written — Property_Intel photo fields stay null,
 *  unhydrated, per provenance discipline). */
export async function hydratePhotos(
  input: PhotoHydrateInput,
): Promise<PhotoContribution | null> {
  const photos = await collectPhotos({
    verificationUrl: input.verificationUrl,
    fullAddress: input.fullAddress,
  });
  if (photos.length === 0) return null;
  return {
    photos: mapPhotosForStore(photos),
    source: summarizePhotoSource(photos),
    fetchedAt: new Date().toISOString(),
  };
}
