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
import {
  checkSpendCeiling,
  noteInvocationCall,
  recordKvSpend,
  type CeilingVerdict,
} from "@/lib/rentcast/spend-ceiling";
import { audit } from "@/lib/audit-log";

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
/** Spend-ceiling refusal. A DISTINCT synthetic status (598) from the loop
 *  breaker's 599 so "we stopped spending" is never misdiagnosed as "this
 *  call shape keeps failing" — they have opposite remedies. Non-2xx either
 *  way, so every existing caller fails closed without a change. */
function ceilingShortCircuitResponse(verdict: CeilingVerdict): Response {
  return new Response(
    JSON.stringify({
      error: "rentcast_spend_ceiling_reached",
      message: verdict.reason,
      blocked_by: verdict.blockedBy,
      spent: verdict.spent,
      caps: verdict.caps,
    }),
    { status: 598, headers: { "Content-Type": "application/json" } },
  );
}

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
/** THE RentCast HTTP choke point (exported 2026-07-29, Consolidation
 *  Night item B). Every RentCast HTTP call in the codebase must pass
 *  through this function — it is the only path that (1) emits the
 *  paid_api_call audit row the spend meters/dashboards read, and (2)
 *  consults the failure loop-breaker. lib/crawler/sources/rentcast.ts
 *  previously used a raw fetch(), which made ~40% of real RentCast spend
 *  invisible to every meter (audit showed 135/day while the vendor billed
 *  ~231/day). DO NOT add a new RentCast fetch outside this function. */
export async function rentcastPaidFetch(
  endpoint: string,
  url: string,
  init: RequestInit,
  recordId?: string,
  breakerInputs?: PaidFetchBreakerInputs,
  honestEmptyStatuses?: number[],
): Promise<Response> {
  return paidFetch(endpoint, url, init, recordId, breakerInputs, honestEmptyStatuses);
}

