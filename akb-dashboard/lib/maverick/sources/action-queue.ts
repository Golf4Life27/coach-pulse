// Maverick source — Action Queue.
// @agent: maverick
//
// v1 scope: D3_Manual_Fix_Queue (created 5/13) is the canonical
// "needs Alex's attention" surface. Future Cadence_Queue table
// (Tier B) plugs in here when built.
//
// Budget: 4s. Single Airtable list call with a status filter.
// Spec v1.1 §5 Step 1.

import { runWithTimeout } from "../timeout";
import type { FetchOpts, SourceResult } from "../types";

const DEFAULT_TIMEOUT_MS = 4_000;

const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
const MANUAL_FIX_QUEUE_TABLE = "tblV6OkNPDzOo6ubp";
const AIRTABLE_PAT = process.env.AIRTABLE_PAT;

// D3_Manual_Fix_Queue field IDs (from 5/13 schema dump).
const F_ADDRESS = "fldFG1tMNsEJFXHnK";
const F_ISSUE_CATEGORY = "fldkjCt4GnSglzE1H";
const F_DETECTED_DATE = "fld4DZKhLnrVdW1td";
const F_DETECTED_BY = "fldFy8mcpW4pxOwPc";
const F_RESOLUTION_STATUS = "fldxtbNTaztd0A4OV";
const F_AGENT_PHONE_RAW = "fldJAbPKbOUc6NbYa";
const F_AGENT_FIRST_NAME = "fldznkl2bDfD3wfrC";

export interface ManualFixQueueItem {
  id: string;
  address: string;
  issue_category: string | null;
  detected_date: string | null;
  detected_by: string | null;
  agent_phone_raw: string | null;
  agent_first_name: string | null;
}

export interface ActionQueueState {
  d3_manual_fix_queue_pending_count: number;
  d3_manual_fix_queue_pending_sample: ManualFixQueueItem[];
  // Placeholder for Cadence_Queue (Tier B build): always 0/[] until
  // the table exists. Surfaced now so the briefing shape is stable
  // across the v1 → Tier B transition.
  cadence_queue_pending_count: number;
  cadence_queue_pending_sample: never[];
}

export async function fetchActionQueueState(
  opts: FetchOpts = {},
): Promise<SourceResult<ActionQueueState>> {
  return runWithTimeout(
    { source: "action_queue", timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS },
    async (signal) => {
      if (!AIRTABLE_PAT) {
        throw new Error("AIRTABLE_PAT not configured");
      }
      const url = new URL(`https://api.airtable.com/v0/${BASE_ID}/${MANUAL_FIX_QUEUE_TABLE}`);
      url.searchParams.set("returnFieldsByFieldId", "true");
      url.searchParams.set("pageSize", "50");
      url.searchParams.set(
        "filterByFormula",
        `{${F_RESOLUTION_STATUS}}="pending"`,
      );
      url.searchParams.append("sort[0][field]", F_DETECTED_DATE);
      url.searchParams.append("sort[0][direction]", "desc");

      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${AIRTABLE_PAT}` },
        signal,
        cache: "no-store",
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Airtable manual-fix-queue fetch ${res.status}: ${text.slice(0, 200)}`);
      }
      const body = (await res.json()) as {
        records?: Array<{ id: string; fields: Record<string, unknown> }>;
      };
      return summarizeQueue(body.records ?? []);
    },
  );
}

/**
 * Pure summarizer — accepts raw records with field-ID-keyed fields.
 */
export function summarizeQueue(
  records: Array<{ id: string; fields: Record<string, unknown> }>,
): ActionQueueState {
  const items: ManualFixQueueItem[] = records.map((r) => ({
    id: r.id,
    address: asString(r.fields[F_ADDRESS]) ?? "(no address)",
    issue_category: singleSelectName(r.fields[F_ISSUE_CATEGORY]),
    detected_date: asString(r.fields[F_DETECTED_DATE]),
    detected_by: singleSelectName(r.fields[F_DETECTED_BY]),
    agent_phone_raw: asString(r.fields[F_AGENT_PHONE_RAW]),
    agent_first_name: asString(r.fields[F_AGENT_FIRST_NAME]),
  }));
  return {
    d3_manual_fix_queue_pending_count: items.length,
    d3_manual_fix_queue_pending_sample: items.slice(0, 10),
    cadence_queue_pending_count: 0,
    cadence_queue_pending_sample: [],
  };
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function singleSelectName(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "name" in v) {
    const n = (v as { name: unknown }).name;
    if (typeof n === "string") return n;
  }
  return null;
}
