// County-deed sold comps — open government data as the ARV evidence source.
// @agent: appraiser
//
// WHY (2026-07-19): the week's receipts proved the vendor chain end to end:
// RentCast's AVM comparables are asks (no sale fields at all), and its
// property-record deeds lag the courthouse by ~9-12 months (newest recorded
// sale across 68-73 parcels in three metros: Oct 2025). Cities publish the
// actual ledger: Detroit's assessor Property Sales dataset carries deed
// transfers THREE DAYS old, with arm's-length verification labels — fresher
// and more honest than any vendor, free forever, published to be used.
//
// SHAPE: per-metro registry of ArcGIS FeatureServer sources. Subject is
// geocoded via the free US Census geocoder; sales come from a lat/long
// window query (arm's-length residential only); building sqft joins from
// the parcels layer by parcel_id. Output is the same RentCastSaleComp
// shape the ARV engine already filters — same subject-exclusion, same
// recency window, same receipts. Beds/baths are null (deed ledgers don't
// carry them) and the beds-exact filter passes nulls by design.
//
// FAIL-OPEN TO THE VENDOR, FAIL-HONEST TO THE OPERATOR: infrastructure
// failures (geocoder down, ArcGIS error) throw so the caller can fall back
// to RentCast; a clean query with zero qualifying sales returns [] — an
// honest answer, never a fallback trigger (stale vendor data must not
// paper over a real "no recent sales here").

import type { RentCastSaleComp } from "@/lib/rentcast";
import { haversineMiles } from "@/lib/rentcast";

export interface CountyDeedSource {
  market: string;
  /** Lowercased city names this source is authoritative for. */
  cities: string[];
  state: string;
  salesUrl: string;
  parcelsUrl: string;
  /** ArcGIS where-clause fragment for arm's-length residential sales. */
  salesWhere: string;
}

/** Detroit: assessor Property Sales (updated ~daily; verified 2026-07-19
 *  with sales three days old) + Parcels (Current) for building sqft.
 *  NOTE: city-of-Detroit parcels only — Highland Park/Hamtramck are
 *  separate assessors and fall through to the vendor path. */
export const COUNTY_DEED_SOURCES: CountyDeedSource[] = [
  {
    market: "detroit",
    cities: ["detroit"],
    state: "MI",
    salesUrl:
      "https://services2.arcgis.com/qvkbeam7Wirps6zC/arcgis/rest/services/assessor_property_sales_view/FeatureServer/0/query",
    parcelsUrl:
      "https://services2.arcgis.com/qvkbeam7Wirps6zC/arcgis/rest/services/parcel_file_current/FeatureServer/0/query",
    salesWhere:
      "property_class_code='401' AND amt_sale_price > 1000 AND term_of_sale LIKE '03-%'",
  },
];

/** Pure: the registry entry for a subject, or null (vendor path). */
export function countyDeedSourceFor(
  city: string | null | undefined,
  state: string | null | undefined,
): CountyDeedSource | null {
  const c = (city ?? "").trim().toLowerCase();
  const s = (state ?? "").trim().toUpperCase();
  if (!c || !s) return null;
  return COUNTY_DEED_SOURCES.find((src) => src.state === s && src.cities.includes(c)) ?? null;
}

/** ~0.8mi window in degrees (lat; lng widened for Detroit's latitude). The
 *  ARV filter clips at max_distance_miles — the pull is deliberately wider
 *  so the receipts SHOW near-misses instead of silently not fetching them. */
export const PULL_LAT_DEG = 0.0125;
export const PULL_LNG_DEG = 0.017;

export interface DeedSaleRow {
  parcel_id?: string | null;
  address?: string | null;
  sale_date?: string | null;
  amt_sale_price?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  zip_code?: string | null;
}

export interface ParcelRow {
  parcel_id?: string | null;
  total_floor_area?: number | null;
  year_built?: number | null;
}

/** Pure: deed sale row + parcel join → the comp shape the ARV engine eats.
 *  Null when the row is unusable (no price / no date). */
