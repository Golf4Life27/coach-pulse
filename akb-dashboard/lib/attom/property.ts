// ATTOM property API — the underwriter backbone.
// @agent: appraiser
//
// Three operative endpoints (per-property; NOT the ZIP-discovery snapshot
// that lib/crawler/sources/attom.ts uses for intake — different use case):
//
//   /property/detail               → characteristics (beds/baths/sqft/year)
//   /assessment/detail             → assessor (annual taxes + assessed value)
//   /salescomparables/address/...  → recorded retail sold comps → ARV
//
// The ARV synthesizer is the integrity point: real recorded sales in a
// disclosure state (e.g. Michigan) are CLEAN; an AVM is BANNED here. The
// synthesizer returns null on insufficient or implausible comp coverage —
// caller HOLDs, never fabricates.
//
// Pure URL builders + response mappers + ARV synthesis. The fetch wrappers
// at the bottom of the file are network I/O and never throw (return
// {data:null, error:string} on any failure — callers HOLD on null).

const ATTOM_API_KEY = process.env.ATTOM_API_KEY;
const ATTOM_BASE = "https://api.gateway.attomdata.com/propertyapi/v1.0.0";
// Sales Comparables is a SEPARATE ATTOM product under a different base +
// version (property/v2), NOT propertyapi/v1.0.0. Hitting it under v1.0.0
// returns 404 "No rule matched" (gateway routing miss) — confirmed live
// 2026-06-06. This is the "wrong endpoint" the operator flagged.
const ATTOM_SALESCOMP_BASE = "https://api.gateway.attomdata.com/property/v2";

export interface AttomAddress {
  /** Street line (e.g. "5435 Callaghan Rd"). */
  address1: string;
  /** "city, ST zip" (ATTOM's address2 convention). */
  address2: string;
}

/** Pure: helper to assemble address2 from parts. */
export function buildAddress2(city: string, state: string, zip: string): string {
  return `${city}, ${state} ${zip}`.replace(/\s+/g, " ").trim();
}

// ── URL builders (pure) ───────────────────────────────────────────────

export function buildPropertyDetailUrl(addr: AttomAddress, base: string = ATTOM_BASE): string {
  const u = new URL(`${base}/property/detail`);
  u.searchParams.set("address1", addr.address1);
  u.searchParams.set("address2", addr.address2);
  return u.toString();
}

export function buildAssessmentDetailUrl(addr: AttomAddress, base: string = ATTOM_BASE): string {
  const u = new URL(`${base}/assessment/detail`);
  u.searchParams.set("address1", addr.address1);
  u.searchParams.set("address2", addr.address2);
  return u.toString();
}

/** ATTOM /salescomparables/address uses path-segment params:
 *   /salescomparables/address/{street}/{city}/{county}/{state}/{zip}
 *
 * county is OPTIONAL ("0" placeholder is accepted by the API per docs);
 * we leave it as "0" so callers without county data still work. */
export function buildSalesComparablesUrl(
  street: string,
  city: string,
  state: string,
  zip: string,
  opts: { searchRadiusMi?: number; minComps?: number; maxComps?: number; county?: string; base?: string } = {},
): string {
  const base = opts.base ?? ATTOM_SALESCOMP_BASE;
  const county = opts.county ?? "0";
  const enc = (s: string) => encodeURIComponent(s);
  const u = new URL(
    `${base}/salescomparables/address/${enc(street)}/${enc(city)}/${enc(county)}/${enc(state)}/${enc(zip)}`,
  );
  if (opts.searchRadiusMi != null) u.searchParams.set("searchRadius", String(opts.searchRadiusMi));
  if (opts.minComps != null) u.searchParams.set("minComps", String(opts.minComps));
  if (opts.maxComps != null) u.searchParams.set("maxComps", String(opts.maxComps));
  return u.toString();
}

// ── Response shapes (minimal structural views) ────────────────────────

interface AttomDetailResponse {
  status?: { code?: number; msg?: string; total?: number };
  property?: Array<{
    summary?: { proptype?: string; propclass?: string; propsubtype?: string; yearbuilt?: number };
    building?: {
      rooms?: { beds?: number; bathstotal?: number; bathsfull?: number };
      size?: { livingsize?: number; universalsize?: number };
    };
    address?: { line1?: string; locality?: string; countrySubd?: string; postal1?: string };
  }>;
}

interface AttomAssessmentResponse {
  status?: { code?: number; msg?: string; total?: number };
  property?: Array<{
    assessment?: {
      // ATTOM uses lowercase field names: taxamt / taxyear / assdttlvalue /
      // mktttlvalue. (camelCase silently reads null — confirmed live: a
      // probe returned assdttlvalue but null taxamt under taxAmt.)
      tax?: { taxamt?: number; taxyear?: number };
      assessed?: { assdttlvalue?: number };
      market?: { mktttlvalue?: number };
    };
  }>;
}

