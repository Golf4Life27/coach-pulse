// GET /api/admin/remove-singleselect-choice?tableId=...&fieldId=...&choiceName=...
//
// One-shot cleanup for phantom singleSelect options that typecast
// silently created. Used to remove DriftTest-PhantomOption-XYZZY from
// Negotiation_Outcome after the deliberate-drift test on 5/13.
//
// Query params:
//   tableId    — Airtable table ID (e.g., tbldMjKBgPiq45Jjs)
//   fieldId    — Airtable field ID (singleSelect type)
//   choiceName — Name of the choice to remove
//
// GET semantics because Vercel MCP web_fetch_vercel_url is GET-only.
// Side-effect-on-GET is intentional and scoped to the hardcoded
// allowlist below.
//
// Behavior:
//   1. Reads field schema via Meta API
//   2. Builds new choices array excluding the named choice
//   3. Issues PATCH on /v0/meta/bases/{baseId}/tables/{tableId}/fields/{fieldId}
//      with the filtered choices
//   4. Audits the result
//
// Records currently using the choice will be auto-nulled by Airtable.
// Caller is responsible for clearing affected records first if that's
// undesirable.
//
// Restricted: only operates on a hardcoded allowlist of cleanup targets
// so this endpoint can't be used as a general schema-mutator.

import { NextResponse } from "next/server";
import { audit } from "@/lib/audit-log";

export const runtime = "nodejs";
export const maxDuration = 30;

const AIRTABLE_PAT = process.env.AIRTABLE_PAT!;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";

// Allowlist: { tableId, fieldId, choiceName } combinations approved
// for removal. Anything else returns 403.
const ALLOWED_REMOVALS = [
  {
    tableId: "tbldMjKBgPiq45Jjs", // Listings_V1
    fieldId: "fld2CcU3dKblEhEjL", // Negotiation_Outcome
    choiceName: "DriftTest-PhantomOption-XYZZY",
  },
];

interface AirtableFieldOptions {
  choices?: Array<{ id: string; name: string; color?: string }>;
}

export async function GET(req: Request) {
  const t0 = Date.now();
  const url = new URL(req.url);
  const tableId = url.searchParams.get("tableId");
  const fieldId = url.searchParams.get("fieldId");
  const choiceName = url.searchParams.get("choiceName");
  if (!tableId || !fieldId || !choiceName) {
    return NextResponse.json(
      { error: "Missing tableId, fieldId, or choiceName" },
      { status: 400 },
    );
  }
  const allowed = ALLOWED_REMOVALS.find(
    (r) => r.tableId === tableId && r.fieldId === fieldId && r.choiceName === choiceName,
  );
  if (!allowed) {
    return NextResponse.json(
      {
        error: "Not in cleanup allowlist. This endpoint only removes pre-approved phantom choices.",
        allowed: ALLOWED_REMOVALS,
      },
      { status: 403 },
    );
  }

  // ── Fetch current field schema ──────────────────────────────────────
  const tablesRes = await fetch(
    `https://api.airtable.com/v0/meta/bases/${BASE_ID}/tables`,
    {
      headers: { Authorization: `Bearer ${AIRTABLE_PAT}` },
      cache: "no-store",
    },
  );
  if (!tablesRes.ok) {
    const errText = await tablesRes.text().catch(() => "");
    await audit({
      agent: "admin-schema",
      event: "remove_choice_attempt",
      status: "confirmed_failure",
      inputSummary: { tableId, fieldId, choiceName },
      error: `meta GET ${tablesRes.status}: ${errText}`,
      ms: Date.now() - t0,
    });
    return NextResponse.json(
      { error: "Airtable Meta API GET failed", detail: errText, status: tablesRes.status },
      { status: 502 },
    );
  }
  const tablesBody = (await tablesRes.json()) as {
    tables?: Array<{
      id: string;
      fields: Array<{ id: string; name: string; type: string; options?: AirtableFieldOptions }>;
    }>;
  };
  const table = (tablesBody.tables ?? []).find((t) => t.id === tableId);
  const field = table?.fields.find((f) => f.id === fieldId);
  if (!field) {
    return NextResponse.json(
      { error: `Field ${fieldId} not found in table ${tableId}` },
      { status: 404 },
    );
  }
  const currentChoices = field.options?.choices ?? [];
  const filtered = currentChoices.filter(
    (c) => c.name.toLowerCase() !== choiceName.toLowerCase(),
  );
  if (filtered.length === currentChoices.length) {
    return NextResponse.json({
      removed: false,
      reason: `Choice "${choiceName}" not present in field "${field.name}" — already clean`,
      currentChoices: currentChoices.map((c) => c.name),
    });
  }

  // ── PATCH the field to drop the choice ────────────────────────────
  // Airtable's Meta API expects choices as objects WITHOUT id when
  // submitting — id is implicit on the existing ones we want to keep.
  // Sending the existing { id, name } objects is also accepted.
  const patchRes = await fetch(
    `https://api.airtable.com/v0/meta/bases/${BASE_ID}/tables/${tableId}/fields/${fieldId}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${AIRTABLE_PAT}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        options: { choices: filtered.map((c) => ({ id: c.id, name: c.name })) },
      }),
    },
  );

  if (!patchRes.ok) {
    const errText = await patchRes.text().catch(() => "");
    await audit({
      agent: "admin-schema",
      event: "remove_choice_attempt",
      status: "confirmed_failure",
      inputSummary: { tableId, fieldId, choiceName },
      error: `meta PATCH ${patchRes.status}: ${errText}`,
      ms: Date.now() - t0,
    });
    return NextResponse.json(
      { error: "Airtable Meta API PATCH failed", detail: errText, status: patchRes.status },
      { status: 502 },
    );
  }

  const patchBody = await patchRes.json().catch(() => ({}));
  await audit({
    agent: "admin-schema",
    event: "remove_choice_attempt",
    status: "confirmed_success",
    inputSummary: { tableId, fieldId, choiceName },
    outputSummary: {
      choices_before: currentChoices.length,
      choices_after: filtered.length,
      removed: currentChoices
        .filter((c) => c.name.toLowerCase() === choiceName.toLowerCase())
        .map((c) => c.name),
    },
    decision: "removed",
    ms: Date.now() - t0,
  });
  return NextResponse.json({
    removed: true,
    field: field.name,
    choices_before: currentChoices.map((c) => c.name),
    choices_after: filtered.map((c) => c.name),
    response: patchBody,
  });
}
