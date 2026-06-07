// Durable Spine_Decision_Log row count — fixes the Pulse "zero writes"
// false alarm.
// @agent: pulse
//
// THE BUG (operator brief 2026-06-07):
//   The spine_write_rate_low detector counted write_state.* events in the
//   audit_log buffer (capped at 500 entries via readRecentFromKv).
//   In production the audit log fills with high-frequency cron events
//   (stale-triage every 30min, quo-sync hourly, etc.), so 500 entries
//   may not span the detector's 48h window. ~20 real write_state writes
//   landed in the Spine_Decision_Log Airtable table but were INVISIBLE
//   to the detector because they aged off the front of the 500-entry pull.
//
// THE FIX:
//   Query Spine_Decision_Log directly via filterByFormula on the
//   Decision_Date field. Cheap (Airtable rows are small, single page) and
//   AUTHORITATIVE — the table IS the source of truth.
//
// Used by app/api/agents/pulse/scan/route.ts: the route fetches the
// durable count and passes it to the detector, which prefers durable over
// audit when available.

const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
const SPINE_TABLE_ID = "tblbp91DB5szxsJpT";
const SPINE_F_DATE = "fld36Jlm4Fo4vLG1L";

/** Live: count Spine_Decision_Log rows whose Decision_Date ≥ `sinceIso`.
 *  Never throws — returns null on any failure so the detector falls back
 *  to the audit-log path gracefully. */
export async function countSpineRowsSince(sinceIso: string): Promise<number | null> {
  if (!AIRTABLE_PAT) return null;
  try {
    const url = new URL(`https://api.airtable.com/v0/${BASE_ID}/${SPINE_TABLE_ID}`);
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("returnFieldsByFieldId", "true");
    // Date-only IS_AFTER (the field is a Date, not DateTime). Truncate to
    // 10 chars ("YYYY-MM-DD"). 48h-window callers should subtract days
    // before formatting.
    url.searchParams.set("filterByFormula", `IS_AFTER({${SPINE_F_DATE}}, "${sinceIso.slice(0, 10)}")`);
    url.searchParams.append("fields[]", SPINE_F_DATE);
    let total = 0;
    let offset: string | undefined;
    // Bounded paging — Spine is small but defensive against runaway.
    for (let i = 0; i < 5; i++) {
      const u = new URL(url.toString());
      if (offset) u.searchParams.set("offset", offset);
      const res = await fetch(u.toString(), { headers: { Authorization: `Bearer ${AIRTABLE_PAT}` }, cache: "no-store" });
      if (!res.ok) return null;
      const body = (await res.json()) as { records?: Array<unknown>; offset?: string };
      total += Array.isArray(body.records) ? body.records.length : 0;
      offset = typeof body.offset === "string" ? body.offset : undefined;
      if (!offset) break;
    }
    return total;
  } catch {
    return null;
  }
}
