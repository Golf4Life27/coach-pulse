// Airtable write verification — post-write echo diffing per the
// Positive Confirmation Principle (docs/Positive_Confirmation_Principle.md).
//
// Airtable's PATCH responses echo the post-write field values. We
// compare what we sent against the echo and flag drift — most
// commonly:
//
//   (1) singleSelect typecast created a NEW choice option because
//       we wrote a slightly-mistyped name ("Renegotiating" vs
//       "Negotiating"). Airtable accepts silently; downstream code
//       checking for "Negotiating" later silently breaks.
//
//   (2) Number coercion fell out (string→null) because the value
//       was unparseable.
//
//   (3) DateTime coercion stored an invalid date as null.
//
// A 2xx PATCH is NOT proof that the field landed correctly. This
// helper is the verification step that closes the loop.

import { audit } from "./audit-log";

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

export function detectWriteDrift(
  written: Record<string, unknown>,
  echoed: Record<string, unknown>,
): FieldDrift[] {
  const drift: FieldDrift[] = [];
  for (const [field, val] of Object.entries(written)) {
    // Skip computed/formula echoes — Airtable sometimes includes them
    // even if we didn't write. Our `written` keys are the source of truth.
    if (!(field in echoed)) {
      drift.push({
        field,
        written: val,
        stored: undefined,
        reason: "field absent from Airtable response — write may have been rejected silently",
      });
      continue;
    }
    const cmp = compareFieldValues(val, echoed[field]);
    if (!cmp.match) {
      drift.push({
        field,
        written: val,
        stored: echoed[field],
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
  recordId: string;
  written: Record<string, unknown>;
  echoed: Record<string, unknown>;
}): Promise<FieldDrift[]> {
  const drift = detectWriteDrift(opts.written, opts.echoed);
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
