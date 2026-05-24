// Maverick — write-state pure logic + Airtable/KV I/O.
// @agent: maverick (Day 4)
//
// Tool surface for maverick_write_state per Spec v1.1 §5 Step 4.
// Append-only: every write is a new Spine_Decision_Log row + an
// audit_log event. Corrections to prior decisions are written as
// new `principle_amendment` events that reference the prior via
// related_spine_decision.
//
// Programmatic rollback API deferred to v1.1+ per locked amendment
// 6.4. The "audit, append-only, with corrections as amendment
// events" contract is enforced by NEVER calling Airtable PATCH or
// DELETE from this module — only POST.

import { audit } from "@/lib/audit-log";

const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
const SPINE_TABLE_ID = "tblbp91DB5szxsJpT";
const AIRTABLE_PAT = process.env.AIRTABLE_PAT;

// Spine_Decision_Log field names (Airtable API accepts either name
// or ID; using names here for legibility in the structured-content
// the write produces).
const F_TITLE = "Decision_Title";
const F_DATE = "Decision_Date";
const F_DESCRIPTION = "Description";
const F_TRIGGER = "Trigger_Event";
const F_WHY = "Why";

// Canonical event-type vocabulary. Anchored to v1.1 §5 Step 4 + the
// agent roster. Bounded so Spine queries can group cleanly later.
export const WRITE_STATE_EVENT_TYPES = [
  "decision",
  "principle_amendment",
  "build_event",
  "deal_state_change",
] as const;
export type WriteStateEventType = (typeof WRITE_STATE_EVENT_TYPES)[number];

// Agent attribution must be from the canonical roster (Spec v1.1
// §6) OR `maverick` (orchestrator default). Surfaced as a type so
// new agents in v1.1 amendments get a compile-time error here when
// not added to the union.
export const MAVERICK_ROSTER_AGENTS = [
  "maverick",
  "sentinel",
  "appraiser",
  "forge",
  "crier",
  "sentry",
  "scribe",
  "scout",
  "pulse",
  "ledger",
] as const;
export type RosterAgent = (typeof MAVERICK_ROSTER_AGENTS)[number];

export interface WriteStateArgs {
  event_type: WriteStateEventType;
  title: string;
  description: string;
  reasoning?: string;
  related_spine_decision?: string; // recXXX
  related_listing?: string; // recXXX
  attribution_agent?: RosterAgent;
}

export interface WriteStateResult {
  written: true;
  spine_record_id: string;
  audit_event_id: string;
}

export type ValidationFailure = {
  ok: false;
  error: string;
};

export type ValidationSuccess = {
  ok: true;
  args: Required<Pick<WriteStateArgs, "event_type" | "title" | "description">> &
    Omit<WriteStateArgs, "event_type" | "title" | "description">;
};

// ────────────────────── pure: arg validation ──────────────────────

/**
 * Validate the raw arguments. Returns ok+normalized-args or
 * ok=false+message. Pure function — exhaustive tests live in
 * write-state.test.ts.
 */
export function validateWriteStateArgs(raw: unknown): ValidationSuccess | ValidationFailure {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "arguments must be an object" };
  }
  const r = raw as Record<string, unknown>;

  if (typeof r.event_type !== "string") {
    return { ok: false, error: "event_type is required (string)" };
  }
  if (!WRITE_STATE_EVENT_TYPES.includes(r.event_type as WriteStateEventType)) {
    return {
      ok: false,
      error: `event_type must be one of: ${WRITE_STATE_EVENT_TYPES.join(", ")}`,
    };
  }
  if (typeof r.title !== "string" || r.title.trim().length === 0) {
    return { ok: false, error: "title is required (non-empty string)" };
  }
  if (typeof r.description !== "string" || r.description.trim().length === 0) {
    return { ok: false, error: "description is required (non-empty string)" };
  }
  if (r.reasoning !== undefined && typeof r.reasoning !== "string") {
    return { ok: false, error: "reasoning must be a string when provided" };
  }
  if (r.related_spine_decision !== undefined) {
    if (typeof r.related_spine_decision !== "string" || !/^rec[A-Za-z0-9]{14}$/.test(r.related_spine_decision)) {
      return {
        ok: false,
        error: "related_spine_decision must be a 17-char Airtable record ID (rec + 14 alphanumeric chars)",
      };
    }
  }
  if (r.related_listing !== undefined) {
    if (typeof r.related_listing !== "string" || !/^rec[A-Za-z0-9]{14}$/.test(r.related_listing)) {
      return {
        ok: false,
        error: "related_listing must be a 17-char Airtable record ID",
      };
    }
  }
  if (r.attribution_agent !== undefined) {
    if (typeof r.attribution_agent !== "string") {
      return { ok: false, error: "attribution_agent must be a string when provided" };
    }
    if (!MAVERICK_ROSTER_AGENTS.includes(r.attribution_agent as RosterAgent)) {
      return {
        ok: false,
        error: `attribution_agent must be one of the named-agent roster: ${MAVERICK_ROSTER_AGENTS.join(", ")}`,
      };
    }
  }

  return {
    ok: true,
    args: {
      event_type: r.event_type as WriteStateEventType,
      title: r.title.trim(),
      description: r.description.trim(),
      reasoning: typeof r.reasoning === "string" ? r.reasoning.trim() : undefined,
      related_spine_decision:
        typeof r.related_spine_decision === "string" ? r.related_spine_decision : undefined,
      related_listing: typeof r.related_listing === "string" ? r.related_listing : undefined,
      attribution_agent:
        typeof r.attribution_agent === "string" ? (r.attribution_agent as RosterAgent) : undefined,
    },
  };
}

