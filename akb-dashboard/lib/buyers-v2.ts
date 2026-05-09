// Phase 2 Buyers data layer.
//
// We operate on the existing Buyers table (tbl4Rr07vq0mTftZB) but use
// field NAMES with typecast=true so Airtable will accept (and on write,
// create) the rich Phase 2 schema described in JARVIS_PHASE1_SPEC.md.
//
// This is intentionally separate from lib/airtable.getBuyers() which
// returns the legacy field-id-mapped Buyer shape used by the existing
// /api/buyers endpoint and the legacy buyers page. Both can co-exist
// against the same physical table.

import type { BuyerRecord, BuyerStatus, BuyerType, BuyerVolumeTier, BuyerSource } from "@/types/jarvis";

const AIRTABLE_PAT = process.env.AIRTABLE_PAT!;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
const BUYERS_TABLE = "tbl4Rr07vq0mTftZB";

// Phase 2 field names. typecast=true on writes allows Airtable to create
// columns/select-option values on the fly when they don't yet exist.
export const BUYER_V2_FIELDS = {
  Name: "Name",
  Entity: "Entity",
  Email: "Email",
  Phone_Primary: "Phone_Primary",
  Phone_Secondary: "Phone_Secondary",
  Buyer_Type: "Buyer_Type",
  Property_Type_Preference: "Property_Type_Preference",
  Markets: "Markets",
  Target_ZIPs: "Target_ZIPs",
  Min_Price: "Min_Price",
  Max_Price: "Max_Price",
  Min_Beds: "Min_Beds",
  Last_Purchase_Date: "Last_Purchase_Date",
  Last_Purchase_Price: "Last_Purchase_Price",
  Last_Purchase_Address: "Last_Purchase_Address",
  Linked_Deal_Count: "Linked_Deal_Count",
  Buyer_Volume_Tier: "Buyer_Volume_Tier",
  Source: "Source",
  Status: "Status",
  Warmth_Score: "Warmth_Score",
  Email_Sent_At: "Email_Sent_At",
  Email_Opened_At: "Email_Opened_At",
  Form_Completed_At: "Form_Completed_At",
  Last_Engagement_At: "Last_Engagement_At",
  Notes: "Notes",
} as const;

