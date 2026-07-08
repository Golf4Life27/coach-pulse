// Operator action items — the things that need Alex's decision.
//
// GET   /api/operator-actions            → open + in_progress items
// PATCH /api/operator-actions {id,status} → set status (resolved/deferred/…)
//
// Wire #2 of the dashboard reconciliation (SYSTEM_HANDOFF.md): the
// Operator_Action_Items table (e.g. cold seller counters surfaced by the
// Quo sweep) was written but nothing displayed it. This route lets the
// Queue show + clear them.

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
const TABLE = "tblZRunAe5OaMTRCM"; // Operator_Action_Items
const VALID_STATUS = new Set(["open", "in_progress", "resolved", "deferred"]);

export async function GET() {
  if (!AIRTABLE_PAT) return NextResponse.json({ error: "airtable_not_configured" }, { status: 500 });
  // Anti-staleness gate (operator 2026-07-08: six June-era ghosts haunted
  // /queue for a month — "stale and need to disappear"). An action item
  // older than 14 days is no longer a decision; it was either handled
  // out-of-band or the thread went cold and belongs to re-engagement.
  const formula = `AND(OR({Status}='open',{Status}='in_progress'), IS_AFTER(CREATED_TIME(), DATEADD(NOW(), -14, 'days')))`;
  const url =
    `https://api.airtable.com/v0/${BASE_ID}/${TABLE}` +
    `?filterByFormula=${encodeURIComponent(formula)}&pageSize=100`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_PAT}` }, cache: "no-store" });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return NextResponse.json({ error: "airtable_error", status: res.status, detail: detail.slice(0, 200) }, { status: 502 });
    }
    const data = (await res.json()) as { records?: Array<{ id: string; fields: Record<string, unknown> }> };
    const rank: Record<string, number> = { high: 0, medium: 1, low: 2 };
    const items = (data.records ?? []).map((r) => {
      const f = r.fields;
      return {
        id: r.id,
        title: typeof f.Title === "string" ? f.Title : "(untitled)",
        sourceRecordId: typeof f.Source_Record_Id === "string" ? f.Source_Record_Id : null,
        actionRequired: typeof f.Action_Required === "string" ? f.Action_Required : null,
        context: typeof f.Context === "string" ? f.Context : null,
        verbatimReply: typeof f.Verbatim_Reply === "string" ? f.Verbatim_Reply : null,
        status: typeof f.Status === "string" ? f.Status : "open",
        priority: typeof f.Priority === "string" ? f.Priority : "medium",
        createdAt: typeof f.Created_At === "string" ? f.Created_At : null,
      };
    });
    items.sort((a, b) => (rank[a.priority] ?? 1) - (rank[b.priority] ?? 1) || (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
    return NextResponse.json({ items });
  } catch (err) {
    return NextResponse.json({ error: "fetch_failed", detail: String(err) }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  if (!AIRTABLE_PAT) return NextResponse.json({ error: "airtable_not_configured" }, { status: 500 });
  let body: { id?: string; status?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const { id, status } = body;
  if (!id || !id.startsWith("rec")) return NextResponse.json({ error: "bad_id" }, { status: 400 });
  if (!status || !VALID_STATUS.has(status)) return NextResponse.json({ error: "bad_status" }, { status: 400 });
  const url = `https://api.airtable.com/v0/${BASE_ID}/${TABLE}/${id}`;
  try {
    const res = await fetch(url, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${AIRTABLE_PAT}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { Status: status }, typecast: true }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return NextResponse.json({ error: "airtable_error", status: res.status, detail: detail.slice(0, 200) }, { status: 502 });
    }
    return NextResponse.json({ ok: true, id, status });
  } catch (err) {
    return NextResponse.json({ error: "patch_failed", detail: String(err) }, { status: 500 });
  }
}