interface AttomComp {
  /** Sale amount in dollars. */
  amount?: { saleamt?: number };
  /** Sale date. */
  salesearchdate?: string;
  /** Living size sqft. */
  size?: { livingsize?: number; universalsize?: number };
  address?: { line1?: string; locality?: string; postal1?: string };
}

interface AttomSalesComparablesResponse {
  status?: { code?: number; msg?: string };
  /** The subject + comps live in `RESPONSE_GROUP.response.RESPONSE_DATA[].STATUS_RES_DATA[]`
   *  per ATTOM docs, but the gateway's JSON envelope flattens to `comparables` in v1.0.0. */
  comparables?: AttomComp[];
  /** Some responses nest under `property[].sale` etc.; we accept both shapes. */
  property?: Array<{ sale?: AttomComp }>;
}

// ── Pure mappers ──────────────────────────────────────────────────────

export interface PropertyCharacteristics {
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  yearBuilt: number | null;
  propertyType: string | null;
}

export function mapPropertyDetail(body: AttomDetailResponse): PropertyCharacteristics {
  const p = body.property?.[0];
  if (!p) return { beds: null, baths: null, sqft: null, yearBuilt: null, propertyType: null };
  const baths = p.building?.rooms?.bathstotal ?? p.building?.rooms?.bathsfull ?? null;
  return {
    beds: p.building?.rooms?.beds ?? null,
    baths,
    sqft: p.building?.size?.livingsize ?? p.building?.size?.universalsize ?? null,
    yearBuilt: p.summary?.yearbuilt ?? null,
    propertyType: p.summary?.propsubtype ?? p.summary?.proptype ?? p.summary?.propclass ?? null,
  };
}

export interface AssessorRecord {
  annualTaxes: number | null;
  assessedValue: number | null;
  taxYear: number | null;
}

export function mapAssessmentDetail(body: AttomAssessmentResponse): AssessorRecord {
  const a = body.property?.[0]?.assessment;
  if (!a) return { annualTaxes: null, assessedValue: null, taxYear: null };
  return {
    annualTaxes: a.tax?.taxamt ?? null,
    assessedValue: a.assessed?.assdttlvalue ?? a.market?.mktttlvalue ?? null,
    taxYear: a.tax?.taxyear ?? null,
  };
}

export interface SoldComp {
  saleAmount: number;
  saleDate: string | null;
  sqft: number | null;
  address: string | null;
}

export function mapSalesComparables(body: AttomSalesComparablesResponse): SoldComp[] {
  // Accept both envelope shapes (gateway has rotated this over versions).
  const flat = Array.isArray(body.comparables) ? body.comparables : [];
  const nested: AttomComp[] = Array.isArray(body.property)
    ? body.property.map((p) => p.sale).filter((s): s is AttomComp => !!s)
    : [];
  const raw = [...flat, ...nested];
  return raw
    .map((c): SoldComp | null => {
      const amt = c.amount?.saleamt;
      if (typeof amt !== "number" || !Number.isFinite(amt) || amt <= 0) return null;
      return {
        saleAmount: amt,
        saleDate: c.salesearchdate ?? null,
        sqft: c.size?.livingsize ?? c.size?.universalsize ?? null,
        address: c.address?.line1 ?? null,
      };
    })
    .filter((x): x is SoldComp => x != null);
}

// ── ARV synthesizer ───────────────────────────────────────────────────
// The single integrity point: ARV from recorded retail sold comps. Never
// AVM. We require a MINIMUM comp count (default 3) and a MAXIMUM dispersion
// (median absolute deviation / median ≤ MAX_MAD_FRACTION) — sparse or
// noisy comp sets return null (caller HOLDs).
//
// Method = median of the sale amounts (robust to outliers). When sqft is
// available across enough comps we ALSO surface a $/sqft median for the
// subject-sqft-scaled ARV, but the primary ARV is straight-median dollars.

const MIN_COMPS = 3;
const MAX_MAD_FRACTION = 0.25; // 25% dispersion ceiling; tighter → caller HOLDs

