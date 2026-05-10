// One-shot admin endpoint: migrate the Listings_V1.DD_Checklist field's
// choice list from the V1 schema (6 items, includes "Showing Access
// Confirmed") to the V3 schema (12 items per JARVIS_PHASE1_SPEC.md).
//
// This uses Airtable's Meta API (PATCH /v0/meta/bases/{baseId}/tables/...
// /fields/{fieldId}) to add new choices in-place, preserving existing
// choices so legacy records that reference "Bed/Bath Verified" or
// "Showing Access Confirmed" still resolve correctly.
//
// Required: AIRTABLE_PAT must have `schema.bases:write` scope. Without
// it the PATCH returns 403; in that case the user must add the missing
// choices manually through Airtable's UI.
//
// Trigger: POST /api/admin/migrate-dd-checklist
// Optional CRON_SECRET gate.

import { NextResponse } from "next/server";
import { DD_V3_ITEMS } from "@/types/jarvis";

export const runtime = "nodejs";
export const maxDuration = 30;

const AIRTABLE_PAT = process.env.AIRTABLE_PAT!;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
const LISTINGS_TABLE = "tbldMjKBgPiq45Jjs";
const DD_FIELD_ID = "fldZVZT98A6cEmJB3";

interface AirtableChoice {
  id?: string;
  name: string;
  color?: string;
}

interface MetaFieldResponse {
  id: string;
  options?: { choices?: AirtableChoice[] };
}

const NEW_COLORS: Record<string, string> = {
  "Vacancy/Occupancy Status": "blueBright",
  "Utility Status Known": "yellowBright",
  "Roof Age Asked": "cyanBright",
  "HVAC Age Asked": "tealBright",
  "Water Heater Age Asked": "purpleBright",
  "Electrical Age Asked": "redBright",
  "Plumbing Age Asked": "pinkBright",
  "Foundation Issues Disclosed": "grayBright",
  "Active Leaks Disclosed": "blueBright",
  "Sewer Issues Disclosed": "orangeBright",
  "Environmental Hazards Disclosed": "yellowBright",
  "Permits/Violations Disclosed": "greenBright",
};

export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization") ?? "";
    if (!auth.includes(secret)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  if (!AIRTABLE_PAT) {
    return NextResponse.json({ error: "AIRTABLE_PAT not set" }, { status: 500 });
  }

  const metaUrl = `https://api.airtable.com/v0/meta/bases/${BASE_ID}/tables/${LISTINGS_TABLE}/fields/${DD_FIELD_ID}`;

  // Step 1: read current schema.
  const getRes = await fetch(metaUrl, {
    headers: { Authorization: `Bearer ${AIRTABLE_PAT}` },
    cache: "no-store",
  });
  if (!getRes.ok) {
    const errText = await getRes.text().catch(() => "");
    return NextResponse.json(
      {
        error: `Failed to read field schema: ${getRes.status}`,
        detail: errText,
        hint: "PAT likely missing schema.bases:read scope. Use Airtable's UI to add the V3 options manually instead.",
      },
      { status: 502 },
    );
  }
  const current = (await getRes.json()) as MetaFieldResponse;
  const existing = current.options?.choices ?? [];
  const existingNames = new Set(existing.map((c) => c.name));

  // Step 2: compute the merged choice list. Preserve existing choices (so
  // historical records that reference "Showing Access Confirmed" still
  // resolve) and add any V3 items that are missing.
  const additions: AirtableChoice[] = [];
  for (const item of DD_V3_ITEMS) {
    if (!existingNames.has(item)) {
      additions.push({ name: item, color: NEW_COLORS[item] ?? "blueBright" });
    }
  }

  if (additions.length === 0) {
    return NextResponse.json({
      success: true,
      added: 0,
      existing: existing.map((c) => c.name),
      note: "All V3 DD options already present.",
    });
  }

  const merged: AirtableChoice[] = [
    // Preserve existing choices verbatim (with their ids) so historical
    // values aren't invalidated.
    ...existing.map((c) => ({ id: c.id, name: c.name, color: c.color })),
    ...additions,
  ];

  // Step 3: PATCH the field.
  const patchRes = await fetch(metaUrl, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${AIRTABLE_PAT}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ options: { choices: merged } }),
  });
  if (!patchRes.ok) {
    const errText = await patchRes.text().catch(() => "");
    return NextResponse.json(
      {
        error: `Failed to PATCH field: ${patchRes.status}`,
        detail: errText,
        hint:
          patchRes.status === 403
            ? "PAT missing schema.bases:write scope. Re-issue the PAT with that scope, or add the V3 options manually in Airtable."
            : undefined,
        wouldHaveAdded: additions.map((a) => a.name),
      },
      { status: 502 },
    );
  }

  const patched = (await patchRes.json()) as MetaFieldResponse;
  return NextResponse.json({
    success: true,
    added: additions.length,
    addedNames: additions.map((a) => a.name),
    final: (patched.options?.choices ?? []).map((c) => c.name),
  });
}
