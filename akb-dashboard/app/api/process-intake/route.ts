import Papa from "papaparse";

export const runtime = "nodejs";
export const maxDuration = 60;

const AIRTABLE_PAT = process.env.AIRTABLE_PAT!;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
const LISTINGS_TABLE = "tbldMjKBgPiq45Jjs";
const AIRTABLE_BATCH_SIZE = 10;

// Field IDs for writing new records
// IDs confirmed from existing codebase + spec
const FIELD_MAP: Record<string, string> = {
  Address: "fldwvp72hKTfiHHjj",
  City: "fldjbiNuHXzPzVWFk",
  State: "fldSlDQvgCyr0J8tI",
  Zip: "fld9PTaKkgBNtvWbB",
  List_Price: "fld9J3Vi9fTq3zzMU",
  Agent_Name: "fld69oB0no6tfguom",
  Agent_Phone: "fldee9MOstjNDKjnm",
  Agent_Email: "fldzdck2fhd6DZ3Oq",
  Bedrooms: "fld5GBaHtwvLY3sq8",
  Bathrooms: "fldvZ8hU1aREVg3Gs",
  Building_SqFt: "fld5bKGJLlN7GmiE9",
  Execution_Path: "fldOrWvqKcc1g6Lka",
  Notes: "fldwKGxZly6O8qyPu",
  Restriction_Text: "fldapf2ZXpIWTZfSX",
};

// PropStream CSV column → Airtable field name
const CSV_COLUMN_MAP: Record<string, string> = {
  "Address": "Address",
  "City": "City",
  "State": "State",
  "Zip": "Zip",
  "Zip Code": "Zip",
  "MLS Amount": "List_Price",
  "MLS List Amount": "List_Price",
  "List Price": "List_Price",
  "MLS Agent Name": "Agent_Name",
  "Agent Name": "Agent_Name",
  "MLS Agent Phone": "Agent_Phone",
  "Agent Phone": "Agent_Phone",
  "MLS Agent E-Mail": "Agent_Email",
  "MLS Agent Email": "Agent_Email",
  "Agent Email": "Agent_Email",
  "Bedrooms": "Bedrooms",
  "Total Bathrooms": "Bathrooms",
  "Bathrooms": "Bathrooms",
  "Building Sqft": "Building_SqFt",
  "Building SqFt": "Building_SqFt",
};

// --- Address normalization ---

