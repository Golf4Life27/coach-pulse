// INV-022 Sprint 2 — FEMA National Flood Hazard Layer (NFHL) lookup.
// @agent: data_federation
//
// Free public ArcGIS REST service — no API key. Queries the NFHL flood
// hazard zone polygon layer for a point. Flood zone is STATIC per parcel,
// so Q4 discipline says cache permanently: the cron only pulls when
// FEMA_Flood_Zone is empty (shouldPullFlood predicate).
//
// Point geometry requires lat/lng. Listings_V1 carries address, not coords,
// so geocodeAddress (Google Maps Geocoding, reusing GOOGLE_MAPS_API_KEY) is
// the bridge. Both fetches are thin; the pure URL-build + response-parse
// functions carry the unit tests.
//
// NFHL layer 28 = "Flood Hazard Zones" on the public MapServer.

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

const NFHL_BASE =
  "https://hazards.fema.gov/gis/nfhl/rest/services/public/NFHL/MapServer/28/query";

export interface LatLng {
  lat: number;
  lng: number;
}

/** Pure: build the NFHL point-intersect query URL. inSR/outSR 4326 (WGS84
 *  lat/lng). Returns FLD_ZONE + ZONE_SUBTY, no geometry. */
export function buildNfhlQueryUrl(point: LatLng): string {
  const u = new URL(NFHL_BASE);
  u.searchParams.set("geometry", `${point.lng},${point.lat}`);
  u.searchParams.set("geometryType", "esriGeometryPoint");
  u.searchParams.set("inSR", "4326");
  u.searchParams.set("spatialRel", "esriSpatialRelIntersects");
  u.searchParams.set("outFields", "FLD_ZONE,ZONE_SUBTY");
  u.searchParams.set("returnGeometry", "false");
  u.searchParams.set("f", "json");
  return u.toString();
}

interface NfhlResponse {
  features?: Array<{ attributes?: { FLD_ZONE?: string; ZONE_SUBTY?: string } }>;
}

/** Pure: extract the flood zone code from an NFHL query response. No
 *  intersecting polygon → "X" (outside mapped SFHA — the standard NFIP
 *  convention for "minimal hazard / unmapped"). Distinguishes a real
 *  empty-feature answer from a missing/error response (latter → null). */
export function parseNfhlZone(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const r = body as NfhlResponse;
  if (!Array.isArray(r.features)) return null;
  if (r.features.length === 0) return "X";
  const zone = r.features[0]?.attributes?.FLD_ZONE;
  return zone && zone.trim() !== "" ? zone.trim() : "X";
}

/** Pure: skip flood pull when already populated (static-per-parcel cache).
 *  Q4 discipline — flood zone never changes for a parcel. */
export function shouldPullFlood(existingZone: string | null | undefined): boolean {
  return !existingZone || existingZone.trim() === "";
}

/** Query NFHL for a point's flood zone. Throws on non-2xx (Positive
 *  Confirmation Principle — a failed pull is a real signal, not "X"). */
export async function getFloodZoneByPoint(point: LatLng): Promise<string | null> {
  const res = await fetch(buildNfhlQueryUrl(point), { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`NFHL query ${res.status}: ${await res.text().catch(() => "")}`);
  }
  return parseNfhlZone(await res.json());
}

/** Pure: build the Google Maps geocode URL for an address. */
export function buildGeocodeUrl(address: string, apiKey: string): string {
  const u = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  u.searchParams.set("address", address);
  u.searchParams.set("key", apiKey);
  return u.toString();
}

/** Pure: extract lat/lng from a Google geocode response. null when no result. */
export function parseGeocode(body: unknown): LatLng | null {
  if (typeof body !== "object" || body === null) return null;
  const r = body as {
    status?: string;
    results?: Array<{ geometry?: { location?: { lat?: number; lng?: number } } }>;
  };
  if (r.status !== "OK" || !r.results?.length) return null;
  const loc = r.results[0]?.geometry?.location;
  if (loc?.lat == null || loc?.lng == null) return null;
  return { lat: loc.lat, lng: loc.lng };
}

/** Geocode an address to lat/lng via Google Maps. Returns null when the
 *  key is missing or no result (caller treats flood as un-hydratable). */
export async function geocodeAddress(address: string): Promise<LatLng | null> {
  if (!GOOGLE_MAPS_API_KEY) return null;
  const res = await fetch(buildGeocodeUrl(address, GOOGLE_MAPS_API_KEY), {
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Geocode ${res.status}: ${await res.text().catch(() => "")}`);
  }
  return parseGeocode(await res.json());
}

/** Full address → flood zone. Returns null when geocoding fails (no coords
 *  to query NFHL with). */
export async function getFloodZoneByAddress(address: string): Promise<string | null> {
  const point = await geocodeAddress(address);
  if (!point) return null;
  return getFloodZoneByPoint(point);
}