async function paidFetch(
  endpoint: string,
  url: string,
  init: RequestInit,
  recordId?: string,
  breakerInputs?: PaidFetchBreakerInputs,
  // HTTP statuses that are an honest "no record" answer for THIS call
  // (RentCast 404 on /properties, /properties/subject, /listings/sale —
  // see #135) rather than an infrastructure failure. When the response
  // matches, the audit records confirmed_success and the breaker does not
  // count it — a stable "not indexed" answer must not trip the loop
  // breaker and block every other address.
  honestEmptyStatuses?: number[],
): Promise<Response> {
  // ── SPEND CEILING (2026-07-31) ────────────────────────────────────
  // Checked FIRST: a call we refuse on cost must not even consult the
  // loop breaker, and must never reach fetch(). See the June reconstruction
  // in lib/rentcast/spend-ceiling.ts — four $250 overage auto-charges in one
  // month, ~18,750 requests, with no ceiling on any of ~20 call sites.
  const ceiling = await checkSpendCeiling();
  if (!ceiling.allowed) {
    // Emit the paid-call row (cost 0) so a refused call is VISIBLE to the
    // spend dashboard — same reasoning as the loop-breaker row below. A
    // ceiling that silently drops work is its own incident.
    await auditPaidCall({
      source: "rentcast",
      endpoint,
      http: 598,
      ms: 0,
      recordId,
      error: `spend_ceiling_${ceiling.blockedBy} (lane=${ceiling.lane}, invocation=${ceiling.spent.invocation}, day=${ceiling.spent.day}/${ceiling.laneDayCap}, month=${ceiling.spent.month})`,
    });
    await audit({
      agent: "sentry",
      event: "rentcast_spend_ceiling_reached",
      status: "confirmed_success",
      decision: ceiling.reason ?? "refused",
      recordId,
      outputSummary: {
        endpoint,
        blocked_by: ceiling.blockedBy,
        lane: ceiling.lane,
        lane_day_cap: ceiling.laneDayCap,
        spent: ceiling.spent,
        caps: ceiling.caps,
      },
    }).catch(() => {});
    return ceilingShortCircuitResponse(ceiling);
  }
  if (!ceiling.kvAvailable) {
    // Fail-OPEN half of the posture (matches the Firecrawl breaker doctrine):
    // the distributed meter is blind, so only the in-memory per-invocation cap
    // is holding. Never silent — "the ceiling was degraded" must be a fact
    // someone can find afterwards.
    await audit({
      agent: "sentry",
      event: "rentcast_spend_ceiling_degraded",
      status: "uncertain",
      decision: "KV unavailable — day/month windows blind; per-invocation cap still enforced",
      recordId,
      outputSummary: { endpoint, invocation_spent: ceiling.spent.invocation, invocation_cap: ceiling.caps.invocation },
    }).catch(() => {});
  }

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

  // Count the call BEFORE dispatching. The vendor bills on the request, not
  // the response — a call that throws still cost money, so a post-hoc
  // increment would undercount exactly during an outage-driven runaway.
  // (The loop-breaker short-circuit above returns before this point and is
  // correctly NOT counted: it never reached the wire.)
  // AWAITED, not fire-and-forget: a detached write can be aborted when the
  // lambda freezes (the failure mode the Positive Confirmation Principle
  // forbids), and worse, an un-awaited increment lets a tight loop fire
  // hundreds of calls before the first write lands — defeating the very cap
  // it feeds. Two KV round-trips against a ~228ms vendor call is a fair
  // price for a meter that is actually true.
  noteInvocationCall();
  await recordKvSpend();

  const t0 = Date.now();
  try {
    const res = await fetch(url, init);
    const honestEmpty = !res.ok && (honestEmptyStatuses?.includes(res.status) ?? false);
    await auditPaidCall({
      source: "rentcast",
      endpoint,
      http: res.status,
      ms: Date.now() - t0,
      recordId,
      error: res.ok || honestEmpty ? undefined : `HTTP ${res.status}`,
      forceSuccess: honestEmpty ? true : undefined,
    });
    await recordCallOutcome(endpoint, shape, honestEmpty ? 200 : res.status);
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

// ── Recorded-sale comps from PROPERTY RECORDS (rebuilt 2026-07-18) ───────
//
// THE DISCOVERY: /avm/value "comparables" are LISTING records — asking
// prices in various lifecycle states (active / delisted / relisted). They
// carry NO recorded-sale field at all. Every prior "sold comp" this system
// displayed was an ask wearing a fabricated or borrowed date: lastSeenDate
// (the $244,690 1122 West fiction), then removedDate (the $294,602
// Fortress delisted-ask). When #130 demanded recorded sales only, the AVM
// feed honestly returned zero across the entire fleet — 25/25 re-runs
// empty. The feed was the lie, not the filter.
//
// THE REBUILD: comps now come from RentCast PROPERTY records (public-record
// deed data: lastSalePrice / lastSaleDate, plus the per-property history
// map). Two paid calls per pull: (1) subject lookup for coordinates,
// (2) radius query for nearby parcels. Only parcels with a recorded sale
// map to comps — price IS the recorded sale price, saleDate IS the deed
// date. Parcels with no sale history are parcels, not refused comps.
// Same signature, same return type: every caller (appraiser, pricing,
// seeds, gates, validation) migrates at once and none can ever price off
// a listing ask again.

const EARTH_RADIUS_MILES = 3958.8;

/** Pure: great-circle distance in miles. */
export function haversineMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Pure: newest recorded Sale event from a property record. Prefers the
 *  top-level lastSalePrice/lastSaleDate; falls back to scanning the
 *  history map for Sale events (some records carry only history). Null
 *  when the parcel has no recorded sale — it is not a comp. */
export function newestRecordedSale(
  rec: Record<string, unknown>,
): { price: number; date: string } | null {
  const topPrice = rec.lastSalePrice as number | undefined;
  const topDate = rec.lastSaleDate as string | undefined;
  let best: { price: number; date: string } | null =
    typeof topPrice === "number" && topPrice > 0 && typeof topDate === "string" && topDate
      ? { price: topPrice, date: topDate }
      : null;
  const history = rec.history as Record<string, Record<string, unknown>> | undefined;
  if (history && typeof history === "object") {
    for (const ev of Object.values(history)) {
      if (!ev || typeof ev !== "object") continue;
      if ((ev.event as string)?.toLowerCase() !== "sale") continue;
      const price = ev.price as number | undefined;
      const date = (ev.date as string) ?? null;
      if (typeof price !== "number" || price <= 0 || !date) continue;
      if (!best || date > best.date) best = { price, date };
    }
  }
  return best;
}

/** Pure: map one property record to a comp — or null when it carries no
 *  recorded sale. Distance from subject coordinates when both known. */
export function mapPropertyRecordToComp(
  rec: Record<string, unknown>,
  subjectLat: number | null,
  subjectLng: number | null,
): RentCastSaleComp | null {
  const sale = newestRecordedSale(rec);
  if (!sale) return null;
  const lat = rec.latitude as number | undefined;
  const lng = rec.longitude as number | undefined;
  const distance =
    subjectLat != null && subjectLng != null && typeof lat === "number" && typeof lng === "number"
      ? Number(haversineMiles(subjectLat, subjectLng, lat, lng).toFixed(4))
      : null;
  return {
    price: sale.price,
    squareFootage: (rec.squareFootage as number) ?? null,
    bedrooms: (rec.bedrooms as number) ?? null,
    bathrooms: (rec.bathrooms as number) ?? null,
    yearBuilt: (rec.yearBuilt as number) ?? null,
    distance,
    daysOnMarket: null,
    removedDate: null,
    saleDate: sale.date,
    formattedAddress:
      (rec.formattedAddress as string) ??
      buildFallbackAddress(rec) ??
      null,
  };
}

function parsePropertiesBody(status: number, bodyText: string): Array<Record<string, unknown>> {
  let data: unknown;
  try {
    data = JSON.parse(bodyText);
  } catch {
    throw new Error(`RentCast properties ${status}: non-JSON body (${bodyText.slice(0, 200)})`);
  }
  if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.properties)) return obj.properties as Array<Record<string, unknown>>;
    if (Array.isArray(obj.data)) return obj.data as Array<Record<string, unknown>>;
    // A single-record response (address-exact lookup) arrives as one object.
    if (obj.id != null || obj.formattedAddress != null) return [obj];
  }
  return [];
}

