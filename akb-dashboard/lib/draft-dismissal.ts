// Dead-deal draft dismissal — a dying deal takes its queued draft with it.
// @agent: crier
//
// THE HAZARD THIS CLOSES (2026-07-16): 3123 Sunbeam was terminated, but its
// pre-termination queued draft ("I will get the earnest money delivered by
// July 16") survived on the record — a live Send button promising money on a
// dead deal. Every status-flip site (d3 cadence, dispose-listing, bulk admin,
// kill_dead_deal approve, manual Mark Dead) funnels through
// updateListingRecord, so ONE hook there covers all of them, present and
// future — the two-map lesson applied to write paths.
//
// PURE decision here; the caller (lib/airtable.updateListingRecord) supplies
// the record's current Draft_Reply_Meta and merges the returned fields.

/** Outreach statuses that end the conversation — a queued/held draft must
 *  never survive a flip into one of these. */
export const TERMINAL_OUTREACH_STATUSES: ReadonlySet<string> = new Set([
  "Dead",
  "Walked",
  "Terminated",
]);

/** The status value a fields payload is flipping to, if any. Airtable single
 *  selects arrive as a bare string on write payloads. */
export function terminalStatusInFields(fields: Record<string, unknown>): string | null {
  const v = fields["Outreach_Status"];
  if (typeof v === "string" && TERMINAL_OUTREACH_STATUSES.has(v)) return v;
  return null;
}

/** Pure: given the update payload and the record's CURRENT draft meta, decide
 *  the dismissal fields to merge — or null when nothing needs doing. Only a
 *  live (queued/hold) draft is dismissed; sent/dismissed history is preserved,
 *  and the meta's inbound_msg_id is carried so ingest idempotency survives.
 *  A caller explicitly writing the draft fields wins (no override). */
export function deadFlipDraftDismissal(
  fields: Record<string, unknown>,
  currentMetaRaw: string | null | undefined,
  nowIso: string,
): Record<string, unknown> | null {
  const status = terminalStatusInFields(fields);
  if (!status) return null;
  if ("Draft_Reply_Text" in fields || "Draft_Reply_Meta" in fields) return null;
  if (!currentMetaRaw || !currentMetaRaw.trim()) return null;
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(currentMetaRaw) as Record<string, unknown>;
  } catch {
    return null; // unreadable mirror — leave it; nothing renders from garbage
  }
  if (meta.state !== "queued" && meta.state !== "hold") return null;
  return {
    Draft_Reply_Text: "",
    Draft_Reply_Meta: JSON.stringify({
      ...meta,
      state: "dismissed",
      hold_reason: `deal_${status.toLowerCase()}_auto_dismiss`,
      dismissed_at: nowIso,
    }),
  };
}
