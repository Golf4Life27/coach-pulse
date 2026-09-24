// The ONE Dead-write helper for the 14-day silence Death Rule (P0-10,
// operator ruling 2026-09-23, spine reclKuvb2ZlGTL09O; approved to build
// 2026-09-24, spine recYbAYqkguZSOTeF).
//
// This does NOT migrate the ~12 existing direct Dead writers elsewhere in
// the codebase (lib/resurrection.ts's flip-back, stale-deal-triage,
// app/api/mark-dead, the admin bulk-dead routes, etc.) — that consolidation
// is a separate, later change (P0-12). This helper exists so the death-rule
// cron has exactly one place that writes Outreach_Status=Dead, and that one
// place enforces the hard guard: signed deals never die this way.

import { getListing, updateListingRecord } from "@/lib/airtable";
import type { Listing } from "@/lib/types";

export interface MarkDeadOptions {
  now?: Date;
  /** Pass the already-fetched record when the caller has it (e.g. a cron
   *  sweep that already pulled the full population this run) to skip a
   *  redundant live GET. Falls back to a fresh getListing(recordId) fetch
   *  when omitted. */
  record?: Pick<Listing, "notes" | "contractExecutedAt"> | null;
}

export type MarkDeadResult =
  | { ok: true }
  | { ok: false; refused: true; reason: string };

/**
 * Writes Outreach_Status=Dead on Listings_V1 and appends a dated reason
 * line to Verification_Notes — REFUSES (writes nothing) when the record
 * carries Contract_Executed_At. Signed deals never die this way; they route
 * to a termination-card decision for the operator instead
 * (see lib/pipeline/death-rule.ts's executed_needs_termination_card verdict).
 */
export async function markRecordDead(
  recordId: string,
  reason: string,
  opts: MarkDeadOptions = {},
): Promise<MarkDeadResult> {
  const record = opts.record !== undefined ? opts.record : await getListing(recordId);
  if (!record) {
    return { ok: false, refused: true, reason: "record_not_found" };
  }
  if (record.contractExecutedAt) {
    return {
      ok: false,
      refused: true,
      reason: "contract_executed_at_set — signed deals never die via the death rule",
    };
  }

  const now = opts.now ?? new Date();
  const stamp = now.toISOString().slice(0, 10);
  const line = `${stamp} — Death rule: ${reason}`;
  const existingNotes = record.notes ?? "";

  await updateListingRecord(recordId, {
    Outreach_Status: "Dead",
    Verification_Notes: existingNotes ? `${existingNotes}\n${line}` : line,
  });

  return { ok: true };
}