function normalizeAddress(addr: string): string {
  return addr.trim().toUpperCase().replace(/\s*(APT|UNIT|STE|#)\s*\S*/i, "");
}

function buildDedupeKey(address: string, zip: string, state: string): string {
  return `${normalizeAddress(address)}|${(zip || "").trim()}|${(state || "").trim().toUpperCase()}`;
}

// --- Filters (per Scenario A logic) ---

const VALID_CONDITIONS = new Set(["poor", "disrepair", "average"]);
const MIN_PRICE = 3500;
const MAX_PRICE = 250000;

interface FilterResult {
  pass: boolean;
  reason: string | null;
}

function applyFilters(row: Record<string, string>): FilterResult {
  const price = parseFloat(row.List_Price || "0");
  if (price < MIN_PRICE || price > MAX_PRICE) {
    return { pass: false, reason: `Price $${price.toLocaleString()} outside range $${MIN_PRICE.toLocaleString()}–$${MAX_PRICE.toLocaleString()}` };
  }

  const phone = row.Agent_Phone || "";
  if (!/\d/.test(phone)) {
    return { pass: false, reason: "No agent phone number" };
  }

  // Condition filter is optional — only reject if condition is explicitly bad
  // PropStream doesn't always include condition, so missing = pass
  const condition = (row.Condition || "").trim().toLowerCase();
  if (condition && !VALID_CONDITIONS.has(condition) && condition !== "") {
    // Only reject for explicitly good conditions (excellent, good, etc.)
    const goodConditions = new Set(["excellent", "good", "very good"]);
    if (goodConditions.has(condition)) {
      return { pass: false, reason: `Condition "${condition}" not distressed` };
    }
  }

  return { pass: true, reason: null };
}

// --- Airtable helpers ---

async function fetchExistingDedupeKeys(): Promise<Set<string>> {
  const keys = new Set<string>();
  let offset: string | undefined;

  do {
    const params = new URLSearchParams();
    params.append("fields[]", "fldwvp72hKTfiHHjj"); // address
    params.append("fields[]", "fld9PTaKkgBNtvWbB");  // zip
    params.append("fields[]", "fldSlDQvgCyr0J8tI");  // state
    params.set("returnFieldsByFieldId", "true");
    if (offset) params.set("offset", offset);

    const res = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/${LISTINGS_TABLE}?${params.toString()}`,
      {
        headers: { Authorization: `Bearer ${AIRTABLE_PAT}` },
        cache: "no-store",
      }
    );
    if (!res.ok) break;

    const data = await res.json();
    for (const rec of data.records) {
      const f = rec.fields as Record<string, unknown>;
      const addr = (f.fldwvp72hKTfiHHjj as string) ?? "";
      const zip = (f.fld9PTaKkgBNtvWbB as string) ?? "";
      const state = (f.fldSlDQvgCyr0J8tI as string) ?? "";
      if (addr) keys.add(buildDedupeKey(addr, zip, state));
    }
    offset = data.offset;
  } while (offset);

  return keys;
}

async function batchCreateRecords(
  records: Array<{ fields: Record<string, unknown> }>
): Promise<{ created: number; ids: string[] }> {
  let created = 0;
  const ids: string[] = [];
  for (let i = 0; i < records.length; i += AIRTABLE_BATCH_SIZE) {
    const batch = records.slice(i, i + AIRTABLE_BATCH_SIZE);
    const res = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/${LISTINGS_TABLE}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${AIRTABLE_PAT}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ records: batch, typecast: true }),
      }
    );
    if (res.ok) {
      const data = (await res.json()) as { records?: Array<{ id: string }> };
      for (const r of data.records ?? []) ids.push(r.id);
      created += batch.length;
    } else {
      const errText = await res.text();
      console.error(`[process-intake] Batch create failed:`, errText);
    }
  }
  return { created, ids };
}

async function chainPreOfferScreen(origin: string, cookie: string, recordIds: string[]): Promise<void> {
  // Fire-and-forget: photo-analysis → arv-validate → pre-offer-screen for
  // each newly created auto-proceed record. Best-effort; failures are
  // logged but don't block the intake response.
  await Promise.all(
    recordIds.map(async (id) => {
      try {
        const headers: Record<string, string> = {};
        if (cookie) headers.cookie = cookie;
        const photo = await fetch(`${origin}/api/photo-analysis/${id}`, { headers, cache: "no-store" });
        if (!photo.ok) return;
        const arv = await fetch(`${origin}/api/arv-validate/${id}`, { headers, cache: "no-store" });
        if (!arv.ok) return;
        const screen = await fetch(`${origin}/api/pre-offer-screen/${id}`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        if (!screen.ok) return;
        const result = (await screen.json()) as { passed: boolean; blockers: Array<{ check: string; reason: string }> };
        if (!result.passed) {
          // Move record to Manual Review
          await fetch(`https://api.airtable.com/v0/${BASE_ID}/${LISTINGS_TABLE}/${id}`, {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${AIRTABLE_PAT}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              fields: {
                Outreach_Status: "Manual Review",
              },
              typecast: true,
            }),
          });
        }
      } catch (err) {
        console.error(`[process-intake] Chain failed for ${id}:`, err);
      }
    }),
  );
}

// --- Main handler ---

