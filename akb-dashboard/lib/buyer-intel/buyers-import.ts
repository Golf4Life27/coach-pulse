// InvestorBase CSV → persistent Buyers table (the dispo rolodex).
// @agent: appraiser/dispo
//
// ONE code path, two callers (operator "Go" 2026-07-20): the nightly
// /api/buyers/import-csv route AND the per-deal Deal Docs drop both funnel
// through here, so there is never a second divergent buyer parser (the exact
// class of bug the buyer-median ruling just killed).
//
// Every InvestorBase pull is a list of cash buyers who bought NEAR a subject —
// the warmest dispo list money can assemble. This module accumulates those
// contacts into the durable Buyers table (tbl4Rr07vq0mTftZB), segmented by
// market / buyer type / price / warmth, deduped so one buyer across ten deals
// is one row.
//
// DISPO IDENTITY RULE (operator 2026-07-20): a buyer with a phone but no email
// is still a dispo target — KEEP it (dedup by phone). Only a row with NO
// contact channel at all is skipped. Idempotent: re-dropping the same export
// updates, never double-creates (dedup by email → phone, in-file + vs store).

import Papa from "papaparse";
import {
  BUYER_V2_FIELDS,
  batchUpsertBuyers,
  findBuyerByEmail,
  findBuyerByPhone,
  inferMarketsFromCity,
  inferVolumeTier,
  normalizePhone,
} from "@/lib/buyers-v2";

// InvestorBase-flavored column → Buyers field-name normalization. Several
// alias forms because IB exports vary. `_`-prefixed targets are assembled
// (name halves, city/state) rather than written verbatim.
const COLUMN_ALIASES: Record<string, string> = {
  "Entity Name": "Entity",
  "Company": "Entity",
  "First Name": "_first",
  "Last Name": "_last",
  "Name": "Name",
  "Buyer Name": "Name",
  "Buyer Type": "Buyer_Type",
  "Type": "Buyer_Type",
  "Property Type": "Property_Type_Preference",
  "Wireless 1": "Phone_Primary",
  "Wireless 2": "Phone_Secondary",
  "Landline 1": "Phone_Secondary",
  "Phone 1": "Phone_Primary",
  "Phone 2": "Phone_Secondary",
  "Phone": "Phone_Primary",
  "Email": "Email",
  "Beta: Possible Email": "Email",
  "E-Mail": "Email",
  "Address": "_streetAddress",
  "Street Address": "_streetAddress",
  "City": "_city",
  "State": "_state",
  "Zip": "_zip",
  "Most Recent Sale Date": "Last_Purchase_Date",
  "Last Sale Date": "Last_Purchase_Date",
  "Most Recent Sale Price": "Last_Purchase_Price",
  "Last Sale Price": "Last_Purchase_Price",
  "Most Recent Sale Address": "Last_Purchase_Address",
  "LinkedDeal count": "Linked_Deal_Count",
  "Linked Deals": "Linked_Deal_Count",
  "Min Price": "Min_Price",
  "Max Price": "Max_Price",
};