export function deedRowToComp(
  row: DeedSaleRow,
  parcelsById: ReadonlyMap<string, ParcelRow>,
  subjectLat: number | null,
  subjectLng: number | null,
  source: CountyDeedSource,
): RentCastSaleComp | null {
  const price = row.amt_sale_price;
  const date = (row.sale_date ?? "").slice(0, 10);
  if (typeof price !== "number" || price <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parcel = row.parcel_id ? parcelsById.get(row.parcel_id) : undefined;
  const sqft = parcel?.total_floor_area;
  const distance =
    subjectLat != null && subjectLng != null &&
    typeof row.latitude === "number" && typeof row.longitude === "number"
      ? Number(haversineMiles(subjectLat, subjectLng, row.latitude, row.longitude).toFixed(4))
      : null;
  const cityLabel = source.cities[0].replace(/\b\w/g, (ch) => ch.toUpperCase());
  return {
    price,
    squareFootage: typeof sqft === "number" && sqft > 0 ? sqft : null,
    bedrooms: null,
    bathrooms: null,
    yearBuilt: typeof parcel?.year_built === "number" && parcel.year_built > 0 ? parcel.year_built : null,
    distance,
    daysOnMarket: null,
    removedDate: null,
    saleDate: `${date}T00:00:00.000Z`,
    formattedAddress:
      [row.address, cityLabel, source.state, row.zip_code].filter(Boolean).join(", ") || null,
  };
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`county-deeds HTTP ${res.status}: ${url.slice(0, 120)}`);
  return (await res.json()) as Record<string, unknown>;
}

/** Free, keyless US Census geocoder for the subject's coordinates. Throws
 *  on infra failure; returns null when the address genuinely doesn't match
 *  (caller then falls back to the vendor path — no coordinates, no window). */
export async function censusGeocode(
  address: string,
  city: string,
  state: string,
  zip: string,
): Promise<{ lat: number; lng: number } | null> {
  const p = new URLSearchParams({
    address: `${address}, ${city}, ${state} ${zip}`,
    benchmark: "Public_AR_Current",
    format: "json",
  });
  const data = await fetchJson(
    `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?${p.toString()}`,
  );
  const matches = (data.result as { addressMatches?: Array<{ coordinates?: { x?: number; y?: number } }> })
    ?.addressMatches;
  const c = matches?.[0]?.coordinates;
  if (typeof c?.x === "number" && typeof c?.y === "number") return { lat: c.y, lng: c.x };
  return null;
}

/** Sold comps from the county ledger. Throws on infrastructure failure
 *  (caller falls back to vendor); [] is an HONEST zero. maxAgeDays widens
 *  the pull; the ARV filter still applies its own window downstream. */
export async function getCountyDeedComps(
  input: { address: string; city: string; state: string; zip: string },
  source: CountyDeedSource,
  maxAgeDays: number = 400,
): Promise<RentCastSaleComp[]> {
  const geo = await censusGeocode(input.address, input.city, input.state, input.zip);
  if (!geo) throw new Error("county-deeds: subject not geocodable — vendor fallback");

  const since = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString().slice(0, 10);
  const where =
    `${source.salesWhere} AND sale_date >= DATE '${since}'` +
    ` AND latitude >= ${geo.lat - PULL_LAT_DEG} AND latitude <= ${geo.lat + PULL_LAT_DEG}` +
    ` AND longitude >= ${geo.lng - PULL_LNG_DEG} AND longitude <= ${geo.lng + PULL_LNG_DEG}`;
  const sp = new URLSearchParams({
    where,
    outFields: "parcel_id,address,sale_date,amt_sale_price,latitude,longitude,zip_code",
    orderByFields: "sale_date DESC",
    resultRecordCount: "500",
    f: "json",
  });
  const salesData = await fetchJson(`${source.salesUrl}?${sp.toString()}`);
  if (salesData.error) throw new Error(`county-deeds sales query: ${JSON.stringify(salesData.error).slice(0, 200)}`);
  const rows: DeedSaleRow[] = ((salesData.features as Array<{ attributes: DeedSaleRow }>) ?? []).map(
    (f) => f.attributes,
  );

  // Parcel join for building sqft (batched IN clause; deed ledgers carry no
  // structure data). A join failure degrades to sqft-null comps rather than
  // failing the pull — the band math simply can't use sqft-less rows and the
  // receipts still show the sales.
  const parcelsById = new Map<string, ParcelRow>();
  const ids = [...new Set(rows.map((r) => r.parcel_id).filter((x): x is string => Boolean(x)))];
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const pp = new URLSearchParams({
      where: `parcel_id IN (${batch.map((id) => `'${id.replace(/'/g, "''")}'`).join(",")})`,
      outFields: "parcel_id,total_floor_area,year_built",
      resultRecordCount: "200",
      f: "json",
    });
    try {
      const pd = await fetchJson(`${source.parcelsUrl}?${pp.toString()}`);
      for (const f of (pd.features as Array<{ attributes: ParcelRow }>) ?? []) {
        if (f.attributes.parcel_id) parcelsById.set(f.attributes.parcel_id, f.attributes);
      }
    } catch {
      break; // degrade to sqft-null comps; never fail the pull on the join
    }
  }

  const comps: RentCastSaleComp[] = [];
  for (const row of rows) {
    const comp = deedRowToComp(row, parcelsById, geo.lat, geo.lng, source);
    if (comp) comps.push(comp);
  }
  return comps;
}
