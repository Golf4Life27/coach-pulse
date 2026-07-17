// RentCast API helpers — AS-IS valuation + sale comparables.
//
// Existing /api/verify-listing already uses RentCast for active-listing
// confirmation; here we add the AVM endpoints used by /api/arv-validate.

import { auditPaidCall } from "@/lib/spend/audit-paid-call";
import {
  checkLoopBreaker,
  recordCallError,
  recordCallOutcome,
} from "@/lib/rentcast/failure-loop-breaker";

const RENTCAST_API_KEY = process.env.RENTCAST_API_KEY;
const BASE = "https://api.rentcast.io/v1";

/** Breaker-shape inputs — the call's answer-relevant params, used to
 *  group repeated failures of the SAME shape (so a 404 on one address
 *  doesn't trip a sibling call on another). */
export interface PaidFetchBreakerInputs {
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  recordId?: string | null;
}

/** A short-circuit response we return when the loop-breaker is tripped.
 *  Looks like an HTTP 599 to callers (a synthetic status outside the
 *  real range), so error-handling paths fail closed without misreading
 *  it as a real 4xx/5xx — caller logs already match "non-2xx → propagate
 *  an error". The body carries the breaker key for diagnosis. */
function breakerShortCircuitResponse(key: string, lastStatus: number | null): Response {
  return new Response(
    JSON.stringify({
      error: "rentcast_loop_breaker_tripped",
      message:
        "RentCast paid call short-circuited — same call shape failed N times in a row. " +
        "A success on this shape clears the counter; otherwise check the address/recordId or wait for upstream recovery.",
      breaker_key: key,
      last_status: lastStatus,
    }),
    {
      status: 599,
      headers: { "Content-Type": "application/json" },
    },
  );
}

// Wraps a single RentCast fetch call with paid-call telemetry. Emits one
// agent:audit entry per HTTP round-trip on the "rentcast" agent — the
// shape lib/spend/derive.ts and the paid_api_spend_24h Pulse detector
// consume. recordId is optional: present for appraiser-routed calls that
// already know the listing id, absent for zip-level discovery scans.
//
// 2026-06-11 P0: wrapped in lib/rentcast/failure-loop-breaker. Before any
// paid call we check the breaker for THIS call shape; if tripped, return
// a synthetic 599 instead of billing again. Successes clear the counter;
// failures increment it and edge-trigger an alert audit at the trip
// threshold. The */10 bexar-taxes cron (recG4GNM2sa0ZYj7p) burned ~6
// 404s/hr against an unindexed address before this breaker shipped.
async function paidFetch(
  endpoint: string,
  url: string,
  init: RequestInit,
  recordId?: string,
  breakerInputs?: PaidFetchBreakerInputs,
): Promise<Response> {
  const shape = breakerInputs ?? { recordId };
  const pre = await checkLoopBreaker(endpoint, shape);
  if (pre.tripped) {
    // Still emit a paid-call audit row so the spend dashboard sees a
    // breaker-skipped entry (with cost=0). Without this the breaker
    // would invisibly drop calls from the audit trail.
    await auditPaidCall({
      source: "rentcast",
      endpoint,
      http: 599,
      ms: 0,
      recordId,
      error: `loop_breaker_tripped (count=${pre.count}, last_status=${pre.lastStatus})`,
    });
    return breakerShortCircuitResponse(pre.key, pre.lastStatus);
  }

  const t0 = Date.now();
  try {
    const res = await fetch(url, init);
    await auditPaidCall({
      source: "rentcast",
      endpoint,
      http: res.status,
      ms: Date.now() - t0,
      recordId,
      error: res.ok ? undefined : `HTTP ${res.status}`,
    });
    await recordCallOutcome(endpoint, shape, res.status);
    return res;
  } catch (err) {
    await auditPaidCall({
      source: "rentcast",
      endpoint,
      http: -1,
      ms: Date.now() - t0,
      recordId,
      error: String(err),
    });
    await recordCallError(endpoint, shape);
    throw err;
  }
}

export interface RentCastAvmValue {
  price: number | null;
  priceLow: number | null;
  priceHigh: number | null;
  comparables?: unknown;
}