/** Recorded-sale comps for a subject. Two paid calls: subject lookup
 *  (coordinates) + radius pull (nearby parcels). Falls back to a ZIP-wide
 *  pull (distance unknown) when the subject isn't in RentCast's parcel
 *  index. Throws on non-2xx so callers surface failures (Positive
 *  Confirmation Principle) — an empty array means "no parcels with
 *  recorded sales", visibly, never a swallowed error. */
export async function getSaleComparables(
  input: AvmInput,
  recordId?: string,
  widen?: CompPullWiden,
): Promise<RentCastSaleComp[]> {
  if (!RENTCAST_API_KEY) {
    throw new Error("RENTCAST_API_KEY not set");
  }
  const headers = { headers: { "X-Api-Key": RENTCAST_API_KEY }, cache: "no-store" as const };
  const shape = { address: input.address, city: input.city, state: input.state, zip: input.zip, recordId: recordId ?? null };

  // 1 — subject parcel (coordinates). A miss is survivable: ZIP fallback.
  let subjectLat: number | null = null;
  let subjectLng: number | null = null;
  const subjParams = new URLSearchParams({
    address: `${input.address}, ${input.city}, ${input.state}, ${input.zip}`,
  });
  const subjRes = await paidFetch(
    "properties/subject",
    `${BASE}/properties?${subjParams.toString()}`,
    headers,
    recordId,
    shape,
    // HONEST-404 (#135 pattern, completed 2026-07-28): "no parcel at this
    // address" is an answer, not an infra failure — without this, every 404
    // here audited paid_api_call confirmed_failure AND struck the loop
    // breaker (twice per invocation with the comps call below — the exact
    // pairs-every-5-min pattern behind the 54% Pulse alarm). The 825d455
    // reliability wave applied this to all three sibling functions and
    // missed this one, the hot-path ARV comp pull.
    [404],
  );
  const subjBody = await subjRes.text();
  if (subjRes.ok) {
    const subj = parsePropertiesBody(subjRes.status, subjBody)[0];
    if (subj && typeof subj.latitude === "number" && typeof subj.longitude === "number") {
      subjectLat = subj.latitude;
      subjectLng = subj.longitude;
    }
  }

  // 2 — nearby parcels. Radius when we have coordinates; ZIP-wide otherwise.
  const radius = widen?.maxRadius ?? 0.6; // filters clip at max_distance_miles
  const limit = widen?.compCount != null ? 200 : 100;
  const compParams =
    subjectLat != null && subjectLng != null
      ? new URLSearchParams({
          latitude: String(subjectLat),
          longitude: String(subjectLng),
          radius: String(radius),
          limit: String(limit),
          propertyType: "Single Family",
        })
      : new URLSearchParams({
          zipCode: input.zip,
          limit: String(limit),
          propertyType: "Single Family",
        });
  const compRes = await paidFetch(
    "properties/comps",
    `${BASE}/properties?${compParams.toString()}`,
    headers,
    recordId,
    shape,
    // HONEST-404: same treatment as the subject call above — the explicit
    // `compRes.status === 404 → return []` below already returns the honest
    // zero; this arg makes the AUDIT and BREAKER agree with it.
    [404],
  );
  const compBody = await compRes.text();
  if (compRes.status === 404) {
    // RentCast 404s on NO-RESULTS for property lookups — that is an honest
    // "zero parcels here", not an infrastructure failure. Return empty so
    // the ARV lands honest-empty with receipts instead of erroring the leg
    // (and feeding the loop-breaker / failure-rate alarms with non-failures).
    return [];
  }
  if (!compRes.ok) {
    throw new Error(`RentCast properties ${compRes.status}: ${compBody.slice(0, 300)}`);
  }
  const records = parsePropertiesBody(compRes.status, compBody);
  const comps: RentCastSaleComp[] = [];
  for (const rec of records) {
    const comp = mapPropertyRecordToComp(rec, subjectLat, subjectLng);
    if (comp) comps.push(comp);
  }
  return comps;
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

/** Both halves of ONE RentCast `/properties` record. */
export interface RentCastPropertyFacts {
  /** Most-recent year's annual property-tax total. Null when absent. */
  annualTaxes: number | null;
  /** Most-recent year's CAD assessed value. Null when absent. */
  assessedValue: number | null;
}

/**
 * Fetch annual taxes AND assessed value in a SINGLE `/properties` call.
 *
 * WHY THIS EXISTS (2026-07-29 spend audit). getAnnualPropertyTaxes and
 * getRentCastAssessedValue below build byte-identical query strings and hit
 * the identical endpoint — extractAnnualTaxes and extractAssessedValue just
 * read two different keys off the SAME response object. Every caller that
 * wanted both was billed twice for one answer. Three call sites paired them
 * (v21-underwrite-record, stale-deal-triage, resource-bexar-taxes), and the
 * live one runs on the daily V2.1 cron plus every seller-reply re-price.
 *
 * The two single-value functions are kept for callers that genuinely need
 * only one half (e.g. landlord-mao takes taxes alone) — but any caller
 * wanting both MUST use this, or it is paying the duplicate tax again.
 *
 * Never throws — returns nulls on any failure, so the caller HOLDs rather
 * than fabricating an economics input.
 */
export async function getRentCastPropertyFacts(
  input: { address: string; city: string; state: string; zip: string },
  recordId?: string,
): Promise<RentCastPropertyFacts> {
  const empty: RentCastPropertyFacts = { annualTaxes: null, assessedValue: null };
  if (!RENTCAST_API_KEY) return empty;
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
      // HONEST-404: "no parcel at this address" is an answer, not an infra
      // failure — matches getRentCastAssessedValue's existing posture.
      [404],
    );
    if (!res.ok) return empty;
    const body = (await res.json()) as unknown;
    const rec = Array.isArray(body) ? (body[0] as Record<string, unknown> | undefined) : undefined;
    return {
      annualTaxes: extractAnnualTaxes(rec),
      assessedValue: extractAssessedValue(rec),
    };
  } catch {
    return empty;
  }
}

