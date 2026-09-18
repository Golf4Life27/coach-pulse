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
// columns/select-option values on the fly when they don't yet exist —
// EXCEPT for a name Airtable doesn't recognize at all, which is a 422, and
// except for a select field, which Airtable will NOT invent new options for
// even with typecast (see normalizePropertyTypeChoices below).
//
// FIELD-NAME MISMATCH FIX (2026-09-18, this bug hunt): the keys below were
// verified against the physical Buyers table (tbl4Rr07vq0mTftZB) tonight.
// Several had drifted from a schema that never existed on the table, which
// made every read come back null and every write a 422. The KEYS are the
// stable API other modules import — only the string VALUES (the actual
// Airtable field names) changed:
//   Name -> "buyer_name", Email -> "buyer_email", Phone_Primary ->
//   "buyer_phone", Entity -> "Company_Name", Markets -> "Preferred_Cities",
//   Target_ZIPs -> "Preferred_Zip_Codes", Property_Type_Preference ->
//   "Preferred_Property_Types", Notes -> "Buyer_Notes" (Buyer_Notes was
//   already its own correct key pointing at the same physical field — both
//   keys intentionally alias the same column now). See
//   lib/buyers-v2-fields.test.ts for the parity test against the physical
//   schema.
export const BUYER_V2_FIELDS = {
  Name: "buyer_name",
  Entity: "Company_Name",
  Email: "buyer_email",
  Phone_Primary: "buyer_phone",
  Phone_Secondary: "Phone_Secondary",
  Buyer_Type: "Buyer_Type",
  Property_Type_Preference: "Preferred_Property_Types",
  Markets: "Preferred_Cities",
  Target_ZIPs: "Preferred_Zip_Codes",
  Min_Price: "Min_Price",
  Max_Price: "Max_Price",
  Min_Beds: "Min_Beds",
  Last_Purchase_Date: "Last_Purchase_Date",
  Last_Purchase_Price: "Last_Purchase_Price",
  Last_Purchase_Address: "Last_Purchase_Address",
  // Pricing-keystone fields (adjudication recXJrM7EYK3pEFmF item 7). These
  // exist on the physical Buyers table (tbl4Rr07vq0mTftZB) but were never
  // mapped — Min_Deal_Spread is the Tier-C margin source.
  Min_Deal_Spread: "Min_Deal_Spread",
  Min_Assignment_Fee_Target: "Min_Assignment_Fee_Target",
  Max_Rehab: "Max_Rehab",
  Preferred_Condition: "Preferred_Condition",
  Proof_of_Funds_On_File: "Proof_of_Funds_On_File",
  POF_Expiry_Date: "POF_Expiry_Date",
  Preferred_States: "Preferred_States",
  Strategy_Type: "Strategy_Type",
  Linked_Deal_Count: "Linked_Deal_Count",
  Buyer_Volume_Tier: "Buyer_Volume_Tier",
  Source: "Source",
  Status: "Status",
  Warmth_Score: "Warmth_Score",
  Email_Sent_At: "Email_Sent_At",
  Email_Opened_At: "Email_Opened_At",
  Form_Completed_At: "Form_Completed_At",
  Last_Engagement_At: "Last_Engagement_At",
  // Notes was pointed at a field name ("Notes") that does not exist on the
  // physical table — the actual long-text notes column is Buyer_Notes,
  // which already had its own (correct) key below. Both keys now alias the
  // SAME physical field on purpose; callers keep using whichever key reads
  // better at the call site.
  Notes: "Buyer_Notes",
  // Buyer_Status (Active/Warm/Inactive/Do Not Contact) is a DIFFERENT column
  // from Status (Cold/Warmed/.../Opted_Out) above — the physical table has
  // both. box-drip.ts and dispo-buyer-replies check/write both.
  Buyer_Status: "Buyer_Status",
  // Dispo buyer-reply ingestion (2026-09-07, lib/dispo/buyer-reply.ts +
  // app/api/cron/dispo-buyer-replies). dispo-trigger stamps the two blast
  // fields the moment a send succeeds — the Gmail thread id is the durable
  // key a reply is matched back by, same role Gmail_Thread_Ids plays for
  // seller threads (lib/inbound/gmail-thread-link.ts), just buyer-scoped.
  // Dispo_Blast_Thread_Id / Dispo_Blast_Listing_Id were CREATED on the
  // physical Buyers table 2026-09-07 (single-line text) alongside this
  // change; Last_Response_At (date) and Buyer_Notes (long text) already
  // existed. Airtable does NOT create unknown fields on write (typecast only
  // coerces values), so a missing field here is a 422 on the stamp and an
  // invalid-formula error on listBuyersWithDispoBlastThread — add it by hand.
  Dispo_Blast_Thread_Id: "Dispo_Blast_Thread_Id",
  Dispo_Blast_Listing_Id: "Dispo_Blast_Listing_Id",
  Last_Response_At: "Last_Response_At",
  Buyer_Notes: "Buyer_Notes",
  // Buy-box drip (2026-09-18, lib/buyers/box-drip.ts + app/api/cron/
  // buyer-box-drip). Both fields created on the physical Buyers table
  // 2026-09-18 — Box_Drip_Step is a number (0-3), Box_Drip_Last_At an ISO
  // dateTime.
  Box_Drip_Step: "Box_Drip_Step",
  Box_Drip_Last_At: "Box_Drip_Last_At",
  // Reply-ingestion key for the drip (2026-09-18, app/api/cron/
  // dispo-buyer-replies), same role Dispo_Blast_Thread_Id plays for blast
  // replies — the box-drip cron stamps this on a successful send.
  Box_Drip_Thread_Id: "Box_Drip_Thread_Id",
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
  // A multipleSelects field comes back as an array; a multilineText field
  // (Preferred_Cities is free text like "Memphis, Millington, DeSoto County
  // MS") comes back as one string — split it on commas/newlines so callers
  // get the same string[] shape either way.
  if (typeof v === "string" && v.trim()) {
    const parts = v
      .split(/[,\n]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return parts.length > 0 ? parts : null;
  }
  return null;
}

/** Preferred_Property_Types choice list, exactly as configured on the
 *  physical Buyers table (verified 2026-09-18). Airtable's typecast=true
 *  does NOT invent new options for a select field the way it invents new
 *  columns — an unrecognized value here is a 422, not a soft accept. */
export const PREFERRED_PROPERTY_TYPE_CHOICES = [
  "Single Family",
  "Single Family Residential",
  "Duplex",
  "Triplex",
  "Quadplex",
  "Townhouse",
  "Condo",
  "SFR",
  "Land / Teardown",
] as const;

/** Filters `values` down to the choices Airtable will actually accept for
 *  Preferred_Property_Types (case-insensitive match, canonical spelling in
 *  the result). Anything that doesn't match a choice comes back in
 *  `dropped` instead of blowing up the whole write — callers fold `dropped`
 *  into Notes so the information isn't silently lost. */
export function normalizePropertyTypeChoices(
  values: string[] | null | undefined,
): { kept: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const v of values ?? []) {
    const match = PREFERRED_PROPERTY_TYPE_CHOICES.find((c) => c.toLowerCase() === v.trim().toLowerCase());
    if (match) kept.push(match);
    else dropped.push(v);
  }
  return { kept, dropped };
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
    minDealSpread: asNumber(f[BUYER_V2_FIELDS.Min_Deal_Spread]),
    minAssignmentFeeTarget: asNumber(f[BUYER_V2_FIELDS.Min_Assignment_Fee_Target]),
    maxRehab: asNumber(f[BUYER_V2_FIELDS.Max_Rehab]),
    preferredCondition: asStringArray(f[BUYER_V2_FIELDS.Preferred_Condition]),
    pofOnFile: f[BUYER_V2_FIELDS.Proof_of_Funds_On_File] === true,
    pofExpiryDate: asString(f[BUYER_V2_FIELDS.POF_Expiry_Date]),
    preferredStates: asString(f[BUYER_V2_FIELDS.Preferred_States]),
    strategyType: asStringArray(f[BUYER_V2_FIELDS.Strategy_Type]),
    emailSentAt: asString(f[BUYER_V2_FIELDS.Email_Sent_At]),
    emailOpenedAt: asString(f[BUYER_V2_FIELDS.Email_Opened_At]),
    formCompletedAt: asString(f[BUYER_V2_FIELDS.Form_Completed_At]),
    lastEngagementAt: asString(f[BUYER_V2_FIELDS.Last_Engagement_At]),
    notes: asString(f[BUYER_V2_FIELDS.Notes]),
    buyerStatus: asString(f[BUYER_V2_FIELDS.Buyer_Status]),
    dispoBlastThreadId: asString(f[BUYER_V2_FIELDS.Dispo_Blast_Thread_Id]),
    dispoBlastListingId: asString(f[BUYER_V2_FIELDS.Dispo_Blast_Listing_Id]),
    lastResponseAt: asString(f[BUYER_V2_FIELDS.Last_Response_At]),
    buyerNotes: asString(f[BUYER_V2_FIELDS.Buyer_Notes]),
    boxDripStep: asNumber(f[BUYER_V2_FIELDS.Box_Drip_Step]),
    boxDripLastAt: asString(f[BUYER_V2_FIELDS.Box_Drip_Last_At]),
    boxDripThreadId: asString(f[BUYER_V2_FIELDS.Box_Drip_Thread_Id]),
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

/** Buyers with a dispo blast thread on record — the population the reply
 *  cron (app/api/cron/dispo-buyer-replies) polls. Small by construction:
 *  only buyers who were actually blasted, ever. */
export async function listBuyersWithDispoBlastThread(): Promise<BuyerRecord[]> {
  const formula = `{${BUYER_V2_FIELDS.Dispo_Blast_Thread_Id}}!=''`;
  return listBuyersV2({ filterByFormula: formula });
}

/** Buyers with a box-drip thread on record — the population the reply cron
 *  (app/api/cron/dispo-buyer-replies) polls for STOP/reply on the drip,
 *  same shape as listBuyersWithDispoBlastThread above. Small by
 *  construction: only buyers a drip email was actually sent to. */
export async function listBuyersWithBoxDripThread(): Promise<BuyerRecord[]> {
  const formula = `{${BUYER_V2_FIELDS.Box_Drip_Thread_Id}}!=''`;
  return listBuyersV2({ filterByFormula: formula });
}

export async function findBuyerByEmail(email: string): Promise<BuyerRecord | null> {
  if (!email.trim()) return null;
  const escaped = email.replace(/'/g, "\\'");
  const formula = `LOWER({${BUYER_V2_FIELDS.Email}})='${escaped.toLowerCase()}'`;
  const list = await listBuyersV2({ filterByFormula: formula, maxRecords: 1 });
  return list[0] ?? null;
}

/** Digits-only phone, US-normalized to 10 digits (drops a leading country
 *  "1"). null for anything that can't be a real number — the identity key
 *  for a no-email buyer, so junk must resolve to null, never a false match. */
export function normalizePhone(raw: string | null | undefined): string | null {
  const d = String(raw ?? "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) return d.slice(1);
  if (d.length === 10) return d;
  if (d.length > 11) return d.slice(-10);
  return null;
}

/** Dedup fallback for buyers with a phone but no email (the dispo lane keeps
 *  them — operator ruling 2026-07-20). Matches the stored Phone_Primary,
 *  which InvestorBase writes as bare digits. */
export async function findBuyerByPhone(phone: string): Promise<BuyerRecord | null> {
  const p = normalizePhone(phone);
  if (!p) return null;
  const formula = `{${BUYER_V2_FIELDS.Phone_Primary}}='${p}'`;
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