export interface RentCastSaleComp {
  price: number | null;
  squareFootage: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  yearBuilt: number | null;
  distance: number | null;
  daysOnMarket: number | null;
  removedDate: string | null;
  saleDate: string | null;
  // Carried so the Appraiser ARV panel can render the address per comp
  // (provenance law — operator must be able to verify any comp in one
  // click). Optional because legacy persisted JSON predates the field.
  formattedAddress?: string | null;
}

interface AvmInput {
  address: string;
  city: string;
  state: string;
  zip: string;
  bedrooms?: number | null;
  bathrooms?: number | null;
  squareFootage?: number | null;
}

/** Optional comp-pull widening for /avm/value. These are query params on the
 *  SAME single request — RentCast bills per call (flat), not per comp, so
 *  widening returns more raw comps at zero extra cost. Used by the national
 *  crawler's ZIP auto-seed to gather enough clean sales in thin markets;
 *  omitted everywhere else (today's default RentCast behavior). */
export interface CompPullWiden {
  /** Number of comparables to request (RentCast caps ~25). */
  compCount?: number;
  /** Search radius in miles. */
  maxRadius?: number;
  /** Max comp age in days (relax recency). */
  daysOld?: number;
}

function buildAvmParams(input: AvmInput, widen?: CompPullWiden): URLSearchParams {
  const p = new URLSearchParams({
    address: input.address,
    city: input.city,
    state: input.state,
    zipCode: input.zip,
  });
  if (input.bedrooms != null) p.set("bedrooms", String(input.bedrooms));
  if (input.bathrooms != null) p.set("bathrooms", String(input.bathrooms));
  if (input.squareFootage != null) p.set("squareFootage", String(input.squareFootage));
  if (widen?.compCount != null) p.set("compCount", String(widen.compCount));
  if (widen?.maxRadius != null) p.set("maxRadius", String(widen.maxRadius));
  if (widen?.daysOld != null) p.set("daysOld", String(widen.daysOld));
  return p;
}