function asString(v: unknown): string | null {
  if (typeof v === "string" && v.trim().length > 0) return v;
  return null;
}
function asNumber(v: unknown): number | null {
  if (typeof v === "number" && !isNaN(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
  }
  return null;
}
function asStringArray(v: unknown): string[] | null {
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string");
  if (typeof v === "string" && v.trim()) return [v];
  return null;
}

function mapRecord(record: { id: string; fields: Record<string, unknown> }): BuyerRecord {
  const f = record.fields;
  return {
    id: record.id,
    name: asString(f[BUYER_V2_FIELDS.Name]) ?? "",
    entity: asString(f[BUYER_V2_FIELDS.Entity]),
    email: asString(f[BUYER_V2_FIELDS.Email]),
    phonePrimary: asString(f[BUYER_V2_FIELDS.Phone_Primary]),
    phoneSecondary: asString(f[BUYER_V2_FIELDS.Phone_Secondary]),
    buyerType: (asString(f[BUYER_V2_FIELDS.Buyer_Type]) as BuyerType | null) ?? null,
    propertyTypePreference: asStringArray(f[BUYER_V2_FIELDS.Property_Type_Preference]),
    markets: asStringArray(f[BUYER_V2_FIELDS.Markets]),
    targetZips: asString(f[BUYER_V2_FIELDS.Target_ZIPs]),
    minPrice: asNumber(f[BUYER_V2_FIELDS.Min_Price]),
    maxPrice: asNumber(f[BUYER_V2_FIELDS.Max_Price]),
    minBeds: asNumber(f[BUYER_V2_FIELDS.Min_Beds]),
    lastPurchaseDate: asString(f[BUYER_V2_FIELDS.Last_Purchase_Date]),
    lastPurchasePrice: asNumber(f[BUYER_V2_FIELDS.Last_Purchase_Price]),
    lastPurchaseAddress: asString(f[BUYER_V2_FIELDS.Last_Purchase_Address]),
    linkedDealCount: asNumber(f[BUYER_V2_FIELDS.Linked_Deal_Count]),
    buyerVolumeTier: (asString(f[BUYER_V2_FIELDS.Buyer_Volume_Tier]) as BuyerVolumeTier | null) ?? null,
    source: (asString(f[BUYER_V2_FIELDS.Source]) as BuyerSource | null) ?? null,
    status: (asString(f[BUYER_V2_FIELDS.Status]) as BuyerStatus | null) ?? null,
    warmthScore: asNumber(f[BUYER_V2_FIELDS.Warmth_Score]),
    emailSentAt: asString(f[BUYER_V2_FIELDS.Email_Sent_At]),
    emailOpenedAt: asString(f[BUYER_V2_FIELDS.Email_Opened_At]),
    formCompletedAt: asString(f[BUYER_V2_FIELDS.Form_Completed_At]),
    lastEngagementAt: asString(f[BUYER_V2_FIELDS.Last_Engagement_At]),
    notes: asString(f[BUYER_V2_FIELDS.Notes]),
  };
}

interface ListOpts {
  filterByFormula?: string;
  pageSize?: number;
  maxRecords?: number;
}

export async function listBuyersV2(opts: ListOpts = {}): Promise<BuyerRecord[]> {
  const all: BuyerRecord[] = [];
  let offset: string | undefined;
  do {
    const params = new URLSearchParams();
    if (opts.filterByFormula) params.set("filterByFormula", opts.filterByFormula);
    if (opts.pageSize) params.set("pageSize", String(opts.pageSize));
    if (offset) params.set("offset", offset);
    const url = `https://api.airtable.com/v0/${BASE_ID}/${BUYERS_TABLE}?${params.toString()}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${AIRTABLE_PAT}` },
      cache: "no-store",
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Airtable buyers list ${res.status}: ${errText}`);
    }
    const data = (await res.json()) as { records: Array<{ id: string; fields: Record<string, unknown> }>; offset?: string };
    for (const rec of data.records) {
      all.push(mapRecord(rec));
      if (opts.maxRecords && all.length >= opts.maxRecords) return all;
    }
    offset = data.offset;
  } while (offset);
  return all;
}

export async function getBuyerV2(id: string): Promise<BuyerRecord | null> {
  const url = `https://api.airtable.com/v0/${BASE_ID}/${BUYERS_TABLE}/${id}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${AIRTABLE_PAT}` },
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Airtable buyer get ${res.status}: ${errText}`);
  }
  const data = (await res.json()) as { id: string; fields: Record<string, unknown> };
  return mapRecord(data);
}

export async function findBuyerByEmail(email: string): Promise<BuyerRecord | null> {
  if (!email.trim()) return null;
  const escaped = email.replace(/'/g, "\\'");
  const formula = `LOWER({${BUYER_V2_FIELDS.Email}})='${escaped.toLowerCase()}'`;
  const list = await listBuyersV2({ filterByFormula: formula, maxRecords: 1 });
  return list[0] ?? null;
}

export async function createBuyerV2(fields: Record<string, unknown>): Promise<string> {
  const url = `https://api.airtable.com/v0/${BASE_ID}/${BUYERS_TABLE}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${AIRTABLE_PAT}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields, typecast: true }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Airtable buyer create ${res.status}: ${errText}`);
  }
  const data = (await res.json()) as { id: string };
  return data.id;
}

export async function updateBuyerV2(id: string, fields: Record<string, unknown>): Promise<void> {
  const url = `https://api.airtable.com/v0/${BASE_ID}/${BUYERS_TABLE}/${id}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${AIRTABLE_PAT}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields, typecast: true }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Airtable buyer update ${res.status}: ${errText}`);
  }
}

export async function batchUpsertBuyers(
  items: Array<{ id?: string; fields: Record<string, unknown> }>,
): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;

  // Updates one-at-a-time (simpler, n is small for nightly imports of 110-500).
  for (const item of items) {
    if (item.id) {
      await updateBuyerV2(item.id, item.fields);
      updated += 1;
    } else {
      await createBuyerV2(item.fields);
      created += 1;
    }
  }
  return { created, updated };
}

export function inferVolumeTier(linkedDealCount: number | null): BuyerVolumeTier {
  if (linkedDealCount == null) return "C";
  if (linkedDealCount > 100) return "A";
  if (linkedDealCount >= 10) return "B";
  return "C";
}

export function inferMarketsFromCity(city: string | null, state: string | null): string[] {
  const lc = (city ?? "").toLowerCase();
  const lst = (state ?? "").toUpperCase();
  const markets = new Set<string>();
  if (lc.includes("detroit") || lst === "MI") markets.add("Detroit");
  if (lc.includes("san antonio")) markets.add("San Antonio");
  if (lc.includes("dallas") || lc.includes("fort worth")) markets.add("Dallas");
  if (lc.includes("houston")) markets.add("Houston");
  if (lc.includes("memphis")) markets.add("Memphis");
  if (lc.includes("atlanta")) markets.add("Atlanta");
  if (markets.size === 0) markets.add("Other");
  return Array.from(markets);
}
