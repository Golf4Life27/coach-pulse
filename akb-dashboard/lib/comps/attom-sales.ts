// ATTOM sold-comp source — PROMOTED 2026-07-19 by operator ruling on
// benchmark evidence. @agent: appraiser
//
// Ran the benchmark lane first (operator-supplied ATTOM_API_KEY,
// 2026-07-19): 37/8/19/45 qualifying comps (≤365d, ≤0.5mi) across Atlanta
// West Ave, Highland Park Puritan, Atlanta Boulder Park, and Birmingham
// Mayfield vs RentCast's 1/0/1/0. This module maps ATTOM /sale/snapshot
// rows into the same RentCastSaleComp shape the ARV engine already filters.
// It now serves production routing via lib/comps/sold-comps.ts: primary
// wherever no county deed ledger is authoritative, infra-failure fallback
// where one is. The benchmark endpoint keeps using it for comparisons.
//
// A 401/403 here is a REAL answer the caller surfaces, never a silent
// empty — thrown errors are what route the caller to the vendor path.

import { auditPaidCall } from "@/lib/spend/audit-paid-call";
import {
  checkLoopBreaker,
  recordCallError,
  recordCallOutcome,
} from "@/lib/rentcast/failure-loop-breaker";
import type { RentCastSaleComp } from "@/lib/rentcast";
import { haversineMiles } from "@/lib/rentcast";

const ATTOM_BASE = "https://api.gateway.attomdata.com/propertyapi/v1.0.0";
/** Breaker shape-key endpoint — distinct from every RentCast endpoint so
 *  counters never collide across vendors. */
const BREAKER_ENDPOINT = "attom:sale/snapshot";

/** Loose shape of an ATTOM /sale/snapshot record — mapped permissively
 *  (their schema nests hard and varies by entitlement tier). */
export type AttomSaleRecord = Record<string, unknown>;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}
/** Coordinates: any finite number — longitudes in the US are NEGATIVE, so
 *  the positive-only guard above must never touch them. Accepts numeric
 *  strings too (ATTOM stringifies coordinates on some tiers). */
