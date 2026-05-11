import { NextResponse } from "next/server";
import Papa from "papaparse";
import {
  batchUpsertBuyers,
  findBuyerByEmail,
  inferMarketsFromCity,
  inferVolumeTier,
  BUYER_V2_FIELDS,
} from "@/lib/buyers-v2";

export const runtime = "nodejs";
export const maxDuration = 120;

// InvestorBase-flavored column → Buyers field-name normalization.
// We accept several alias forms because IB exports vary.
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
  "Phone 1": "Phone_Primary",
  "Phone 2": "Phone_Secondary",
  "Phone": "Phone_Primary",
  "Email": "Email",
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

function normalizeBuyerType(raw: string): string {
  const v = raw.toLowerCase().trim();
  if (!v) return "unknown";
  if (v.includes("flip")) return "flipper";
  if (v.includes("landlord") || v.includes("rental") || v.includes("buy and hold")) return "landlord";
  if (v.includes("wholesale")) return "wholesaler";
  if (v.includes("owner")) return "owner-occupant";
  return "unknown";
}

function normalizePropertyType(raw: string): string[] {
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

interface ImportRow {
  email: string;
  fields: Record<string, unknown>;
}

export async function POST(req: Request) {
  let csvText: string;
  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("multipart/form-data")) {
    try {
      const formData = await req.formData();
      const file = formData.get("file");
      if (!file || typeof file === "string") {
        return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
      }
      csvText = await (file as Blob).text();
    } catch (err) {
      return NextResponse.json({ error: "Failed to read upload", detail: String(err) }, { status: 400 });
    }
  } else {
    csvText = await req.text();
  }

  if (!csvText.trim()) {
    return NextResponse.json({ error: "Empty CSV" }, { status: 400 });
  }

  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h: string) => h.trim(),
  });
  if (parsed.errors.length > 0 && parsed.data.length === 0) {
    return NextResponse.json(
      { error: "CSV parse failed", details: parsed.errors.slice(0, 5) },
      { status: 400 },
    );
  }

  const rows = parsed.data;
  const importRows: ImportRow[] = [];
  const errors: Array<{ row: number; reason: string }> = [];
  let skipped = 0;

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
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
      else norm[target] = trimmed;
    }

    const email = (norm.Email ?? "").toLowerCase().trim();
    if (!email) { skipped++; continue; }

    const fullName = (norm.Name && norm.Name.trim().length > 0)
      ? norm.Name.trim()
      : `${firstName} ${lastName}`.trim();

    const linkedDealCount = parseNumber(norm.Linked_Deal_Count ?? "");
    const fields: Record<string, unknown> = {
      [BUYER_V2_FIELDS.Name]: fullName || email,
      [BUYER_V2_FIELDS.Entity]: norm.Entity || null,
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

    importRows.push({ email, fields });
  }

  // Dedup by email; resolve existing record IDs concurrently in batches of 5.
  const dedupResults: Array<{ id?: string; fields: Record<string, unknown> }> = [];
  const BATCH = 5;
  for (let i = 0; i < importRows.length; i += BATCH) {
    const slice = importRows.slice(i, i + BATCH);
    const resolved = await Promise.all(
      slice.map(async (row) => {
        try {
          const existing = await findBuyerByEmail(row.email);
          if (existing) {
            // Update — preserve Status/warmth + don't clobber lastEngagementAt.
            const { [BUYER_V2_FIELDS.Source]: _src, ...updateFields } = row.fields;
            void _src;
            return { id: existing.id, fields: updateFields };
          }
          return { fields: { ...row.fields, [BUYER_V2_FIELDS.Status]: "Cold" } };
        } catch (err) {
          errors.push({ row: i, reason: String(err) });
          return null;
        }
      }),
    );
    for (const r of resolved) if (r) dedupResults.push(r);
  }

  let createdCount = 0;
  let updatedCount = 0;
  try {
    const result = await batchUpsertBuyers(dedupResults);
    createdCount = result.created;
    updatedCount = result.updated;
  } catch (err) {
    return NextResponse.json(
      { error: "Airtable upsert failed", detail: String(err), parsed: dedupResults.length },
      { status: 502 },
    );
  }

  return NextResponse.json({
    total: rows.length,
    created: createdCount,
    updated: updatedCount,
    skipped,
    errors,
  });
}