/**
 * Fetch the subject's most-recent CAD assessed value from RentCast
 * `/properties`. Never throws — returns null on any failure.
 *
 * NOTE: if you also need annual taxes, call getRentCastPropertyFacts()
 * instead — pairing this with getAnnualPropertyTaxes bills the same
 * endpoint twice for one answer.
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
      [404],
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

// ── Subject deed print (2026-08-02, the 9360 Cheyenne receipt) ──────────
//
// The subject's own most-recent recorded sale is the strongest as-is value
// evidence there is, and this codebase was ALREADY paying for it: every
// getSaleComparables pull fetches the subject's /properties record — which
// carries lastSalePrice/lastSaleDate from public deed data — and read only
// its coordinates. Cheyenne's February $45,000 sale was in that response on
// intake day and nothing looked; the operator found it on Redfin by hand
// after we had an accepted offer at 94% of it. This helper is the deliberate
// read. Judged by lib/pricing/subject-history.judgeSubjectPrint.

export interface SubjectRecordedSaleResult {
  /** True iff RentCast answered (2xx or honest-404). False = infra failure —
   *  the caller must record "unchecked", never treat it as "no history". */
  checked: boolean;
  /** Newest recorded deed sale, or null when the parcel has none. */
  sale: { price: number; date: string } | null;
  error: string | null;
}