function coord(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}
function dig(obj: unknown, ...path: string[]): unknown {
  let cur = obj;
  for (const k of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/** Sub-$10k recorded "sales" are nominal deed transfers (quit-claims,
 *  family conveyances — the $4,542 and $4,000 benchmark rows), not market
 *  evidence. They never reach band math; the distressed-proxy ZIP-median
 *  clip stays as the downstream filter for real-but-distressed prices. */
export const ATTOM_MIN_SALE_PRICE = 10_000;

/** Pure: one ATTOM sale record → the engine's comp shape, or null when it
 *  carries no usable recorded sale. */
export function attomSaleToComp(
  rec: AttomSaleRecord,
  subjectLat: number | null,
  subjectLng: number | null,
): RentCastSaleComp | null {
  const price = num(dig(rec, "sale", "amount", "saleamt")) ?? num(dig(rec, "sale", "saleAmt"));
  const date =
    str(dig(rec, "sale", "salesearchdate")) ??
    str(dig(rec, "sale", "saleTransDate")) ??
    str(dig(rec, "sale", "amount", "salerecdate"));
  if (!price || price < ATTOM_MIN_SALE_PRICE || !date) return null;
  const iso = `${date.slice(0, 10)}T00:00:00.000Z`;
  if (!/^\d{4}-\d{2}-\d{2}T/.test(iso)) return null;
  const lat = coord(dig(rec, "location", "latitude"));
  const lng = coord(dig(rec, "location", "longitude"));
  const distance =
    subjectLat != null && subjectLng != null && lat != null && lng != null
      ? Number(haversineMiles(subjectLat, subjectLng, lat, lng).toFixed(4))
      : null;
  const line = str(dig(rec, "address", "line1"));
  const locality = str(dig(rec, "address", "locality"));
  const state = str(dig(rec, "address", "countrySubd"));
  const zip = str(dig(rec, "address", "postal1"));
  return {
    price,
    squareFootage:
      num(dig(rec, "building", "size", "universalsize")) ??
      num(dig(rec, "building", "size", "livingsize")),
    bedrooms: num(dig(rec, "building", "rooms", "beds")),
    bathrooms: num(dig(rec, "building", "rooms", "bathstotal")),
    yearBuilt: num(dig(rec, "summary", "yearbuilt")),
    distance,
    daysOnMarket: null,
    removedDate: null,
    saleDate: iso,
    formattedAddress: [line, locality, state, zip].filter(Boolean).join(", ") || null,
  };
}

/** ATTOM sold comps around a point. Throws on non-2xx (entitlement/auth
 *  failures must be VISIBLE in the benchmark); [] is an honest zero. */
export async function getAttomSaleComps(
  subjectLat: number,
  subjectLng: number,
  opts: { radiusMiles?: number; sinceIsoDate?: string; recordId?: string } = {},
): Promise<RentCastSaleComp[]> {
  const key = process.env.ATTOM_API_KEY;
  if (!key) throw new Error("ATTOM_API_KEY not set");
  const radius = opts.radiusMiles ?? 0.6;
  const since = opts.sinceIsoDate ?? new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10);
  const p = new URLSearchParams({
    latitude: String(subjectLat),
    longitude: String(subjectLng),
    radius: String(radius),
    startsalesearchdate: since,
    pagesize: "100",
    propertytype: "SFR",
  });
  const url = `${ATTOM_BASE}/sale/snapshot?${p.toString()}`;

  // Failure-loop breaker (same P0 class as the RentCast one, now that this
  // is a production source): shape = the subject's point, so a stable
  // failure (entitlement 401, unindexed area, outage) stops billing after
  // the trip threshold instead of re-burning on every cron tick. The
  // thrown short-circuit routes the caller to its fallback.
  const shape = {
    address: `${subjectLat.toFixed(5)},${subjectLng.toFixed(5)}`,
    recordId: opts.recordId ?? null,
  };
  const pre = await checkLoopBreaker(BREAKER_ENDPOINT, shape);
  if (pre.tripped) {
    await auditPaidCall({
      source: "attom",
      endpoint: "sale/snapshot",
      http: 599,
      ms: 0,
      recordId: opts.recordId,
      error: `loop_breaker_tripped (count=${pre.count}, last_status=${pre.lastStatus})`,
    });
    throw new Error(
      `ATTOM sale/snapshot loop breaker tripped (count=${pre.count}, last_status=${pre.lastStatus}) — short-circuited, no spend`,
    );
  }

  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { apikey: key, accept: "application/json" },
      cache: "no-store",
    });
  } catch (err) {
    await auditPaidCall({ source: "attom", endpoint: "sale/snapshot", http: -1, ms: Date.now() - t0, recordId: opts.recordId, error: String(err) });
    await recordCallError(BREAKER_ENDPOINT, shape, "attom");
    throw err;
  }
  const body = await res.text();
  await auditPaidCall({
    source: "attom",
    endpoint: "sale/snapshot",
    http: res.status,
    ms: Date.now() - t0,
    recordId: opts.recordId,
    error: res.ok ? undefined : body.slice(0, 200),
  });
  // ATTOM answers "no records in this window" with a 400/SuccessWithoutResult
  // shape — an honest zero, not a failure.
  if (!res.ok) {
    if (body.includes("SuccessWithoutResult")) {
      // An answered call, not a failure: the breaker must NEVER trip on
      // honest zeros (a tripped breaker would route to staler sources and
      // paper over a real "no recent sales"). Recorded as success.
      await recordCallOutcome(BREAKER_ENDPOINT, shape, 200, "attom");
      return [];
    }
    await recordCallOutcome(BREAKER_ENDPOINT, shape, res.status, "attom");
    throw new Error(`ATTOM sale/snapshot ${res.status}: ${body.slice(0, 200)}`);
  }
  await recordCallOutcome(BREAKER_ENDPOINT, shape, res.status, "attom");
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(body) as Record<string, unknown>;
  } catch {
    throw new Error(`ATTOM sale/snapshot: non-JSON body (${body.slice(0, 120)})`);
  }
  const props = (data.property as AttomSaleRecord[]) ?? [];
  const comps: RentCastSaleComp[] = [];
  for (const rec of props) {
    const c = attomSaleToComp(rec, subjectLat, subjectLng);
    if (c) comps.push(c);
  }
  return comps;
}
