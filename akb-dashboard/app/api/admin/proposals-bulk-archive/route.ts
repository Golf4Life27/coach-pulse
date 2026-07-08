// Agent_Proposals bulk archive — the queue-hygiene purge lever.
//
// Operator 2026-07-08 ("AGENT QUEUE (1280 pending)... manually sifting
// through noise kills this automation effort"): the propose-actions lane
// accumulated 1,200+ Pending housekeeping proposals (FOLLOW UP / KILL DEAD
// DEAL / …) that bury the handful of jarvis_reply items the operator must
// actually act on.
//
// GET /api/admin/proposals-bulk-archive
//   default        DRY-RUN: counts Pending by Proposal_Type; reports what
//                  WOULD be archived.
//   ?apply=1       flips matching proposals Status → "Archived" (typecast
//                  creates the choice on first use). NEVER touches
//                  jarvis_reply proposals, and never touches proposals
//                  younger than ?keep_hours (default 24h) so today's fresh
//                  housekeeping survives.
//   ?keep_hours=N  freshness carve-out (default 24).
//
// Auth: CRON_SECRET / cron-header waterfall, same posture as the other
// admin routes. Bounded: pages of 100, PATCHes of 10, 250s wall clock.

import { NextResponse } from "next/server";
import { audit } from "@/lib/audit-log";

export const runtime = "nodejs";
export const maxDuration = 300;

const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
const TABLE = process.env.AGENT_PROPOSALS_TABLE_ID ?? null;
const BUDGET_MS = 250_000;
const PROTECTED_TYPES = new Set(["jarvis_reply"]);

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  if (auth === `Bearer ${secret}`) return true;
  return req.headers.get("x-vercel-cron") === "1" && auth === `Bearer ${secret}`;
}

interface Row {
  id: string;
  createdTime: string;
  fields: Record<string, unknown>;
}

export async function GET(req: Request) {
  const t0 = Date.now();
  if (!AIRTABLE_PAT) return NextResponse.json({ error: "airtable_not_configured" }, { status: 500 });
  if (!TABLE) return NextResponse.json({ error: "AGENT_PROPOSALS_TABLE_ID not set" }, { status: 500 });
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const apply = url.searchParams.get("apply") === "1";
  const keepHoursRaw = Number(url.searchParams.get("keep_hours"));
  const keepHours = Number.isFinite(keepHoursRaw) && keepHoursRaw >= 0 ? keepHoursRaw : 24;
  const cutoffMs = Date.now() - keepHours * 3_600_000;

  // Page through ALL Pending rows (id + type only — cheap).
  const rows: Row[] = [];
  let offset: string | undefined;
  do {
    const p = new URLSearchParams();
    p.set("filterByFormula", `{Status}="Pending"`);
    p.append("fields[]", "Proposal_Type");
    p.set("pageSize", "100");
    if (offset) p.set("offset", offset);
    const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLE}?${p.toString()}`, {
      headers: { Authorization: `Bearer ${AIRTABLE_PAT}` },
      cache: "no-store",
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: "airtable_error", status: res.status, detail: (await res.text()).slice(0, 200) },
        { status: 502 },
      );
    }
    const data = await res.json();
    rows.push(...(data.records as Row[]));
    offset = data.offset;
  } while (offset && Date.now() - t0 < BUDGET_MS);

  const byType: Record<string, number> = {};
  const targets: string[] = [];
  for (const r of rows) {
    const type = typeof r.fields["Proposal_Type"] === "string" ? (r.fields["Proposal_Type"] as string) : "unknown";
    byType[type] = (byType[type] ?? 0) + 1;
    const created = Date.parse(r.createdTime);
    if (!PROTECTED_TYPES.has(type) && Number.isFinite(created) && created < cutoffMs) {
      targets.push(r.id);
    }
  }

  if (!apply) {
    return NextResponse.json({
      mode: "dry_run",
      pending_total: rows.length,
      pending_by_type: byType,
      would_archive: targets.length,
      protected_types: [...PROTECTED_TYPES],
      keep_hours: keepHours,
    });
  }

  // Apply: PATCH in Airtable's max batch of 10, wall-clock bounded.
  let archived = 0;
  let errors = 0;
  for (let i = 0; i < targets.length && Date.now() - t0 < BUDGET_MS; i += 10) {
    const batch = targets.slice(i, i + 10).map((id) => ({ id, fields: { Status: "Archived" } }));
    const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLE}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${AIRTABLE_PAT}`, "Content-Type": "application/json" },
      body: JSON.stringify({ records: batch, typecast: true }),
    });
    if (res.ok) archived += batch.length;
    else errors++;
  }

  await audit({
    agent: "maverick",
    event: "proposals_bulk_archive",
    status: errors === 0 ? "confirmed_success" : "uncertain",
    inputSummary: { pending_total: rows.length, targets: targets.length, keep_hours: keepHours },
    outputSummary: { archived, errors, remaining_pending: rows.length - archived },
    decision: "queue_hygiene_purge",
  });

  return NextResponse.json({
    mode: "apply",
    pending_total_before: rows.length,
    archived,
    errors,
    remaining_unarchived_targets: targets.length - archived,
    pending_by_type_before: byType,
    duration_ms: Date.now() - t0,
  });
}
