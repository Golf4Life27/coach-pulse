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

// ── Single source of truth for reply drafts (2026-07-18, the Canfield
// two-drafts mess) ─────────────────────────────────────────────────────────
//
// A reply draft lives in TWO stores: the record's Draft_Reply_Text/Meta
// (what Live Deals renders and what dismissals/replacements update) and a
// Pending jarvis_reply row in Agent_Proposals (what the deal page and the
// queue rendered). Nothing synced them: replacing or dismissing the record
// draft left the proposal Pending forever, so the deal page showed a STALE
// draft ("what did I miss?") while Live Deals showed the current one — two
// surfaces, two different messages, both "ready to fire". Six Pending
// proposals survived on DEAD Sunbeam the same way.
//
// THE RULE: the record's Draft_Reply_Meta is the ONE live pointer. A
// jarvis_reply proposal renders ONLY while the record's meta is queued/hold
// AND names that proposal's Proposal_ID. Everything else is history.

/** Pure: is this proposal the record's LIVE draft? */
export function proposalIsLiveDraft(
  proposalKey: string | null | undefined,
  draftMetaRaw: string | null | undefined,
): boolean {
  if (!proposalKey || !draftMetaRaw || !draftMetaRaw.trim()) return false;
  try {
    const meta = JSON.parse(draftMetaRaw) as Record<string, unknown>;
    if (meta.state !== "queued" && meta.state !== "hold") return false;
    return meta.proposal_id === proposalKey;
  } catch {
    return false;
  }
}

/** Pure: drop jarvis_reply rows whose record no longer points at them.
 *  Non-reply proposal types pass through untouched — this gate is about
 *  draft staleness, not proposal routing. Both id namespaces are accepted
 *  (the human Proposal_ID the sync crons stamp AND the Airtable rec… row
 *  id) — mirrors the tolerance in /api/proposals' draft-state mirror. */
export function filterLiveReplyProposals<
  T extends { id: string; proposalType: string; recordId: string; proposalKey?: string | null },
>(rows: T[], draftMetaByRecordId: ReadonlyMap<string, string | null | undefined>): T[] {
  return rows.filter((row) => {
    if (row.proposalType !== "jarvis_reply") return true;
    const meta = draftMetaByRecordId.get(row.recordId);
    return proposalIsLiveDraft(row.proposalKey ?? null, meta) || proposalIsLiveDraft(row.id, meta);
  });
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
