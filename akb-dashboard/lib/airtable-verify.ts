// Airtable write verification — post-write echo diffing per the
// Positive Confirmation Principle (docs/Positive_Confirmation_Principle.md).
//
// Two layers of verification:
//
//   (A) Echo-comparison — Airtable PATCH responses echo the post-write
//       field values. We compare what we sent vs what Airtable stored
//       with normalization (select object→name, number tolerance,
//       datetime parsing, etc).
//
//   (B) Schema-aware singleSelect/multipleSelects validation — fetched
//       once and cached. Catches the phantom-option case: when
//       typecast=true silently creates a NEW choice option because the
//       value didn't pre-exist. This is the silent-downgrade scenario
//       that motivated this whole migration — Airtable echoes
//       {name: "Foo"} happily, but "Foo" is a brand-new option that
//       downstream code checking for "Negotiating" / "Texted" / etc.
//       will silently fail to match.
//
// Both layers feed into the same audit channel (status: uncertain,
// decision: flag_for_review).

import { audit } from "./audit-log";

const AIRTABLE_PAT = process.env.AIRTABLE_PAT!;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";

// Map of tableId → fieldId → { type, choices } cached for the lambda's
// lifetime. Schema rarely changes; a cold-start refetch is fine.
interface FieldSchema {
  type: string;
  name: string; // human-readable Airtable field name (echo keys by this)
  choices?: Set<string>; // lowercased choice names for select fields
}
type TableFieldSchemas = Record<string /* fieldId */, FieldSchema>;
const schemaCache: Record<string /* tableId */, TableFieldSchemas> = {};
const schemaFetchedAt: Record<string, number> = {};
// 10-min TTL per Alex's design note (5/13): lazy-load + refresh on TTL,
// not per-write. Cache hit rate should be ~99% in practice since schemas
// rarely change. Adjust here if mutations to the base become more frequent.
const SCHEMA_TTL_MS = 10 * 60_000;