export async function POST(req: Request) {
  if (!AIRTABLE_PAT) {
    return Response.json({ error: "AIRTABLE_PAT not set" }, { status: 500 });
  }

  // Parse multipart/form-data or raw CSV text
  let csvText: string;

  const contentType = req.headers.get("content-type") || "";

  if (contentType.includes("multipart/form-data")) {
    try {
      const formData = await req.formData();
      const file = formData.get("file");
      if (!file || typeof file === "string") {
        return Response.json({ error: "No file uploaded" }, { status: 400 });
      }
      csvText = await (file as Blob).text();
    } catch (err) {
      return Response.json(
        { error: "Failed to read upload", detail: String(err) },
        { status: 400 }
      );
    }
  } else {
    // Accept raw CSV text in body
    csvText = await req.text();
  }

  if (!csvText.trim()) {
    return Response.json({ error: "Empty CSV" }, { status: 400 });
  }

  // Parse CSV
  const parsed = Papa.parse(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h: string) => h.trim(),
  });

  if (parsed.errors.length > 0 && parsed.data.length === 0) {
    return Response.json(
      { error: "CSV parse failed", details: parsed.errors.slice(0, 5) },
      { status: 400 }
    );
  }

  const rows = parsed.data as Record<string, string>[];

  // Map CSV columns to normalized field names
  const mappedRows: Record<string, string>[] = [];
  for (const row of rows) {
    const mapped: Record<string, string> = {};
    for (const [csvCol, value] of Object.entries(row)) {
      const fieldName = CSV_COLUMN_MAP[csvCol];
      if (fieldName) mapped[fieldName] = (value || "").trim();
    }
    // Pass through Condition if present
    if (row.Condition) mapped.Condition = row.Condition.trim();
    if (row["Property Condition"]) mapped.Condition = row["Property Condition"].trim();
    mappedRows.push(mapped);
  }

  // Fetch existing records for dedup
  const existingKeys = await fetchExistingDedupeKeys();

  const today = new Date().toLocaleDateString("en-US", {
    month: "numeric", day: "numeric", year: "2-digit",
  });

  let total = 0;
  let filtered = 0;
  let dupes = 0;
  let newCount = 0;
  const newRecords: Array<{ fields: Record<string, unknown> }> = [];
  const rejectedRecords: Array<{ fields: Record<string, unknown> }> = [];

  for (const row of mappedRows) {
    total++;

    const address = row.Address || "";
    const zip = row.Zip || "";
    const state = row.State || "";

    if (!address) continue;

    // Dedup check
    const key = buildDedupeKey(address, zip, state);
    if (existingKeys.has(key)) {
      dupes++;
      continue;
    }
    existingKeys.add(key); // prevent intra-batch dupes

    // Apply filters
    const filterResult = applyFilters(row);

    // Build Airtable fields
    const fields: Record<string, unknown> = {};
    for (const [fieldName, fieldId] of Object.entries(FIELD_MAP)) {
      const value = row[fieldName];
      if (value !== undefined && value !== "") {
        if (fieldName === "List_Price" || fieldName === "Bedrooms" ||
            fieldName === "Bathrooms" || fieldName === "Building_SqFt") {
          const num = parseFloat(value);
          if (!isNaN(num)) fields[fieldId] = num;
        } else {
          fields[fieldId] = value;
        }
      }
    }

    if (filterResult.pass) {
      fields[FIELD_MAP.Notes] = `${today} — [Intake] Imported from PropStream CSV.`;
      newRecords.push({ fields });
      newCount++;
    } else {
      fields[FIELD_MAP.Execution_Path] = "Reject";
      fields[FIELD_MAP.Notes] = `${today} — [Intake] Rejected: ${filterResult.reason}`;
      rejectedRecords.push({ fields });
      filtered++;
    }
  }

  // Create all records in Airtable (new + rejected)
  const allToCreate = [...newRecords, ...rejectedRecords];
  const createResult = allToCreate.length > 0
    ? await batchCreateRecords(allToCreate)
    : { created: 0, ids: [] as string[] };

  // Phase 3: chain photo → ARV → pre-offer screen for the records that
  // entered as Auto-Proceed candidates (the first newRecords.length ids
  // correspond to passing rows). Fire-and-forget — we don't await, but we
  // start it before returning so each row begins processing.
  const newIds = createResult.ids.slice(0, newRecords.length);
  const origin = (() => { try { return new URL(req.url).origin; } catch { return null; } })();
  if (origin && newIds.length > 0) {
    const cookie = req.headers.get("cookie") ?? "";
    void chainPreOfferScreen(origin, cookie, newIds);
  }

  return Response.json({
    total,
    filtered,
    dupes,
    new: newCount,
    rejected: filtered,
    created: createResult.created,
    errors: total - dupes - newCount - filtered,
    preOfferScreenChained: newIds.length,
  });
}