// ────────────────────── pure: payload composition ──────────────────────

export interface SpineRowFields {
  Decision_Title: string;
  Decision_Date: string; // YYYY-MM-DD
  Description: string;
  Trigger_Event: string;
  Why?: string;
}

/**
 * Build the Spine_Decision_Log row from validated args + the
 * Date the write was attributed at. Pure.
 *
 * Mapping rationale (Spine_Decision_Log doesn't have native fields
 * for event_type / attribution_agent / related-record pointers, so
 * we pack the metadata into structured locations that the recall
 * path can parse back out):
 *
 *   Decision_Title ← title (trimmed)
 *   Decision_Date  ← UTC YYYY-MM-DD of the write
 *   Description    ← description + structured related-record footer
 *   Trigger_Event  ← "event_type={x}; written_by={agent}"
 *   Why            ← reasoning (omitted when absent)
 */
export function buildSpineRow(
  args: ValidationSuccess["args"],
  now: Date,
): SpineRowFields {
  const attribution = args.attribution_agent ?? "maverick";
  const trigger = `event_type=${args.event_type}; written_by=${attribution}`;

  // Description footer captures the related-record pointers in a
  // grep-able shape. Empty when no related records.
  const footerLines: string[] = [];
  if (args.related_spine_decision) {
    footerLines.push(`Related Spine decision: ${args.related_spine_decision}`);
  }
  if (args.related_listing) {
    footerLines.push(`Related listing: ${args.related_listing}`);
  }
  const description = footerLines.length > 0
    ? `${args.description}\n\n— maverick metadata —\n${footerLines.join("\n")}`
    : args.description;

  const row: SpineRowFields = {
    Decision_Title: args.title,
    Decision_Date: toUtcIsoDate(now),
    Description: description,
    Trigger_Event: trigger,
  };
  if (args.reasoning) row.Why = args.reasoning;
  return row;
}

function toUtcIsoDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ────────────────────── I/O wrappers ──────────────────────

export interface WriteStateDeps {
  // Injected for testability. Production binds these to the real
  // Airtable + audit wrappers; tests inject stubs.
  createSpineRecord: (fields: SpineRowFields) => Promise<{ id: string }>;
  writeAudit: (entry: Parameters<typeof audit>[0]) => Promise<void>;
  now: () => Date;
}

/**
 * Production-default deps. The MCP route + write-state tool handler
 * wires these. Tests inject stubs.
 */
export function defaultWriteStateDeps(): WriteStateDeps {
  return {
    createSpineRecord: createSpineRecordViaAirtable,
    writeAudit: audit,
    now: () => new Date(),
  };
}

async function createSpineRecordViaAirtable(fields: SpineRowFields): Promise<{ id: string }> {
  if (!AIRTABLE_PAT) {
    throw new Error("AIRTABLE_PAT not configured");
  }
  const url = `https://api.airtable.com/v0/${BASE_ID}/${SPINE_TABLE_ID}`;
  // Airtable POST with single-record body.
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${AIRTABLE_PAT}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Spine_Decision_Log create failed ${res.status}: ${text.slice(0, 300)}`);
  }
  const body = (await res.json()) as { id?: string };
  if (typeof body.id !== "string") {
    throw new Error("Spine_Decision_Log create returned no id");
  }
  return { id: body.id };
}

/**
 * Orchestrate the write: create the Spine row, then write the audit
 * event with the new row's ID + the structured args.
 *
 * audit_event_id is the wall-clock ms timestamp the audit() call
 * was made at — KV stores audit events keyed by ts, so this is
 * sufficient for recall to locate the specific event.
 */
export async function writeState(
  args: ValidationSuccess["args"],
  deps: WriteStateDeps = defaultWriteStateDeps(),
): Promise<WriteStateResult> {
  const now = deps.now();
  const row = buildSpineRow(args, now);
  const spineResult = await deps.createSpineRecord(row);

  // Capture audit ts BEFORE the call — audit() writes ts: now to KV.
  const auditTs = new Date().toISOString();
  await deps.writeAudit({
    agent: args.attribution_agent ?? "maverick",
    event: `write_state.${args.event_type}`,
    status: "confirmed_success",
    inputSummary: {
      title: args.title,
      event_type: args.event_type,
      attribution_agent: args.attribution_agent ?? "maverick",
      related_spine_decision: args.related_spine_decision ?? null,
      related_listing: args.related_listing ?? null,
      // Audit-side denormalization of the written payload so the
      // recall path can find writes by content without joining to
      // Spine. Length-capped to keep KV entries bounded.
      description_preview: args.description.slice(0, 500),
    },
    outputSummary: {
      spine_record_id: spineResult.id,
      audit_event_ts: auditTs,
    },
    decision: "spine_row_created",
    recordId: spineResult.id,
  });

  return {
    written: true,
    spine_record_id: spineResult.id,
    audit_event_id: auditTs,
  };
}