/** One paid /properties call. Honest-404 (no parcel = an answer). Never
 *  throws — infra failures return checked:false so gaps stay visible. */
export async function getSubjectRecordedSale(
  input: { address: string; city: string; state: string; zip: string },
  recordId?: string,
): Promise<SubjectRecordedSaleResult> {
  if (!RENTCAST_API_KEY) return { checked: false, sale: null, error: "RENTCAST_API_KEY not set" };
  const qp = new URLSearchParams({
    address: input.address,
    city: input.city,
    state: input.state,
    zipCode: input.zip,
  });
  try {
    const res = await paidFetch(
      "properties/subject-sale",
      `${BASE}/properties?${qp.toString()}`,
      { headers: { "X-Api-Key": RENTCAST_API_KEY }, cache: "no-store" },
      recordId,
      { ...input, recordId: recordId ?? null },
      [404],
    );
    if (res.status === 404) return { checked: true, sale: null, error: null };
    if (!res.ok) return { checked: false, sale: null, error: `HTTP ${res.status}` };
    const bodyText = await res.text();
    const rec = parsePropertiesBody(res.status, bodyText)[0];
    return { checked: true, sale: rec ? newestRecordedSale(rec) : null, error: null };
  } catch (err) {
    return { checked: false, sale: null, error: String(err).slice(0, 200) };
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
  // Per-address breaker shape — without this every subject collapses onto
  // the same bare "listings/sale|||||" / "properties|||||" global key, so
  // one address's 404s trip the breaker for every property (2026-07-27 P0).
  const shape: PaidFetchBreakerInputs = {
    address: input.address,
    city: input.city,
    state: input.state,
    zip: input.zip,
    recordId: null,
  };

  // 1. Active sale listing (covers the active cluster).
  try {
    const res = await paidFetch(
      "listings/sale",
      `${BASE}/listings/sale?${qp.toString()}&status=active`,
      { headers: { "X-Api-Key": RENTCAST_API_KEY }, cache: "no-store" },
      undefined,
      shape,
      [404],
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
      undefined,
      shape,
      [404],
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
  // Per-address breaker shape — see getSubjectFacts for why this matters
  // (a bare recordId-less key collapses every address onto one global
  // breaker counter).
  const shape: PaidFetchBreakerInputs = {
    address: input.address,
    city: input.city,
    state: input.state,
    zip: input.zip,
    recordId: null,
  };

  const debugKeys: string[] = [];

  // 1. Active sale listing.
  try {
    const res = await paidFetch(
      "listings/sale",
      `${BASE}/listings/sale?${qp.toString()}&status=active`,
      { headers: { "X-Api-Key": RENTCAST_API_KEY }, cache: "no-store" },
      undefined,
      shape,
      [404],
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
      undefined,
      shape,
      [404],
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