async function loadTableSchema(tableId: string): Promise<TableFieldSchemas> {
  const now = Date.now();
  if (
    schemaCache[tableId] &&
    schemaFetchedAt[tableId] &&
    now - schemaFetchedAt[tableId] < SCHEMA_TTL_MS
  ) {
    return schemaCache[tableId];
  }

  const url = `https://api.airtable.com/v0/meta/bases/${BASE_ID}/tables`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${AIRTABLE_PAT}` },
    cache: "no-store",
  });
  if (!res.ok) {
    // Schema fetch is best-effort. If it fails (e.g., PAT lacks
    // schema.bases:read scope), fall back to echo-only verification.
    // No throw — write itself already succeeded.
    console.warn(`[airtable-verify] schema fetch failed ${res.status} — phantom-option check disabled for ${tableId}`);
    return {};
  }
  const body = (await res.json()) as {
    tables?: Array<{
      id: string;
      fields: Array<{
        id: string;
        name: string;
        type: string;
        options?: { choices?: Array<{ name: string }> };
      }>;
    }>;
  };
  const tables = body.tables ?? [];
  for (const t of tables) {
    const fieldSchemas: TableFieldSchemas = {};
    for (const f of t.fields) {
      const choices = f.options?.choices?.map((c) => c.name.toLowerCase());
      fieldSchemas[f.id] = {
        type: f.type,
        name: f.name,
        choices: choices ? new Set(choices) : undefined,
      };
    }
    schemaCache[t.id] = fieldSchemas;
    schemaFetchedAt[t.id] = now;
  }
  return schemaCache[tableId] ?? {};
}

export interface FieldDrift {
  field: string;
  written: unknown;
  stored: unknown;
  reason: string;
}

// Returns true if `written` is functionally equivalent to `echoed`
// after accounting for Airtable's normalization (select objects,
// boolean coercion, number coercion, datetime parsing, etc).
function compareFieldValues(
  written: unknown,
  echoed: unknown,
): { match: boolean; reason?: string } {
  if (written === echoed) return { match: true };
  if (written == null && echoed == null) return { match: true };

  // singleSelect: Airtable echoes { id, name, color }
  if (
    typeof written === "string" &&
    echoed &&
    typeof echoed === "object" &&
    !Array.isArray(echoed) &&
    "name" in echoed
  ) {
    const echoName = String((echoed as { name: unknown }).name);
    if (written.trim().toLowerCase() === echoName.trim().toLowerCase()) {
      return { match: true };
    }
    return {
      match: false,
      reason: `singleSelect drift — wrote "${written}", Airtable stored "${echoName}" (typecast may have created a new option)`,
    };
  }

  // multipleSelects: arrays of { id, name, color }
  if (Array.isArray(written) && Array.isArray(echoed)) {
    const writtenLower = written.map((v) => String(v).trim().toLowerCase()).sort();
    const echoedLower = echoed
      .map((v) =>
        v && typeof v === "object" && "name" in v
          ? String((v as { name: unknown }).name)
          : String(v),
      )
      .map((s) => s.trim().toLowerCase())
      .sort();
    if (
      writtenLower.length === echoedLower.length &&
      writtenLower.every((v, i) => v === echoedLower[i])
    ) {
      return { match: true };
    }
    return {
      match: false,
      reason: `multipleSelects drift — wrote [${writtenLower.join(", ")}], stored [${echoedLower.join(", ")}]`,
    };
  }

  // Number coercion tolerance (Airtable stores currency/numbers as numbers
  // even when we send strings; tolerate float precision).
  if (
    (typeof written === "number" || typeof written === "string") &&
    (typeof echoed === "number" || typeof echoed === "string")
  ) {
    const wNum = Number(written);
    const eNum = Number(echoed);
    if (!isNaN(wNum) && !isNaN(eNum)) {
      if (Math.abs(wNum - eNum) < 0.01) return { match: true };
      return {
        match: false,
        reason: `number drift — wrote ${wNum}, stored ${eNum}`,
      };
    }
  }

  // Boolean coercion
  const wBool =
    written === true || written === "true" || written === 1 || written === "1";
  const eBool =
    echoed === true || echoed === "true" || echoed === 1 || echoed === "1";
  if (typeof written === "boolean" || typeof echoed === "boolean") {
    if (wBool === eBool) return { match: true };
    return {
      match: false,
      reason: `boolean drift — wrote ${written}, stored ${echoed}`,
    };
  }

  // DateTime — both parse to same instant
  if (
    typeof written === "string" &&
    typeof echoed === "string" &&
    written !== echoed
  ) {
    const w = new Date(written).getTime();
    const e = new Date(echoed).getTime();
    if (!isNaN(w) && !isNaN(e) && Math.abs(w - e) < 1000) {
      return { match: true };
    }
  }

  // Final fallback — stringify both, trim, compare
  const wStr = String(written ?? "").trim();
  const eStr = String(echoed ?? "").trim();
  if (wStr === eStr) return { match: true };

  return {
    match: false,
    reason: `value drift — wrote "${wStr}", stored "${eStr}"`,
  };
}

// Airtable PATCH echoes by field NAME (Airtable's single-record write
// endpoints silently ignore returnFieldsByFieldId), but callers write by
// field ID. Build a fieldId→fieldName map from the schema so we can look
// up each written field ID in the name-keyed echo.
function buildFieldIdToNameMap(schema?: TableFieldSchemas): Map<string, string> {
  // Schema only stores field IDs as keys with metadata. The fetcher needs
  // to additionally surface the name. Done via the extended loader below.
  // For backwards compat (when fieldNames is empty), returns empty map.
  const map = new Map<string, string>();
  if (!schema) return map;
  for (const [fieldId, meta] of Object.entries(schema)) {
    if (meta.name) map.set(fieldId, meta.name);
  }
  return map;
}

export function detectWriteDrift(
  written: Record<string, unknown>,
  echoed: Record<string, unknown>,
  schema?: TableFieldSchemas,
): FieldDrift[] {
  const drift: FieldDrift[] = [];
  const idToName = buildFieldIdToNameMap(schema);
  for (const [field, val] of Object.entries(written)) {
    // Look up by field ID first (in case Airtable did return by ID — some
    // table types might), then fall back to the schema-resolved field name.
    const echoedValue = field in echoed
      ? echoed[field]
      : idToName.has(field)
        ? echoed[idToName.get(field)!]
        : undefined;
    const fieldFoundInEcho = field in echoed || (idToName.has(field) && idToName.get(field)! in echoed);

    if (!fieldFoundInEcho) {
      // Writing null to clear a field doesn't echo back — Airtable
      // omits empty/null fields from the response by default. Not
      // drift; the write succeeded as intended.
      if (val == null) continue;
      drift.push({
        field,
        written: val,
        stored: undefined,
        reason: "field absent from Airtable response — write may have been rejected silently",
      });
      continue;
    }

    // Layer B: schema-aware phantom-option check. Fires BEFORE the echo
    // compare so the more specific reason wins. Only runs when schema
    // was successfully loaded.
    const fieldSchema = schema?.[field];
    if (fieldSchema?.choices && val != null) {
      const writtenNames: string[] = Array.isArray(val)
        ? val.map((v) => String(v).toLowerCase().trim())
        : [String(val).toLowerCase().trim()];
      let phantomFound = false;
      for (const name of writtenNames) {
        if (name && !fieldSchema.choices.has(name)) {
          drift.push({
            field,
            written: val,
            stored: echoedValue,
            reason: `phantom-option drift — wrote "${name}" but field "${field}" (${fieldSchema.type}) has no such choice in schema. Airtable likely created a new option silently.`,
          });
          phantomFound = true;
        }
      }
      // Don't double-flag with the echo compare for this field
      if (phantomFound) continue;
      // Choice was valid → no phantom. Skip echo compare; the select-name
      // round-trip is the canonical signal here.
      continue;
    }

    // Layer A: echo compare
    const cmp = compareFieldValues(val, echoedValue);
    if (!cmp.match) {
      drift.push({
        field,
        written: val,
        stored: echoedValue,
        reason: cmp.reason ?? "drift detected",
      });
    }
  }
  return drift;
}

// Single entry point used by every airtable.ts write path. Audits drift
// as uncertain (NOT confirmed_failure — the HTTP write succeeded; we
// just can't confirm the field landed the way we asked). Returns drift
// so callers can decide whether to react.
export async function auditWriteDrift(opts: {
  table: string;
  tableId: string;
  recordId: string;
  written: Record<string, unknown>;
  echoed: Record<string, unknown>;
}): Promise<FieldDrift[]> {
  // Best-effort schema load. If it fails (missing scope, network),
  // detectWriteDrift falls back to echo-only verification (Layer A).
  let schema: TableFieldSchemas | undefined;
  try {
    schema = await loadTableSchema(opts.tableId);
  } catch (err) {
    console.warn(`[airtable-verify] schema load threw, falling back to echo-only:`, err);
  }

  const drift = detectWriteDrift(opts.written, opts.echoed, schema);
  if (drift.length > 0) {
    await audit({
      agent: "airtable-write",
      event: "field_drift_detected",
      status: "uncertain",
      recordId: opts.recordId,
      inputSummary: {
        table: opts.table,
        fields_written: Object.keys(opts.written),
      },
      outputSummary: {
        drift_count: drift.length,
        drift: drift.map((d) => ({
          field: d.field,
          reason: d.reason,
          written: typeof d.written === "object" ? JSON.stringify(d.written) : String(d.written),
          stored: typeof d.stored === "object" ? JSON.stringify(d.stored) : String(d.stored ?? "<absent>"),
        })),
      },
      decision: "flag_for_review",
    });
  }
  return drift;
}
