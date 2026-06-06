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

// ── Address normalization (ATTOM property-match) ──────────────────────
// ATTOM's matcher 400'd 2/3 live probe addresses ("Unable to locate a
// property record"). It is sensitive to casing, unit designators, doubled
// whitespace, and punctuation. Normalize the street BEFORE building any
// ATTOM URL so the match rate (and the TX/TN disclosure-gap measurement)
// improves. Pure; tested.
const UNIT_RE = /\s+(#|APT|UNIT|STE|SUITE|BLDG|FL|FLOOR|RM|ROOM|LOT|SPC|TRLR)\.?\s*\S+\s*$/i;

export function normalizeStreetForAttom(street: string | null | undefined): string {
  let s = (street ?? "").toUpperCase().trim();
  s = s.replace(/[.,]/g, " ");        // drop periods/commas
  s = s.replace(/\s+/g, " ").trim();  // collapse whitespace
  s = s.replace(UNIT_RE, "").trim();  // strip trailing unit designators
  return s;
}

// ── URL builders (pure) ───────────────────────────────────────────────

export function buildPropertyDetailUrl(addr: AttomAddress, base: string = ATTOM_BASE): string {
  const u = new URL(`${base}/property/detail`);
  u.searchParams.set("address1", normalizeStreetForAttom(addr.address1));
  u.searchParams.set("address2", addr.address2);
  return u.toString();
}

export function buildAssessmentDetailUrl(addr: AttomAddress, base: string = ATTOM_BASE): string {
  const u = new URL(`${base}/assessment/detail`);
  u.searchParams.set("address1", normalizeStreetForAttom(addr.address1));
  u.searchParams.set("address2", addr.address2);
  return u.toString();
}

/** ATTOM /saleshistory/detail returns the property's recorded transfer
 *  history (sale events, deed types, parties). Used for seller basis +
 *  deed-type ingestion (title-risk flagging). */
export function buildSalesHistoryUrl(addr: AttomAddress, base: string = ATTOM_BASE): string {
  const u = new URL(`${base}/saleshistory/detail`);
  u.searchParams.set("address1", normalizeStreetForAttom(addr.address1));
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
    `${base}/salescomparables/address/${enc(normalizeStreetForAttom(street))}/${enc(city)}/${enc(county)}/${enc(state)}/${enc(zip)}`,
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
  /** v1.0.0-style flat shape (kept as a fallback / for unit fixtures). */
  comparables?: AttomComp[];
  property?: Array<{ sale?: AttomComp }>;
  /** v2 MISMO envelope (the REAL shape — confirmed live 2026-06-06). */
  RESPONSE_GROUP?: unknown;
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

/** Title-risk classes derived from deed type. Quit-claim and tax-foreclosure
 *  deeds carry materially higher title-defect probability (un-warranted
 *  title or compressed transfer chain). Surfaced as a DD item, never as an
 *  auto-dispose. */
export type TitleRisk = "none" | "quit_claim" | "tax_foreclosure" | "sheriff" | "unknown";

export function classifyTitleRisk(deedType: string | null | undefined): TitleRisk {
  if (!deedType) return "unknown";
  const d = deedType.toLowerCase();
  if (d.includes("quit") || d.includes("quitclaim")) return "quit_claim";
  if (d.includes("tax") && (d.includes("foreclosure") || d.includes("deed") || d.includes("sale"))) return "tax_foreclosure";
  if (d.includes("sheriff") || d.includes("treasurer")) return "sheriff";
  return "none";
}

export interface SalesHistoryEvent {
  saleAmount: number | null;
  saleDate: string | null;
  deedType: string | null;
  sellerName: string | null;
  buyerName: string | null;
  titleRisk: TitleRisk;
}

export interface SalesHistoryRecord {
  /** Most-recent sale event (the seller basis). */
  lastSale: SalesHistoryEvent | null;
  /** Full event list (most-recent first when ordered). */
  events: SalesHistoryEvent[];
  /** True when ANY event in the history carries a flagged deed type. */
  titleRiskAny: boolean;
}

/** Pure: parse ATTOM /saleshistory/detail into structured events. Accepts
 *  the v1.0.0 flat envelope (property[].salehistory[]) — newest first. */
export function mapSalesHistory(body: unknown): SalesHistoryRecord {
  const empty: SalesHistoryRecord = { lastSale: null, events: [], titleRiskAny: false };
  const properties = getObj(body, "property");
  const p0 = Array.isArray(properties) ? (properties[0] as Record<string, unknown>) : null;
  if (!p0) return empty;
  // salehistory is the canonical key; fall back to saleshistory casing.
  const raw = (getObj(p0, "salehistory") ?? getObj(p0, "saleshistory") ?? getObj(p0, "saleHistory")) as unknown;
  const arr = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
  const events: SalesHistoryEvent[] = arr.map((evt) => {
    const amount = (getObj(getObj(evt, "amount"), "saleamt") as number | undefined) ?? null;
    const date =
      (getObj(getObj(evt, "amount"), "salesearchdate") as string | undefined) ??
      (getObj(getObj(evt, "amount"), "salerecdate") as string | undefined) ??
      (getObj(evt, "salesearchdate") as string | undefined) ??
      null;
    const deedType =
      (getObj(getObj(evt, "calculation"), "deedType") as string | undefined) ??
      (getObj(getObj(evt, "saleTransDate"), "deedType") as string | undefined) ??
      (getObj(evt, "deedType") as string | undefined) ??
      null;
    const seller = (getObj(getObj(evt, "saleHistoryTransfer"), "transferName2") as string | undefined) ?? null;
    const buyer = (getObj(getObj(evt, "saleHistoryTransfer"), "transferName1") as string | undefined) ?? null;
    return {
      saleAmount: typeof amount === "number" && Number.isFinite(amount) && amount > 0 ? amount : null,
      saleDate: typeof date === "string" ? date : null,
      deedType: typeof deedType === "string" ? deedType : null,
      sellerName: typeof seller === "string" ? seller : null,
      buyerName: typeof buyer === "string" ? buyer : null,
      titleRisk: classifyTitleRisk(typeof deedType === "string" ? deedType : null),
    };
  });
  // Order newest first by saleDate when parseable; events lacking a date
  // stay in input order at the bottom.
  events.sort((a, b) => {
    const at = a.saleDate ? Date.parse(a.saleDate) : 0;
    const bt = b.saleDate ? Date.parse(b.saleDate) : 0;
    return bt - at;
  });
  const lastSale = events[0] ?? null;
  const titleRiskAny = events.some((e) => e.titleRisk !== "none" && e.titleRisk !== "unknown");
  return { lastSale, events, titleRiskAny };
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
  /** Comp's own zip — drives the subject-zip sold-benchmark reconciliation
   *  (cross-zip comps are the boundary-contamination class). */
  zip: string | null;
  /** Distance from subject (miles) — for the comp-audit surface. */
  distanceMi: number | null;
}

function asArray(x: unknown): Record<string, unknown>[] {
  if (Array.isArray(x)) return x as Record<string, unknown>[];
  if (x != null && typeof x === "object") return [x as Record<string, unknown>];
  return [];
}
function getObj(o: unknown, key: string): unknown {
  return o != null && typeof o === "object" ? (o as Record<string, unknown>)[key] : undefined;
}
function attr(o: unknown, key: string): string | null {
  const v = getObj(o, key);
  return v == null ? null : String(v);
}
function numAttr(o: unknown, key: string): number | null {
  const v = attr(o, key);
  if (v == null || v.trim() === "") return null;
  const n = parseFloat(v.replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Pure: parse the v2 MISMO sales-comparables envelope into SoldComp[]. The
 *  comps live at RESPONSE_GROUP.RESPONSE.RESPONSE_DATA
 *  .PROPERTY_INFORMATION_RESPONSE_ext.SUBJECT_PROPERTY_ext.PROPERTY[], where
 *  each PROPERTY element carrying a COMPARABLE_PROPERTY_ext is a comp.
 *  Non-arms-length transfers (indicator present and != "A") are excluded —
 *  ARV integrity (the subject's own REO/bank transfer is NOT a comp). */
function parseMismoComps(body: AttomSalesComparablesResponse): SoldComp[] {
  const rg = getObj(body, "RESPONSE_GROUP");
  // tolerate RESPONSE / response casing
  const resp = getObj(rg, "RESPONSE") ?? getObj(rg, "response");
  const rd = getObj(resp, "RESPONSE_DATA");
  const pir = getObj(rd, "PROPERTY_INFORMATION_RESPONSE_ext");
  const subj = getObj(pir, "SUBJECT_PROPERTY_ext");
  const props = asArray(getObj(subj, "PROPERTY"));
  const out: SoldComp[] = [];
  for (const p of props) {
    for (const c of asArray(getObj(p, "COMPARABLE_PROPERTY_ext"))) {
      const sh = getObj(c, "SALES_HISTORY");
      const amt = numAttr(sh, "@PropertySalesAmount");
      if (amt == null || amt <= 0) continue;
      const arms = attr(sh, "@ArmsLengthTransactionIndicatorExt");
      if (arms != null && arms.trim() !== "" && arms.toUpperCase() !== "A") continue;
      const sqft = numAttr(getObj(c, "STRUCTURE"), "@GrossLivingAreaSquareFeetCount");
      out.push({
        saleAmount: amt,
        saleDate: attr(sh, "@TransferDate_ext") ?? attr(sh, "@PropertySalesDate"),
        sqft: sqft != null && sqft > 0 ? sqft : null,
        address: attr(c, "@_StreetAddress"),
        zip: attr(c, "@_PostalCode"),
        distanceMi: numAttr(c, "@DistanceFromSubjectPropertyMilesCount"),
      });
    }
  }
  return out;
}

export function mapSalesComparables(body: AttomSalesComparablesResponse): SoldComp[] {
  // v2 MISMO envelope (the real API shape) first.
  const mismo = parseMismoComps(body);
  if (mismo.length > 0) return mismo;
  // Fallback: v1.0.0-style flat shapes (unit fixtures / legacy).
  const flat = Array.isArray(body.comparables) ? body.comparables : [];
  const nested: AttomComp[] = Array.isArray(body.property)
    ? body.property.map((p) => p.sale).filter((s): s is AttomComp => !!s)
    : [];
  return [...flat, ...nested]
    .map((c): SoldComp | null => {
      const amt = c.amount?.saleamt;
      if (typeof amt !== "number" || !Number.isFinite(amt) || amt <= 0) return null;
      return {
        saleAmount: amt,
        saleDate: c.salesearchdate ?? null,
        sqft: c.size?.livingsize ?? c.size?.universalsize ?? null,
        address: c.address?.line1 ?? null,
        zip: c.address?.postal1 ?? null,
        distanceMi: null,
      };
    })
    .filter((x): x is SoldComp => x != null);
}

// ── ARV synthesizer — RENOVATED-CLUSTER method ────────────────────────
// The single integrity point: ARV from recorded retail sold comps. Never
// AVM, and NEVER a fabricated value multiplier (the arv_uplift.json 2.0×
// is a single-deal operator fit — cross-check only, never a generator).
//
// Detroit/Memphis comp sets are BIMODAL: a distressed cluster (low $/sqft,
// REO/wholesale) and a renovated cluster (high $/sqft, retail). ARV = After-
// Repair Value = the RENOVATED cluster's value, computed from the comps
// themselves:
//   1. keep recent (≤RECENCY_MONTHS) comps with a positive sale + sqft.
//   2. cluster on $/sqft via the single largest gap. The split is declared
//      bimodal ONLY when that gap DOMINATES (≥ GAP_DOMINANCE × the next-
//      largest gap) — otherwise the market is unimodal and the whole recent
//      set IS the market (renovated == market value there).
//   3. renovated cluster = the upper $/sqft cluster (or the whole set when
//      unimodal). Require ≥MIN_RENOVATED_COMPS + the dispersion bound on the
//      renovated cluster's $/sqft, else HOLD.
//   4. ARV = renovated-cluster median $/sqft × subject sqft (sqft-scaled to
//      the subject). Falls back to renovated-cluster median sale amount when
//      subject sqft is unknown.
//
// No fabricated numbers anywhere: every threshold is a clustering-validity
// rule (relative to the data's own dispersion), not an assumed value factor.

const MIN_RENOVATED_COMPS = 3;
const MAX_MAD_FRACTION = 0.25;   // dispersion ceiling on the renovated cluster
const RECENCY_MONTHS = 24;       // ignore stale recorded sales
const GAP_DOMINANCE = 2;         // largest $/sqft gap must be ≥2× the next to split
// Sold-benchmark reconciliation: the (radius-wide) renovated cluster median
// $/sqft must reconcile against the subject's OWN-ZIP renovated sold $/sqft.
// Breach (cluster runs hot vs the zip's observed solds — boundary
// contamination from pricier adjacent zips) → flag for comp audit, never
// auto-pass. The benchmark is DATA-DERIVED (the subject-zip comps), not a
// constant; the tolerance is the only knob.
const BENCHMARK_TOLERANCE = 0.15; // cluster may exceed zip benchmark by ≤15%
// Nearest-weighted CONSERVATIVE ARV — the "never the hot tail" surface.
// When the renovated band is wide, distance matters: closer comps reflect
// the same micro-market; farther comps drift into neighbor pockets. Weight
// inversely by distance, then take the conservative percentile (25th) of
// the weighted $/sqft. This is a SECOND ARV ANCHOR, surfaced alongside the
// median; callers can decide whether to underwrite from the conservative
// or central figure. Pure: no fabricated multiplier, derived from the same
// comp set.
const CONSERVATIVE_PERCENTILE = 0.25;
const NEAREST_INVERSE_DISTANCE_EPS_MI = 0.1; // floor on inverse-distance weight

export interface CompPpsf {
  comp: SoldComp;
  ppsf: number;
}

/** A single renovated comp, for the comp-audit surface. */
export interface RenovatedCompAudit {
  address: string | null;
  zip: string | null;
  distanceMi: number | null;
  sqft: number | null;
  saleAmount: number;
  saleDate: string | null;
  ppsf: number;
}

export type GuardStatus = "clean" | "benchmark_breach" | "no_zip_benchmark";

export interface ArvSynthesisResult {
  arv: number | null;
  /** Recent valid comps actually used (positive sale + sqft, within window). */
  comps: SoldComp[];
  /** Whether a dominant bimodal split was detected. */
  bimodal: boolean;
  /** Renovated (upper) cluster size + median $/sqft. */
  renovatedCount: number;
  renovatedMedianPpsf: number | null;
  /** Distressed (lower) cluster size + median $/sqft (null when unimodal). */
  distressedCount: number;
  distressedMedianPpsf: number | null;
  /** MAD/median of the renovated cluster's $/sqft (dispersion). */
  madFraction: number | null;
  /** Subject-zip renovated benchmark $/sqft (data-derived) + reconciliation. */
  zipBenchmarkPpsf: number | null;
  zipBenchmarkComps: number;
  benchmarkBreach: boolean;
  guardStatus: GuardStatus;
  /** The renovated comps backing the ARV — for the comp-audit surface. */
  renovatedComps: RenovatedCompAudit[];
  /** Nearest-weighted CONSERVATIVE ARV: inverse-distance-weighted comps,
   *  25th percentile of $/sqft × subject sqft. The "never the hot tail"
   *  number — for underwriting from the conservative side when the band
   *  is wide. null when subjectSqft unknown OR none of the renovated
   *  comps carry distance. */
  arvConservative: number | null;
  conservativeMedianPpsf: number | null;
  status: "ok" | "hold";
  reason: string;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function monthsBetween(dateStr: string | null | undefined, now: Date): number | null {
  if (!dateStr) return null;
  const t = Date.parse(dateStr);
  if (!Number.isFinite(t)) return null;
  return (now.getTime() - t) / (1000 * 60 * 60 * 24 * 30.44);
}

interface ClusterOutcome {
  status: "ok" | "hold";
  reason: string;
  renovated: CompPpsf[];
  distressed: CompPpsf[];
  bimodal: boolean;
  renovatedMedPpsf: number | null;
  distressedMedPpsf: number | null;
  madFraction: number | null;
}

/** Pure: recency-filter + largest-gap cluster a comp set; return the
 *  renovated cluster + its median $/sqft (with the dispersion bound). Reused
 *  for the full radius set (ARV) AND the subject-zip subset (benchmark). */
function renovatedCluster(comps: SoldComp[], now: Date): ClusterOutcome {
  const recent = comps.filter((c) => {
    if (!(c.saleAmount > 0)) return false;
    if (!(typeof c.sqft === "number" && c.sqft > 0)) return false;
    const m = monthsBetween(c.saleDate, now);
    return m == null || m <= RECENCY_MONTHS;
  });
  if (recent.length < MIN_RENOVATED_COMPS) {
    return { status: "hold", reason: `insufficient recent comps with sqft — ${recent.length} < ${MIN_RENOVATED_COMPS}`, renovated: [], distressed: [], bimodal: false, renovatedMedPpsf: null, distressedMedPpsf: null, madFraction: null };
  }
  const pp: CompPpsf[] = recent
    .map((c) => ({ comp: c, ppsf: c.saleAmount / (c.sqft as number) }))
    .sort((a, b) => a.ppsf - b.ppsf);
  const gaps: Array<{ idx: number; gap: number }> = [];
  for (let i = 1; i < pp.length; i++) gaps.push({ idx: i, gap: pp[i].ppsf - pp[i - 1].ppsf });
  const sortedGaps = [...gaps].sort((a, b) => b.gap - a.gap);
  const largest = sortedGaps[0];
  const second = sortedGaps[1];
  const bimodal =
    pp.length >= 4 && largest != null && largest.gap > 0 &&
    (second == null || second.gap === 0 || largest.gap >= GAP_DOMINANCE * second.gap);
  const renovated = bimodal ? pp.slice(largest.idx) : pp;
  const distressed = bimodal ? pp.slice(0, largest.idx) : [];
  const distressedMedPpsf = distressed.length > 0 ? median(distressed.map((x) => x.ppsf)) : null;
  if (renovated.length < MIN_RENOVATED_COMPS) {
    return { status: "hold", reason: `renovated cluster too thin — ${renovated.length} < ${MIN_RENOVATED_COMPS}`, renovated, distressed, bimodal, renovatedMedPpsf: null, distressedMedPpsf, madFraction: null };
  }
  const renoPpsf = renovated.map((x) => x.ppsf);
  const medPpsf = median(renoPpsf) as number;
  const mad = median(renoPpsf.map((x) => Math.abs(x - medPpsf))) as number;
  const madFrac = medPpsf > 0 ? mad / medPpsf : 1;
  if (madFrac > MAX_MAD_FRACTION) {
    return { status: "hold", reason: `renovated cluster dispersion too high — MAD/median ${(madFrac * 100).toFixed(1)}% > ${(MAX_MAD_FRACTION * 100).toFixed(0)}% ceiling`, renovated, distressed, bimodal, renovatedMedPpsf: Math.round(medPpsf), distressedMedPpsf, madFraction: madFrac };
  }
  return { status: "ok", reason: "ok", renovated, distressed, bimodal, renovatedMedPpsf: medPpsf, distressedMedPpsf, madFraction: madFrac };
}

function holdArv(comps: SoldComp[], reason: string, extra: Partial<ArvSynthesisResult> = {}): ArvSynthesisResult {
  return {
    arv: null, comps, bimodal: false,
    renovatedCount: 0, renovatedMedianPpsf: null,
    distressedCount: 0, distressedMedianPpsf: null,
    madFraction: null, zipBenchmarkPpsf: null, zipBenchmarkComps: 0,
    benchmarkBreach: false, guardStatus: "no_zip_benchmark",
    renovatedComps: [], arvConservative: null, conservativeMedianPpsf: null,
    status: "hold", reason, ...extra,
  };
}

/** Pure: nearest-weighted CONSERVATIVE $/sqft from a $/sqft list with
 *  distances. Weight = 1 / max(distance, EPS); sort by $/sqft asc and
 *  take the value at the cumulative-weight P25 (the conservative tail).
 *  null when no distances are available across the input. */
export function nearestWeightedConservativePpsf(
  pp: CompPpsf[],
  percentile: number = CONSERVATIVE_PERCENTILE,
): number | null {
  const weighted = pp
    .map((x) => ({ ppsf: x.ppsf, dist: x.comp.distanceMi }))
    .filter((x) => typeof x.dist === "number" && Number.isFinite(x.dist!));
  if (weighted.length === 0) return null;
  const sorted = [...weighted].sort((a, b) => a.ppsf - b.ppsf);
  const totalW = sorted.reduce(
    (s, x) => s + 1 / Math.max(x.dist as number, NEAREST_INVERSE_DISTANCE_EPS_MI),
    0,
  );
  const target = totalW * percentile;
  let acc = 0;
  for (const x of sorted) {
    acc += 1 / Math.max(x.dist as number, NEAREST_INVERSE_DISTANCE_EPS_MI);
    if (acc >= target) return x.ppsf;
  }
  return sorted[sorted.length - 1].ppsf;
}

/** Pure: synthesize a RENOVATED-cluster ARV from recorded comps, with the
 *  subject-zip sold-benchmark reconciliation guard. */
export function synthesizeArv(
  comps: SoldComp[],
  opts: { subjectSqft?: number | null; subjectZip?: string | null; now?: Date } = {},
): ArvSynthesisResult {
  const now = opts.now ?? new Date();
  const subjectSqft = typeof opts.subjectSqft === "number" && opts.subjectSqft > 0 ? opts.subjectSqft : null;
  const subjectZip = (opts.subjectZip ?? "").trim() || null;

  const cl = renovatedCluster(comps, now);
  const recent = comps.filter((c) => c.saleAmount > 0 && typeof c.sqft === "number" && c.sqft > 0);
  if (cl.status !== "ok" || cl.renovatedMedPpsf == null) {
    return holdArv(recent, cl.reason, {
      bimodal: cl.bimodal,
      renovatedCount: cl.renovated.length,
      renovatedMedianPpsf: cl.renovatedMedPpsf == null ? null : Math.round(cl.renovatedMedPpsf),
      distressedCount: cl.distressed.length,
      distressedMedianPpsf: cl.distressedMedPpsf == null ? null : Math.round(cl.distressedMedPpsf),
      madFraction: cl.madFraction,
    });
  }
  const medPpsf = cl.renovatedMedPpsf;

  // ── Sold-benchmark reconciliation (subject-zip renovated $/sqft) ──────
  // Cluster the subject-zip comps independently; that renovated median is
  // the zip's observed renovated sold $/sqft. If the radius-wide cluster
  // runs hot vs it (>tolerance), the cluster is contaminated by pricier
  // adjacent zips → breach → flag, never auto-pass. No same-zip benchmark
  // (the comps are mostly out-of-zip) is ALSO a flag.
  let zipBenchmarkPpsf: number | null = null;
  let zipBenchmarkComps = 0;
  let guardStatus: GuardStatus = "clean";
  if (subjectZip) {
    const sameZip = comps.filter((c) => (c.zip ?? "").trim() === subjectZip);
    const zc = renovatedCluster(sameZip, now);
    if (zc.status === "ok" && zc.renovatedMedPpsf != null) {
      zipBenchmarkPpsf = zc.renovatedMedPpsf;
      zipBenchmarkComps = zc.renovated.length;
      if (medPpsf > zipBenchmarkPpsf * (1 + BENCHMARK_TOLERANCE)) guardStatus = "benchmark_breach";
    } else {
      guardStatus = "no_zip_benchmark";
    }
  } else {
    guardStatus = "no_zip_benchmark";
  }
  const benchmarkBreach = guardStatus === "benchmark_breach";

  const arv = subjectSqft != null
    ? Math.round(medPpsf * subjectSqft)
    : Math.round(median(cl.renovated.map((x) => x.comp.saleAmount)) as number);

  // Nearest-weighted conservative ARV — the "never the hot tail" surface.
  const conservativePpsf = nearestWeightedConservativePpsf(cl.renovated);
  const arvConservative = conservativePpsf != null && subjectSqft != null
    ? Math.round(conservativePpsf * subjectSqft)
    : null;

  const renovatedComps: RenovatedCompAudit[] = cl.renovated
    .map((x) => ({ address: x.comp.address, zip: x.comp.zip, distanceMi: x.comp.distanceMi, sqft: x.comp.sqft, saleAmount: x.comp.saleAmount, saleDate: x.comp.saleDate, ppsf: Math.round(x.ppsf) }))
    .sort((a, b) => b.ppsf - a.ppsf);

  const guardNote =
    guardStatus === "clean"
      ? `zip-benchmark OK ($${Math.round(medPpsf)} cluster vs $${zipBenchmarkPpsf != null ? Math.round(zipBenchmarkPpsf) : "-"} zip, ${zipBenchmarkComps} zip comps)`
      : guardStatus === "benchmark_breach"
      ? `⚠ BENCHMARK BREACH — cluster $${Math.round(medPpsf)}/sqft > zip $${Math.round(zipBenchmarkPpsf as number)}/sqft +${(((medPpsf / (zipBenchmarkPpsf as number)) - 1) * 100).toFixed(0)}% (comp-audit required; do NOT auto-pass)`
      : `⚠ NO ZIP BENCHMARK — <${MIN_RENOVATED_COMPS} same-zip renovated comps (cluster is cross-zip; comp-audit required)`;

  return {
    arv,
    comps: recent,
    bimodal: cl.bimodal,
    renovatedCount: cl.renovated.length,
    renovatedMedianPpsf: Math.round(medPpsf),
    distressedCount: cl.distressed.length,
    distressedMedianPpsf: cl.distressedMedPpsf == null ? null : Math.round(cl.distressedMedPpsf),
    madFraction: cl.madFraction,
    zipBenchmarkPpsf: zipBenchmarkPpsf == null ? null : Math.round(zipBenchmarkPpsf),
    zipBenchmarkComps,
    benchmarkBreach,
    guardStatus,
    renovatedComps,
    arvConservative,
    conservativeMedianPpsf: conservativePpsf == null ? null : Math.round(conservativePpsf),
    status: "ok",
    reason: `ARV $${arv.toLocaleString()} (central) / $${arvConservative != null ? arvConservative.toLocaleString() : "-"} (conservative, P25 nearest-weighted) = renovated cluster ${subjectSqft != null ? `central $/sqft $${Math.round(medPpsf)} / conservative $${conservativePpsf != null ? Math.round(conservativePpsf) : "-"} × ${subjectSqft} sqft` : "median sale"} (${cl.renovated.length} reno comps${cl.bimodal ? `, distressed ${cl.distressed.length} @ $${cl.distressedMedPpsf != null ? Math.round(cl.distressedMedPpsf) : "-"}/sqft` : ", unimodal"}, MAD ${((cl.madFraction ?? 0) * 100).toFixed(1)}%). ${guardNote}.`,
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

/** Fetch the property's recorded transfer history (sale events, deed
 *  types, parties). Used for seller basis + title-risk flagging. */
export function fetchSalesHistory(addr: AttomAddress): Promise<AttomFetchOutcome<SalesHistoryRecord>> {
  return fetchAttom(buildSalesHistoryUrl(addr), (b) => mapSalesHistory(b));
}

export interface SalesComparablesQuery {
  street: string;
  city: string;
  state: string;
  zip: string;
  searchRadiusMi?: number;
  minComps?: number;
  maxComps?: number;
  /** Subject living area — scales the renovated-cluster $/sqft into a
   *  subject-specific ARV. */
  subjectSqft?: number | null;
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

/** Debug-only: return the RAW salescomparables JSON body (truncated) so the
 *  v2 envelope shape can be mapped precisely. Never used in the live path. */
export async function fetchSalesComparablesRaw(q: SalesComparablesQuery): Promise<{ status: number | null; bodyText: string | null; error: string | null }> {
  if (!ATTOM_API_KEY) return { status: null, bodyText: null, error: "ATTOM_API_KEY not set" };
  try {
    const url = buildSalesComparablesUrl(q.street, q.city, q.state, q.zip, {
      searchRadiusMi: q.searchRadiusMi ?? 1,
      minComps: q.minComps ?? 5,
      maxComps: q.maxComps ?? 20,
    });
    const res = await fetch(url, { headers: { apikey: ATTOM_API_KEY, accept: "application/json" }, cache: "no-store" });
    const text = await res.text();
    return { status: res.status, bodyText: text.slice(0, 9000), error: null };
  } catch (err) {
    return { status: null, bodyText: null, error: err instanceof Error ? err.message : String(err) };
  }
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
  const syn = synthesizeArv(out.data, { subjectSqft: q.subjectSqft ?? null, subjectZip: q.zip });
  return { status: syn.status, arv: syn.arv, synthesis: syn, fetchError: null };
}
