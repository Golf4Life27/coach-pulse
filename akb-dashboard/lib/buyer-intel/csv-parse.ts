// InvestorBase per-property buyer CSV → buyer transactions. CONVEYOR M5.
// @agent: appraiser/data_federation
//
// THE TRAP (the whole reason this module exists): `Most Recent Sale Price`
// means OPPOSITE things by Buyer Type —
//   landlord → it is their ACQUISITION (they hold). This is what they pay.
//   flipper  → it is their RENOVATED EXIT (resale/ARV). The flipper's
//              acquisition is `Prior Sale Price`.
// A naive median of `Most Recent Sale Price` across all rows blends
// acquisitions with resales (~$100k on the real exports) — a fabricated
// number that, fed to MAO, fires bad offers. This module never produces it.
//
// ACQUISITION-PRICE RULE (hard):
//   acquisition_price = Most Recent Sale Price   when Buyer Type == landlord
//   acquisition_price = Prior Sale Price         when Buyer Type == flipper
//   flipper Most Recent Sale Price is captured separately as resale_price
//     (an ARV/resale comp) and is NEVER counted as an acquisition.
//   Rows with no usable acquisition price are EXCLUDED (never zero-filled).
//
// PURE — no I/O. The store/ingest layer (ingest.ts) and the median layer
// (buyer-median.ts) build on this. Composes the existing BuyerTrack type.

import Papa from "papaparse";
import type { BuyerTrack } from "@/lib/buyer-median-input";

export interface BuyerContacts {
  wireless1: string | null;
  wireless2: string | null;
  landline1: string | null;
  email: string | null;
}

export interface BuyerTransaction {
  entityName: string;
  /** Normalized buyer track; null when the row is neither landlord nor flipper
   *  (excluded from medians — never guessed). */
  buyerType: BuyerTrack | null;
  propertyAddress: string;
  propertyZip: string;
  /** Per the acquisition-price rule; null = no usable acquisition (excluded). */
  acquisitionPrice: number | null;
  /** Flipper resale (= flipper Most Recent Sale Price); null otherwise. */
  resalePrice: number | null;
  mostRecentDate: string | null;
  contacts: BuyerContacts;
  linkedDealCount: number | null;
  /** Dedup key: entity + property address + most-recent date (idempotency). */
  dedupKey: string;
}

const pos = (v: number | null): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** Parse a price cell ("$46,000", "46000", "", "-") → number | null. Never
 *  coerces an unparseable/empty/zero cell to 0 (that would zero-fill a median). */
export function parsePrice(raw: unknown): number | null {
  if (raw == null) return null;
  const s = String(raw).replace(/[$,\s]/g, "").trim();
  if (s === "" || s === "-" || /^n\/?a$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Normalize the "Buyer Type" cell to a track. Anything that isn't clearly
 *  landlord/flipper → null (the row carries no track and is excluded). */
export function normalizeBuyerType(raw: unknown): BuyerTrack | null {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s === "landlord" || s.startsWith("landlord")) return "landlord";
  if (s === "flipper" || s.startsWith("flipper")) return "flipper";
  return null;
}

/** THE RULE: acquisition price by track. landlord → Most Recent; flipper →
 *  Prior. Null (excluded) for any other track or missing price. */
export function acquisitionPriceOf(
  track: BuyerTrack | null,
  mostRecentSalePrice: number | null,
  priorSalePrice: number | null,
): number | null {
  if (track === "landlord") return pos(mostRecentSalePrice) ? mostRecentSalePrice : null;
  if (track === "flipper") return pos(priorSalePrice) ? priorSalePrice : null;
  return null;
}

/** Flipper Most Recent Sale Price is the RESALE/ARV comp — never an acquisition. */
export function resalePriceOf(track: BuyerTrack | null, mostRecentSalePrice: number | null): number | null {
  return track === "flipper" && pos(mostRecentSalePrice) ? mostRecentSalePrice : null;
}

function s(v: unknown): string {
  return v == null ? "" : String(v).trim();
}
function nonEmpty(v: unknown): string | null {
  const t = s(v);
  return t === "" ? null : t;
}

/** Pull a field tolerantly by any of several header spellings. */
function pick(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (k in row && row[k] != null && String(row[k]).trim() !== "") return row[k];
  }
  return null;
}

/** Pure: one CSV row → a BuyerTransaction (applying the acquisition rule). */
export function rowToTransaction(row: Record<string, unknown>): BuyerTransaction {
  const entityName = s(pick(row, "Entity Name", "Entity_Name")) ||
    [s(pick(row, "First Name", "First_Name")), s(pick(row, "Last Name", "Last_Name"))].filter(Boolean).join(" ");
  const buyerType = normalizeBuyerType(pick(row, "Buyer Type", "Buyer_Type"));
  const propertyAddress = s(pick(row, "Address", "Property Address"));
  const propertyZip = s(pick(row, "Zip", "ZIP", "Property Zip")).slice(0, 5);
  const mostRecent = parsePrice(pick(row, "Most Recent Sale Price", "Most_Recent_Sale_Price"));
  const prior = parsePrice(pick(row, "Prior Sale Price", "Prior_Sale_Price"));
  const mostRecentDate = nonEmpty(pick(row, "Most Recent Sale Date", "Most_Recent_Sale_Date"));

  return {
    entityName,
    buyerType,
    propertyAddress,
    propertyZip,
    acquisitionPrice: acquisitionPriceOf(buyerType, mostRecent, prior),
    resalePrice: resalePriceOf(buyerType, mostRecent),
    mostRecentDate,
    contacts: {
      wireless1: nonEmpty(pick(row, "Wireless 1", "Wireless_1")),
      wireless2: nonEmpty(pick(row, "Wireless 2", "Wireless_2")),
      landline1: nonEmpty(pick(row, "Landline 1", "Landline_1")),
      email: nonEmpty(pick(row, "Beta: Possible Email", "Possible Email", "Email")),
    },
    linkedDealCount: ((): number | null => {
      const n = Number(s(pick(row, "LinkedDeal count", "LinkedDeal Count", "LinkedDeal_count")));
      return Number.isFinite(n) ? n : null;
    })(),
    dedupKey: `${entityName.toLowerCase()}|${propertyAddress.toLowerCase()}|${mostRecentDate ?? ""}`,
  };
}

/** Pure: parse InvestorBase CSV text → BuyerTransaction[]. A parse error on
 *  the whole file throws (caller fail-closes to INSUFFICIENT); individual
 *  malformed rows degrade to null prices (excluded), never fabricated. */
export function parseInvestorBaseCsv(csvText: string): BuyerTransaction[] {
  const parsed = Papa.parse<Record<string, unknown>>(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });
  return (parsed.data ?? [])
    .filter((r) => r && typeof r === "object")
    .map(rowToTransaction)
    .filter((t) => t.propertyZip !== "" || t.acquisitionPrice != null || t.resalePrice != null);
}
