// Seller Basis — ATTOM ownership + open-mortgage intel. @agent: appraiser
//
// WHY (2026-07-20, the Canfield "double it" decode): the seller was a
// corporate flipper who paid $145k with a $108,750 Park Place bridge loan —
// their counter wasn't posture, it was their PAYOFF FLOOR. Three bumps went
// out before the operator learned the seller mathematically couldn't say
// yes. This module pulls that intel per deal from ATTOM (already-keyed,
// contractual API — no portal credentials, no scraping): last sale price/
// date, open loan amount + lender + origination, owner identity. The card
// renders a seller-floor read BEFORE the first offer goes out.
//
// Entitlement honesty: the operator's key tier is proven for /sale/snapshot
// only. A 401/403 on this endpoint is a REAL answer the route surfaces —
// never a silent empty. Mapped permissively (ATTOM nests hard and varies
// by tier), same doctrine as lib/comps/attom-sales.ts.

import { auditPaidCall } from "@/lib/spend/audit-paid-call";
import {
  checkLoopBreaker,
  recordCallError,
  recordCallOutcome,
} from "@/lib/rentcast/failure-loop-breaker";

const ATTOM_BASE = "https://api.gateway.attomdata.com/propertyapi/v1.0.0";
const BREAKER_ENDPOINT = "attom:property/expandedprofile";

export interface SellerBasis {
  ownerName: string | null;
  /** True when the owner reads as an entity (LLC/INC/TRUST/CORP…). */
  corporateOwner: boolean | null;
  lastSalePrice: number | null;
  lastSaleDate: string | null;
  /** Most recent recorded mortgage — ORIGINAL amount, not payoff. The card
   *  labels it honestly; a bridge/interest-only note ≈ payoff, an old
   *  amortizing note is an upper bound. */
  loanAmount: number | null;
  lender: string | null;
  loanDate: string | null;
  fetchedAt: string;
}

function dig(obj: unknown, ...path: string[]): unknown {
  let cur = obj;
  for (const k of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}
function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) && Number(v) > 0) return Number(v);
  return null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

const ENTITY_MARKERS = /\b(LLC|L\.L\.C|INC|CORP|CORPORATION|TRUST|PROPERTIES|HOLDINGS|VENTURES|CAPITAL|INVESTMENTS?|PARTNERS|LP|LLP|COMPANY|CO\b|ASSOCIATION|AUTHORITY|BANK|MORTGAGE)\b/i;

/** Pure: one ATTOM expandedprofile property record → SellerBasis. Null when
 *  the record carries nothing usable. Exported for tests. */
export function attomProfileToSellerBasis(rec: unknown, fetchedAt: string): SellerBasis | null {
  if (!rec || typeof rec !== "object") return null;

  const owner1First = str(dig(rec, "owner", "owner1", "firstnameandmi"));
  const owner1Last = str(dig(rec, "owner", "owner1", "lastname"));
  const ownerFull =
    str(dig(rec, "owner", "owner1", "fullname")) ??
    ([owner1First, owner1Last].filter(Boolean).join(" ") || null);
  const corporateIndicator = str(dig(rec, "owner", "corporateindicator"));
  const corporateOwner =
    corporateIndicator != null
      ? corporateIndicator.toUpperCase() === "Y"
      : ownerFull != null
        ? ENTITY_MARKERS.test(ownerFull)
        : null;

  const lastSalePrice =
    num(dig(rec, "sale", "amount", "saleamt")) ?? num(dig(rec, "sale", "saleAmt"));
  const lastSaleDate =
    str(dig(rec, "sale", "salesearchdate")) ??
    str(dig(rec, "sale", "saleTransDate")) ??
    str(dig(rec, "sale", "amount", "salerecdate"));

  // Mortgage nests differently by tier: assessment.mortgage.FirstConcurrent
  // (expandedprofile) or a top-level mortgage object (detailmortgage tiers).
  const mtg =
    dig(rec, "assessment", "mortgage", "FirstConcurrent") ??
    dig(rec, "assessment", "mortgage", "firstConcurrent") ??
    dig(rec, "mortgage", "FirstConcurrent") ??
    dig(rec, "mortgage");
  const loanAmount = num(dig(mtg, "amount"));
  const lender =
    str(dig(mtg, "lendercompanyname")) ??
    str(dig(mtg, "lenderlastname")) ??
    str(dig(mtg, "lender", "lastname", "lenderlastname"));
  const loanDate = str(dig(mtg, "date")) ?? str(dig(mtg, "recordingdate"));

  if (
    ownerFull == null &&
    lastSalePrice == null &&
    loanAmount == null
  ) {
    return null;
  }
  return {
    ownerName: ownerFull,
    corporateOwner,
    lastSalePrice,
    lastSaleDate,
    loanAmount,
    lender,
    loanDate,
    fetchedAt,
  };
}

