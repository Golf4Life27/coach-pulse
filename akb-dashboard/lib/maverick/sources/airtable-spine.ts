// Maverick source — Airtable Spine_Decision_Log.
// @agent: maverick
//
// Recent decisions / principle amendments / build events logged in
// the Spine table. Briefing's "recent key decisions" + "principles in
// effect" surfaces draw from this.
//
// Budget: 4s. Spine table is small (single-digit-to-low-hundreds rows
// today) so the round-trip dominates.
// Spec v1.1 §5 Step 1.

import { runWithTimeout } from "../timeout";
import type { FetchOpts, SourceResult } from "../types";

// Bumped from 4s → 8s after Gate 2 first-smoke contention (5/15).
const DEFAULT_TIMEOUT_MS = 8_000;

const SPINE_BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
const SPINE_TABLE_ID = "tblbp91DB5szxsJpT";
const AIRTABLE_PAT = process.env.AIRTABLE_PAT;

// Spine_Decision_Log field IDs (from 5/13 schema dump).
const F_TITLE = "fldkeMrHBhx4X8aml";
const F_DATE = "fld36Jlm4Fo4vLG1L";
const F_DESCRIPTION = "fldajtCDNGYjsnGBR";
const F_TRIGGER = "fldYxNN1KLOSLadI4";
const F_WHY = "fld4IRmHf2h2fiNKX";
const F_IMPLICATION = "fldgowtyhcDEPRpqE";
const F_PHASE = "fldlFqie4S86aaLes";

export interface SpineEntry {
  id: string;
  decision_title: string;
  decision_date: string | null;
  description: string | null;
  trigger_event: string | null;
  why: string | null;
  implication: string | null;
  phase_at_time: string | null;
}

export interface AirtableSpineState {
  total_since: number;
  recent_decisions: SpineEntry[];
}

export async function fetchAirtableSpineState(
  opts: FetchOpts = {},
): Promise<SourceResult<AirtableSpineState>> {
  return runWithTimeout(
    { source: "airtable_spine", timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS },
    async (signal) => {
      if (!AIRTABLE_PAT) {
        throw new Error("AIRTABLE_PAT not configured");
      }
      const sinceIso = (opts.since ?? new Date(Date.now() - 7 * 86_400_000))
        .toISOString()
        .slice(0, 10);

      const url = new URL(`https://api.airtable.com/v0/${SPINE_BASE_ID}/${SPINE_TABLE_ID}`);
      url.searchParams.set("returnFieldsByFieldId", "true");
      url.searchParams.set("pageSize", "100");
      url.searchParams.set(
        "filterByFormula",
        `IS_AFTER({${F_DATE}}, "${sinceIso}")`,
      );
      url.searchParams.append("sort[0][field]", F_DATE);
      url.searchParams.append("sort[0][direction]", "desc");

      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${AIRTABLE_PAT}` },
        signal,
        cache: "no-store",
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Airtable Spine fetch ${res.status}: ${text.slice(0, 200)}`);
      }
      const body = (await res.json()) as {
        records?: Array<{ id: string; fields: Record<string, unknown> }>;
      };
      return summarizeSpine(body.records ?? []);
    },
  );
}

/**
 * Pure summarizer — accepts raw Airtable records (fields keyed by
 * field-ID since the fetcher uses returnFieldsByFieldId=true).
 */
export function summarizeSpine(
  records: Array<{ id: string; fields: Record<string, unknown> }>,
): AirtableSpineState {
  const entries: SpineEntry[] = records.map((r) => ({
    id: r.id,
    decision_title: stringOrNull(r.fields[F_TITLE]) ?? "(untitled)",
    decision_date: stringOrNull(r.fields[F_DATE]),
    description: stringOrNull(r.fields[F_DESCRIPTION]),
    trigger_event: stringOrNull(r.fields[F_TRIGGER]),
    why: stringOrNull(r.fields[F_WHY]),
    implication: stringOrNull(r.fields[F_IMPLICATION]),
    phase_at_time: singleSelectName(r.fields[F_PHASE]),
  }));
  return { total_since: entries.length, recent_decisions: entries };
}

function stringOrNull(v: unknown): string | null {
  if (typeof v === "string") return v;
  return null;
}

function singleSelectName(v: unknown): string | null {
  // Airtable singleSelect returns either a string (legacy) or an
  // object {id,name,color} (returnFieldsByFieldId mode).
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "name" in v && typeof (v as { name: unknown }).name === "string") {
    return (v as { name: string }).name;
  }
  return null;
}