export async function getAvmValue(
  input: AvmInput,
  recordId?: string,
): Promise<RentCastAvmValue | null> {
  if (!RENTCAST_API_KEY) {
    throw new Error("RENTCAST_API_KEY not set");
  }
  const url = `${BASE}/avm/value?${buildAvmParams(input).toString()}`;
  const res = await paidFetch(
    "avm/value",
    url,
    { headers: { "X-Api-Key": RENTCAST_API_KEY }, cache: "no-store" },
    recordId,
    { address: input.address, city: input.city, state: input.state, zip: input.zip, recordId: recordId ?? null },
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`RentCast avm/value ${res.status}: ${errText}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  return {
    price: (data.price as number) ?? null,
    priceLow: (data.priceRangeLow as number) ?? null,
    priceHigh: (data.priceRangeHigh as number) ?? null,
    comparables: data.comparables,
  };
}

// RentCast doesn't publish a standalone /avm/sale-comparables endpoint;
// comparables are embedded in the /avm/value response. Earlier code hit
// /avm/sale-comparables which 404'd, and silently coerced the 404 to []
// — exactly the swallowed-error pattern the Positive Confirmation
// Principle (Rule 5) forbids. Now we call /avm/value, throw on non-2xx
// (caller surfaces to UI/audit), and let a zero-length comparables list
// be visible as a yellow flag, not invisible success.
export async function getSaleComparables(
  input: AvmInput,
  recordId?: string,
  widen?: CompPullWiden,
): Promise<RentCastSaleComp[]> {
  if (!RENTCAST_API_KEY) {
    throw new Error("RENTCAST_API_KEY not set");
  }
  const url = `${BASE}/avm/value?${buildAvmParams(input, widen).toString()}`;
  const res = await paidFetch(
    "avm/value",
    url,
    { headers: { "X-Api-Key": RENTCAST_API_KEY }, cache: "no-store" },
    recordId,
    { address: input.address, city: input.city, state: input.state, zip: input.zip, recordId: recordId ?? null },
  );

  const bodyText = await res.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    throw new Error(
      `RentCast avm/value ${res.status}: non-JSON body (${bodyText.slice(0, 200)})`,
    );
  }

  if (!res.ok) {
    // 404 == "property not found in RentCast index" — a real signal, not
    // success. Propagate so caller can surface it.
    throw new Error(
      `RentCast avm/value ${res.status}: ${JSON.stringify(data)}`,
    );
  }

  const raw = Array.isArray(data.comparables)
    ? (data.comparables as Array<Record<string, unknown>>)
    : [];
  return raw.map((c) => ({
    price: (c.price as number) ?? null,
    squareFootage: (c.squareFootage as number) ?? null,
    bedrooms: (c.bedrooms as number) ?? null,
    bathrooms: (c.bathrooms as number) ?? null,
    yearBuilt: (c.yearBuilt as number) ?? null,
    distance: (c.distance as number) ?? null,
    daysOnMarket: (c.daysOnMarket as number) ?? null,
    removedDate: (c.removedDate as string) ?? null,
    // HONEST DATES ONLY (2026-07-17, the 1122 West Ave contamination): a
    // comp's saleDate is a real sale date, or the removedDate (the listing
    // actually left the market — a historical event), or NULL. The old
    // lastSeenDate fallback stamped ACTIVE listings with "the crawler saw
    // this ad today" and every active ask masqueraded as a same-day sale —
    // three asking prices (one of them the SUBJECT itself) averaged into a
    // $244,690 "ARV". null saleDate now MEANS active listing, and the ARV
    // filter excludes it from the value basis.
    saleDate:
      (c.saleDate as string) ??
      (c.removedDate as string) ??
      null,
    formattedAddress:
      (c.formattedAddress as string) ??
      buildFallbackAddress(c) ??
      null,
  }));
}

// RentCast normally returns formattedAddress on every comparable, but a
// few records (older indexed sales) carry only the component fields.
// Reassemble them so the comp row is never address-less in the UI.
function buildFallbackAddress(c: Record<string, unknown>): string | null {
  const line = (c.addressLine1 as string) ?? null;
  const city = (c.city as string) ?? null;
  const state = (c.state as string) ?? null;
  const zip = (c.zipCode as string) ?? (c.zip as string) ?? null;
  if (!line && !city) return null;
  return [line, city, state, zip].filter(Boolean).join(", ");
}

// RentCast rent AVM. Returns the monthly rent estimate + range. Used by
// Phase 4C landlord-track math. Principle-compliant: throws on non-2xx
// (callers must surface to audit + UI). Empty/null results are valid
// signals — caller decides how to handle (e.g., flag deal as no-rent-data
// rather than silently zero out the landlord track).
export interface RentCastRentEstimate {
  rent: number | null;
  rentLow: number | null;
  rentHigh: number | null;
  raw: unknown;
}

export async function getRentEstimate(
  input: AvmInput,
  recordId?: string,
): Promise<RentCastRentEstimate> {
  if (!RENTCAST_API_KEY) {
    throw new Error("RENTCAST_API_KEY not set");
  }
  const url = `${BASE}/avm/rent/long-term?${buildAvmParams(input).toString()}`;
  const res = await paidFetch(
    "avm/rent/long-term",
    url,
    { headers: { "X-Api-Key": RENTCAST_API_KEY }, cache: "no-store" },
    recordId,
    { address: input.address, city: input.city, state: input.state, zip: input.zip, recordId: recordId ?? null },
  );

  const bodyText = await res.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    throw new Error(
      `RentCast avm/rent/long-term ${res.status}: non-JSON body (${bodyText.slice(0, 200)})`,
    );
  }

  if (!res.ok) {
    throw new Error(
      `RentCast avm/rent/long-term ${res.status}: ${JSON.stringify(data)}`,
    );
  }

  return {
    rent: (data.rent as number) ?? null,
    rentLow: (data.rentRangeLow as number) ?? null,
    rentHigh: (data.rentRangeHigh as number) ?? null,
    raw: data,
  };
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface SubjectFacts {
  squareFootage: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  yearBuilt: number | null;
  /** which RentCast endpoint actually returned the facts. */
  source: "listings_sale" | "properties" | null;
}

/**
 * Fetch the subject property's own structural facts (square footage etc.)
 * for the Building_SqFt backfill. Tries the active sale-listing endpoint
 * first (`/listings/sale` — same endpoint verify-listing uses, so an
 * active record almost always resolves here), then falls back to the
 * `/properties` record endpoint for off-market subjects.
 *
 * Returns nulls + source:null when neither endpoint resolves. Never
 * throws — the caller (a backfill loop) isolates per-record failures.
 */
/** Pure: pull the most-recent annual property-tax total from a RentCast
 *  property record. RentCast returns `propertyTaxes` keyed by year:
 *  `{ "2023": { year: 2023, total: 4200 }, ... }`. We take the highest
 *  year's `total`. Returns null when absent (→ caller HOLDs). */
export function extractAnnualTaxes(rec: Record<string, unknown> | undefined): number | null {
  if (!rec) return null;
  const pt = rec.propertyTaxes as Record<string, unknown> | undefined;
  if (!pt || typeof pt !== "object") return null;
  let bestYear = -Infinity;
  let bestTotal: number | null = null;
  for (const [year, v] of Object.entries(pt)) {
    const yr = Number(year);
    const total = (v as Record<string, unknown> | null)?.total;
    if (Number.isFinite(yr) && typeof total === "number" && Number.isFinite(total) && total > 0 && yr > bestYear) {
      bestYear = yr;
      bestTotal = total;
    }
  }
  return bestTotal;
}

/** Pure: pull the most-recent year's CAD assessed value from a RentCast
 *  property record. RentCast returns `taxAssessments` keyed by year:
 *  `{ "2023": { year: 2023, value: 165000, ... }, ... }`. Highest year's
 *  `value`. The assessed value is CAD-sourced; multiplied by a published
 *  county effective tax rate it gives a much more reliable annual-tax
 *  estimate than RentCast's `propertyTaxes` (which on Bexar records is
 *  county-only and understates the true combined load). Returns null
 *  when absent. */
export function extractAssessedValue(rec: Record<string, unknown> | undefined): number | null {
  if (!rec) return null;
  const ta = rec.taxAssessments as Record<string, unknown> | undefined;
  if (!ta || typeof ta !== "object") return null;
  let bestYear = -Infinity;
  let bestValue: number | null = null;
  for (const [year, v] of Object.entries(ta)) {
    const yr = Number(year);
    const value = (v as Record<string, unknown> | null)?.value;
    if (Number.isFinite(yr) && typeof value === "number" && Number.isFinite(value) && value > 0 && yr > bestYear) {
      bestYear = yr;
      bestValue = value;
    }
  }
  return bestValue;
}

/**
 * Fetch the subject's most-recent CAD assessed value from RentCast
 * `/properties`. Never throws — returns null on any failure.
 */
export async function getRentCastAssessedValue(
  input: { address: string; city: string; state: string; zip: string },
  recordId?: string,
): Promise<number | null> {
  if (!RENTCAST_API_KEY) return null;
  const qp = new URLSearchParams({
    address: input.address,
    city: input.city,
    state: input.state,
    zipCode: input.zip,
  });
  try {
    const res = await paidFetch(
      "properties",
      `${BASE}/properties?${qp.toString()}`,
      { headers: { "X-Api-Key": RENTCAST_API_KEY }, cache: "no-store" },
      recordId,
      { ...input, recordId: recordId ?? null },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    const rec = Array.isArray(body) ? (body[0] as Record<string, unknown> | undefined) : undefined;
    return extractAssessedValue(rec);
  } catch {
    return null;
  }
}

/**
 * Fetch the subject's most-recent annual property taxes from RentCast
 * `/properties`. Never throws — returns null on any failure (caller
 * HOLDs rather than fabricating a tax number).
 */
export async function getAnnualPropertyTaxes(
  input: { address: string; city: string; state: string; zip: string },
  recordId?: string,
): Promise<number | null> {
  if (!RENTCAST_API_KEY) return null;
  const qp = new URLSearchParams({
    address: input.address,
    city: input.city,
    state: input.state,
    zipCode: input.zip,
  });
  try {
    const res = await paidFetch(
      "properties",
      `${BASE}/properties?${qp.toString()}`,
      { headers: { "X-Api-Key": RENTCAST_API_KEY }, cache: "no-store" },
      recordId,
      { ...input, recordId: recordId ?? null },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    const rec = Array.isArray(body) ? (body[0] as Record<string, unknown> | undefined) : undefined;
    return extractAnnualTaxes(rec);
  } catch {
    return null;
  }
}

export async function getSubjectFacts(input: {
  address: string;
  city: string;
  state: string;
  zip: string;
}): Promise<SubjectFacts> {
  const empty: SubjectFacts = {
    squareFootage: null,
    bedrooms: null,
    bathrooms: null,
    yearBuilt: null,
    source: null,
  };
  if (!RENTCAST_API_KEY) return empty;

  const qp = new URLSearchParams({
    address: input.address,
    city: input.city,
    state: input.state,
    zipCode: input.zip,
  });

  // 1. Active sale listing (covers the active cluster).
  try {
    const res = await paidFetch(
      "listings/sale",
      `${BASE}/listings/sale?${qp.toString()}&status=active`,
      { headers: { "X-Api-Key": RENTCAST_API_KEY }, cache: "no-store" },
    );
    if (res.ok) {
      const body = (await res.json()) as unknown;
      const rec = Array.isArray(body) ? (body[0] as Record<string, unknown> | undefined) : undefined;
      const facts = extractFacts(rec);
      if (facts.squareFootage != null) return { ...facts, source: "listings_sale" };
    }
  } catch {
    // fall through to /properties
  }

  // 2. Property record (off-market / inactive subjects).
  try {
    const res = await paidFetch(
      "properties",
      `${BASE}/properties?${qp.toString()}`,
      { headers: { "X-Api-Key": RENTCAST_API_KEY }, cache: "no-store" },
    );
    if (res.ok) {
      const body = (await res.json()) as unknown;
      const rec = Array.isArray(body) ? (body[0] as Record<string, unknown> | undefined) : undefined;
      const facts = extractFacts(rec);
      if (facts.squareFootage != null) return { ...facts, source: "properties" };
    }
  } catch {
    // fall through to empty
  }

  return empty;
}

/**
 * Probe + extract listing photo URLs from RentCast. Tries the active
 * sale-listing endpoint first (the listing payload is most likely to
 * carry portal-uploaded photos), then falls back to the property record.
 *
 * Returns a structured result so callers can see WHICH endpoint
 * responded, what HTTP status it returned, how many photos came back,
 * and (in debug mode) which top-level keys looked photo-shaped. The
 * caller decides how to use it — collectPhotos uses .photos directly;
 * the appraiser-readiness probe surfaces the full breakdown.
 *
 * Never throws — caller-side photo collection is "best-effort, fall
 * through on failure" by design.
 */
export interface RentCastPhotoResult {
  keyPresent: boolean;
  photos: string[];
  listingsSaleStatus: number | null;
  listingsSalePhotoCount: number | null;
  propertiesStatus: number | null;
  propertiesPhotoCount: number | null;
  source: "listings_sale" | "properties" | null;
  /** Top-level keys on the FIRST record that contain "photo"/"image"/
   *  "media" — investigation aid. Populated only when debug=true. */
  photoFieldKeys: string[];
  error: string | null;
}

/** Pure: pull a photo-URL array off a RentCast record. RentCast docs
 *  don't lock the field name; we look at the obvious candidates and
 *  unwrap nested {url} / {originalUrl} shapes. Empty array when nothing
 *  photo-shaped is present. */
export function extractPhotoUrls(rec: Record<string, unknown> | undefined): string[] {
  if (!rec) return [];
  const candidates: unknown[] = [];
  for (const key of ["photos", "images", "media", "photoUrls", "imageUrls"]) {
    const v = rec[key];
    if (Array.isArray(v)) candidates.push(...v);
  }
  const urls: string[] = [];
  for (const c of candidates) {
    if (typeof c === "string" && /^https?:\/\//.test(c)) urls.push(c);
    else if (c && typeof c === "object") {
      const obj = c as Record<string, unknown>;
      for (const k of ["url", "originalUrl", "src", "href"]) {
        const v = obj[k];
        if (typeof v === "string" && /^https?:\/\//.test(v)) {
          urls.push(v);
          break;
        }
      }
    }
  }
  return Array.from(new Set(urls));
}

/** Pure: top-level keys on a record whose name suggests photos/images/
 *  media — investigation aid for the probe. */
export function findPhotoFieldKeys(rec: Record<string, unknown> | undefined): string[] {
  if (!rec) return [];
  return Object.keys(rec).filter((k) => /photo|image|media/i.test(k));
}

export async function getListingPhotosFromRentCast(
  input: { address: string; city: string; state: string; zip: string },
  opts: { debug?: boolean } = {},
): Promise<RentCastPhotoResult> {
  const empty: RentCastPhotoResult = {
    keyPresent: Boolean(RENTCAST_API_KEY),
    photos: [],
    listingsSaleStatus: null,
    listingsSalePhotoCount: null,
    propertiesStatus: null,
    propertiesPhotoCount: null,
    source: null,
    photoFieldKeys: [],
    error: null,
  };
  if (!RENTCAST_API_KEY) {
    return { ...empty, error: "RENTCAST_API_KEY not set" };
  }

  const qp = new URLSearchParams({
    address: input.address,
    city: input.city,
    state: input.state,
    zipCode: input.zip,
  });

  const debugKeys: string[] = [];

  // 1. Active sale listing.
  try {
    const res = await paidFetch(
      "listings/sale",
      `${BASE}/listings/sale?${qp.toString()}&status=active`,
      { headers: { "X-Api-Key": RENTCAST_API_KEY }, cache: "no-store" },
    );
    empty.listingsSaleStatus = res.status;
    if (res.ok) {
      const body = (await res.json()) as unknown;
      const rec = Array.isArray(body) ? (body[0] as Record<string, unknown> | undefined) : undefined;
      const urls = extractPhotoUrls(rec);
      empty.listingsSalePhotoCount = urls.length;
      if (opts.debug) debugKeys.push(...findPhotoFieldKeys(rec).map((k) => `listings_sale.${k}`));
      if (urls.length > 0) {
        return { ...empty, photos: urls, source: "listings_sale", photoFieldKeys: debugKeys };
      }
    }
  } catch (err) {
    empty.error = String(err).slice(0, 200);
  }

  // 2. Property record.
  try {
    const res = await paidFetch(
      "properties",
      `${BASE}/properties?${qp.toString()}`,
      { headers: { "X-Api-Key": RENTCAST_API_KEY }, cache: "no-store" },
    );
    empty.propertiesStatus = res.status;
    if (res.ok) {
      const body = (await res.json()) as unknown;
      const rec = Array.isArray(body) ? (body[0] as Record<string, unknown> | undefined) : undefined;
      const urls = extractPhotoUrls(rec);
      empty.propertiesPhotoCount = urls.length;
      if (opts.debug) debugKeys.push(...findPhotoFieldKeys(rec).map((k) => `properties.${k}`));
      if (urls.length > 0) {
        return { ...empty, photos: urls, source: "properties", photoFieldKeys: debugKeys };
      }
    }
  } catch (err) {
    empty.error = (empty.error ?? "") + " | " + String(err).slice(0, 200);
  }

  return { ...empty, photoFieldKeys: debugKeys };
}

/** Pure: pull structural facts off a RentCast property/listing record. */
export function extractFacts(rec: Record<string, unknown> | undefined): Omit<SubjectFacts, "source"> {
  if (!rec) return { squareFootage: null, bedrooms: null, bathrooms: null, yearBuilt: null };
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
  return {
    squareFootage: num(rec.squareFootage),
    bedrooms: num(rec.bedrooms),
    bathrooms: num(rec.bathrooms),
    yearBuilt: num(rec.yearBuilt),
  };
}