/** ATTOM expandedprofile pull for a subject address. Throws on non-2xx
 *  (entitlement/auth failures must be VISIBLE); null is an honest "ATTOM
 *  has no usable ownership record here". Behind the paid-call loop-breaker:
 *  a stable failing shape stops billing after the trip threshold. */
export async function getSellerBasis(input: {
  address: string;
  city: string;
  state: string;
  zip: string;
  recordId?: string;
}): Promise<SellerBasis | null> {
  const key = process.env.ATTOM_API_KEY;
  if (!key) throw new Error("ATTOM_API_KEY not set");

  const shape = { address: input.address, city: input.city, state: input.state, zip: input.zip, recordId: input.recordId ?? null };
  const pre = await checkLoopBreaker(BREAKER_ENDPOINT, shape);
  if (pre.tripped) {
    await auditPaidCall({
      source: "attom",
      endpoint: "property/expandedprofile",
      http: 599,
      ms: 0,
      recordId: input.recordId,
      error: `loop_breaker_tripped (count=${pre.count}, last_status=${pre.lastStatus})`,
    });
    throw new Error(
      `ATTOM expandedprofile loop breaker tripped (count=${pre.count}, last_status=${pre.lastStatus}) — short-circuited, no spend`,
    );
  }

  const p = new URLSearchParams({
    address1: input.address,
    address2: `${input.city}, ${input.state} ${input.zip}`,
  });
  const url = `${ATTOM_BASE}/property/expandedprofile?${p.toString()}`;
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(url, { headers: { apikey: key, accept: "application/json" }, cache: "no-store" });
  } catch (err) {
    await auditPaidCall({ source: "attom", endpoint: "property/expandedprofile", http: -1, ms: Date.now() - t0, recordId: input.recordId, error: String(err) });
    await recordCallError(BREAKER_ENDPOINT, shape, "attom");
    throw err;
  }
  const body = await res.text();
  await auditPaidCall({
    source: "attom",
    endpoint: "property/expandedprofile",
    http: res.status,
    ms: Date.now() - t0,
    recordId: input.recordId,
    error: res.ok ? undefined : body.slice(0, 200),
  });
  if (!res.ok) {
    // "No records found" (400/SuccessWithoutResult) is an honest null —
    // an answered call, never a breaker increment.
    if (body.includes("SuccessWithoutResult")) {
      await recordCallOutcome(BREAKER_ENDPOINT, shape, 200, "attom");
      return null;
    }
    await recordCallOutcome(BREAKER_ENDPOINT, shape, res.status, "attom");
    throw new Error(`ATTOM expandedprofile ${res.status}: ${body.slice(0, 200)}`);
  }
  await recordCallOutcome(BREAKER_ENDPOINT, shape, res.status, "attom");
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(body) as Record<string, unknown>;
  } catch {
    throw new Error(`ATTOM expandedprofile: non-JSON body (${body.slice(0, 120)})`);
  }
  const rec = Array.isArray(data.property) ? data.property[0] : undefined;
  return attomProfileToSellerBasis(rec, new Date().toISOString());
}