function parseNumber(v: string): number | null {
  if (!v) return null;
  const cleaned = v.replace(/[^0-9.\-]/g, "");
  if (!cleaned) return null;
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

export function normalizeBuyerType(raw: string): string {
  const v = raw.toLowerCase().trim();
  if (!v) return "unknown";
  if (v.includes("flip")) return "flipper";
  if (v.includes("landlord") || v.includes("rental") || v.includes("buy and hold")) return "landlord";
  if (v.includes("wholesale")) return "wholesaler";
  if (v.includes("owner")) return "owner-occupant";
  return "unknown";
}

export function normalizePropertyType(raw: string): string[] {
  const v = raw.toLowerCase();
  const out: string[] = [];
  if (v.includes("multi") || v.includes("duplex") || v.includes("triplex") || v.includes("fourplex")) {
    out.push("Multi Family");
  }
  if (v.includes("single") || v.includes("sfr")) out.push("Single Family");
  if (v.includes("mixed")) out.push("Mixed");
  if (v.includes("land") || v.includes("lot")) out.push("Land");
  return out.length > 0 ? out : ["Single Family"];
}

export interface BuyerImportRow {
  /** Lowercased email, or null. */
  email: string | null;
  /** Normalized 10-digit phone, or null. */
  phone: string | null;
  fields: Record<string, unknown>;
}

export interface BuyerImportResult {
  /** Raw parsed data rows (before skip/dedup). */
  total: number;
  created: number;
  updated: number;
  /** Rows dropped for no contact channel + collapsed in-file duplicates. */
  skipped: number;
  errors: Array<{ row: number; reason: string }>;
}

/** Pure: InvestorBase CSV text → upsert-ready rows. Skips no-contact rows and
 *  collapses in-file duplicates (same email, else same phone) — last wins, so
 *  a re-export's freshest contacts survive. */
export function investorBaseCsvToImportRows(csvText: string): {
  rows: BuyerImportRow[];
  rawCount: number;
  skipped: number;
  parseError?: string;
} {
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h: string) => h.trim(),
  });
  if (parsed.errors.length > 0 && parsed.data.length === 0) {
    return { rows: [], rawCount: 0, skipped: 0, parseError: parsed.errors.slice(0, 3).map((e) => e.message).join("; ") };
  }

  const rawRows = parsed.data;
  // In-file dedup: identity = email ?? phone ?? entity|name. Last wins.
  const byIdentity = new Map<string, BuyerImportRow>();
  let skipped = 0;

  for (const raw of rawRows) {
    const norm: Record<string, string> = {};
    let firstName = "";
    let lastName = "";
    let city = "";
    let state = "";
    for (const [csvCol, value] of Object.entries(raw)) {
      const trimmed = (value ?? "").trim();
      const target = COLUMN_ALIASES[csvCol];
      if (!target) continue;
      if (target === "_first") firstName = trimmed;
      else if (target === "_last") lastName = trimmed;
      else if (target === "_city") city = trimmed;
      else if (target === "_state") state = trimmed;
      else if (target === "_streetAddress") norm.Last_Purchase_Address = norm.Last_Purchase_Address || trimmed;
      else if (target === "_zip") { /* zip not a Buyers field; used only for market inference upstream */ }
      // Do not clobber a populated alias with a later empty one (e.g. two
      // phone columns where the second is blank).
      else if (!norm[target] || trimmed) norm[target] = norm[target] && !trimmed ? norm[target] : trimmed;
    }

    const email = (norm.Email ?? "").toLowerCase().trim() || null;
    const phone = normalizePhone(norm.Phone_Primary ?? "") ?? normalizePhone(norm.Phone_Secondary ?? "");
    const entity = norm.Entity || null;
    const fullName = norm.Name && norm.Name.trim() ? norm.Name.trim() : `${firstName} ${lastName}`.trim();

    // DISPO IDENTITY RULE: no email AND no phone → uncontactable → skip.
    if (!email && !phone) {
      skipped++;
      continue;
    }

    const linkedDealCount = parseNumber(norm.Linked_Deal_Count ?? "");
    const fields: Record<string, unknown> = {
      [BUYER_V2_FIELDS.Name]: fullName || email || phone,
      [BUYER_V2_FIELDS.Entity]: entity,
      [BUYER_V2_FIELDS.Email]: email,
      [BUYER_V2_FIELDS.Phone_Primary]: norm.Phone_Primary || null,
      [BUYER_V2_FIELDS.Phone_Secondary]: norm.Phone_Secondary || null,
      [BUYER_V2_FIELDS.Buyer_Type]: norm.Buyer_Type ? normalizeBuyerType(norm.Buyer_Type) : "unknown",
      [BUYER_V2_FIELDS.Property_Type_Preference]: norm.Property_Type_Preference
        ? normalizePropertyType(norm.Property_Type_Preference)
        : null,
      [BUYER_V2_FIELDS.Markets]: inferMarketsFromCity(city, state),
      [BUYER_V2_FIELDS.Last_Purchase_Date]: norm.Last_Purchase_Date || null,
      [BUYER_V2_FIELDS.Last_Purchase_Price]: parseNumber(norm.Last_Purchase_Price ?? ""),
      [BUYER_V2_FIELDS.Last_Purchase_Address]: norm.Last_Purchase_Address || null,
      [BUYER_V2_FIELDS.Linked_Deal_Count]: linkedDealCount,
      [BUYER_V2_FIELDS.Buyer_Volume_Tier]: inferVolumeTier(linkedDealCount),
      [BUYER_V2_FIELDS.Min_Price]: parseNumber(norm.Min_Price ?? ""),
      [BUYER_V2_FIELDS.Max_Price]: parseNumber(norm.Max_Price ?? ""),
      [BUYER_V2_FIELDS.Source]: "InvestorBase",
    };

    const identity = email ?? phone ?? `${entity ?? ""}|${fullName}`.toLowerCase();
    if (byIdentity.has(identity)) skipped++; // collapsed in-file dupe
    byIdentity.set(identity, { email, phone, fields });
  }

  return { rows: [...byIdentity.values()], rawCount: rawRows.length, skipped };
}

/** Resolve each row against the store (email → phone) and upsert. Batched
 *  concurrency (5) so a 500-buyer nightly stays inside the lambda budget. A
 *  per-row lookup error degrades that row (recorded), never the whole import. */
export async function resolveAndUpsertBuyers(rows: BuyerImportRow[]): Promise<{ created: number; updated: number; errors: Array<{ row: number; reason: string }> }> {
  const errors: Array<{ row: number; reason: string }> = [];
  const dedup: Array<{ id?: string; fields: Record<string, unknown> }> = [];
  const BATCH = 5;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const resolved = await Promise.all(
      slice.map(async (row, j) => {
        try {
          let existing = row.email ? await findBuyerByEmail(row.email) : null;
          if (!existing && row.phone) existing = await findBuyerByPhone(row.phone);
          if (existing) {
            // Update — never clobber Source/Status/warmth on an existing buyer.
            const { [BUYER_V2_FIELDS.Source]: _src, ...updateFields } = row.fields;
            void _src;
            return { id: existing.id, fields: updateFields };
          }
          return { fields: { ...row.fields, [BUYER_V2_FIELDS.Status]: "Cold" } };
        } catch (err) {
          errors.push({ row: i + j, reason: err instanceof Error ? err.message : String(err) });
          return null;
        }
      }),
    );
    for (const r of resolved) if (r) dedup.push(r);
  }
  const { created, updated } = await batchUpsertBuyers(dedup);
  return { created, updated, errors };
}

/** Top-level: InvestorBase CSV text → accumulated into the Buyers table. */
export async function importInvestorBaseBuyers(csvText: string): Promise<BuyerImportResult> {
  const { rows, rawCount, skipped, parseError } = investorBaseCsvToImportRows(csvText);
  if (parseError) {
    return { total: 0, created: 0, updated: 0, skipped: 0, errors: [{ row: -1, reason: `csv_parse_failed: ${parseError}` }] };
  }
  const { created, updated, errors } = await resolveAndUpsertBuyers(rows);
  return { total: rawCount, created, updated, skipped, errors };
}