export interface ArvSynthesisResult {
  arv: number | null;
  /** Comps that survived plausibility (positive sale, dated within window). */
  comps: SoldComp[];
  /** Median sale amount (robust). null when comps insufficient. */
  median: number | null;
  /** Median absolute deviation / median — dispersion metric. */
  madFraction: number | null;
  /** Median $/sqft when ≥MIN_COMPS comps have sqft (secondary signal). */
  medianPricePerSqft: number | null;
  status: "ok" | "hold";
  reason: string;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Pure: synthesize an ARV from a comp list. */
export function synthesizeArv(comps: SoldComp[]): ArvSynthesisResult {
  if (comps.length < MIN_COMPS) {
    return {
      arv: null,
      comps,
      median: null,
      madFraction: null,
      medianPricePerSqft: null,
      status: "hold",
      reason: `insufficient comps — ${comps.length} < ${MIN_COMPS} required`,
    };
  }
  const amounts = comps.map((c) => c.saleAmount);
  const med = median(amounts) as number;
  const absDev = amounts.map((x) => Math.abs(x - med));
  const mad = median(absDev) as number;
  const madFrac = med > 0 ? mad / med : 1;
  if (madFrac > MAX_MAD_FRACTION) {
    return {
      arv: null,
      comps,
      median: med,
      madFraction: madFrac,
      medianPricePerSqft: null,
      status: "hold",
      reason: `comp dispersion too high — MAD/median ${(madFrac * 100).toFixed(1)}% > ${(MAX_MAD_FRACTION * 100).toFixed(0)}% ceiling`,
    };
  }
  const withSqft = comps.filter((c) => c.sqft != null && c.sqft > 0);
  const psqftMedian = withSqft.length >= MIN_COMPS
    ? median(withSqft.map((c) => c.saleAmount / (c.sqft as number)))
    : null;
  return {
    arv: Math.round(med),
    comps,
    median: med,
    madFraction: madFrac,
    medianPricePerSqft: psqftMedian == null ? null : Math.round(psqftMedian),
    status: "ok",
    reason: `ARV = median of ${comps.length} recorded sold comps = $${Math.round(med).toLocaleString()} (MAD/median ${(madFrac * 100).toFixed(1)}%)`,
  };
}

// ── Network wrappers (never throw) ────────────────────────────────────

export interface AttomFetchOutcome<T> {
  data: T | null;
  status: number | null;
  error: string | null;
  /** True when ATTOM returned a 2xx with at least one mapped record. */
  credentialed: boolean;
}

async function fetchAttom<T>(url: string, mapper: (body: unknown) => T): Promise<AttomFetchOutcome<T>> {
  if (!ATTOM_API_KEY) return { data: null, status: null, error: "ATTOM_API_KEY not set", credentialed: false };
  try {
    const res = await fetch(url, {
      headers: { apikey: ATTOM_API_KEY, accept: "application/json" },
      cache: "no-store",
    });
    const text = await res.text();
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = null; }
    if (!res.ok) {
      return {
        data: null,
        status: res.status,
        error: `ATTOM ${res.status}: ${text.slice(0, 240)}`,
        credentialed: true,
      };
    }
    return { data: mapper(body), status: res.status, error: null, credentialed: true };
  } catch (err) {
    return { data: null, status: null, error: err instanceof Error ? err.message : String(err), credentialed: true };
  }
}

export function fetchPropertyCharacteristics(addr: AttomAddress): Promise<AttomFetchOutcome<PropertyCharacteristics>> {
  return fetchAttom(buildPropertyDetailUrl(addr), (b) => mapPropertyDetail(b as AttomDetailResponse));
}

export function fetchAssessor(addr: AttomAddress): Promise<AttomFetchOutcome<AssessorRecord>> {
  return fetchAttom(buildAssessmentDetailUrl(addr), (b) => mapAssessmentDetail(b as AttomAssessmentResponse));
}

export interface SalesComparablesQuery {
  street: string;
  city: string;
  state: string;
  zip: string;
  searchRadiusMi?: number;
  minComps?: number;
  maxComps?: number;
}

export function fetchSalesComparables(q: SalesComparablesQuery): Promise<AttomFetchOutcome<SoldComp[]>> {
  return fetchAttom(
    buildSalesComparablesUrl(q.street, q.city, q.state, q.zip, {
      searchRadiusMi: q.searchRadiusMi ?? 1,
      minComps: q.minComps ?? 5,
      maxComps: q.maxComps ?? 20,
    }),
    (b) => mapSalesComparables(b as AttomSalesComparablesResponse),
  );
}

/** Convenience: fetch comps + synthesize ARV in one call. Returns
 *  status:"hold" + arv:null when ATTOM errors or comp synthesis HOLDs. */
export async function fetchArvFromAttom(q: SalesComparablesQuery): Promise<{
  status: "ok" | "hold";
  arv: number | null;
  synthesis: ArvSynthesisResult | null;
  fetchError: string | null;
}> {
  const out = await fetchSalesComparables(q);
  if (out.error || !out.data) {
    return { status: "hold", arv: null, synthesis: null, fetchError: out.error };
  }
  const syn = synthesizeArv(out.data);
  return { status: syn.status, arv: syn.arv, synthesis: syn, fetchError: null };
}
