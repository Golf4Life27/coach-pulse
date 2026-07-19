// ATTOM sold-comp source — BENCHMARK LANE ONLY until it earns promotion.
// @agent: appraiser
//
// Operator supplied a fresh ATTOM_API_KEY (2026-07-19) to run in parallel
// against the county ledger and RentCast property records. This module maps
// ATTOM /sale/snapshot rows into the same RentCastSaleComp shape so the
// three sources are compared apples-to-apples: freshness (newest sale
// date), coverage (qualifying comps), and price agreement. It is wired to
// the comp-benchmark endpoint, NOT to production ARV routing — promotion
// per market only happens on benchmark evidence, by operator ruling.
//
// Entitlement is unproven (key tier unknown): a 401/403 here is a REAL
// answer the benchmark surfaces, never a silent empty.

import { auditPaidCall } from "@/lib/spend/audit-paid-call";
import type { RentCastSaleComp } from "@/lib/rentcast";
import { haversineMiles } from "@/lib/rentcast";

const ATTOM_BASE = "https://api.gateway.attomdata.com/propertyapi/v1.0.0";

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
  if (!price || !date) return null;
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
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { apikey: key, accept: "application/json" },
      cache: "no-store",
    });
  } catch (err) {
    await auditPaidCall({ source: "attom", endpoint: "sale/snapshot", http: -1, ms: Date.now() - t0, recordId: opts.recordId, error: String(err) });
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
    if (body.includes("SuccessWithoutResult")) return [];
    throw new Error(`ATTOM sale/snapshot ${res.status}: ${body.slice(0, 200)}`);
  }
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
