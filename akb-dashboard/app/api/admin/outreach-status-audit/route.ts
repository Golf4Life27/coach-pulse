// Outreach_Status truth audit — reviewable correction proposal.
// @agent: sentinel
//
// GET /api/admin/outreach-status-audit
//   → DRY-RUN by default. Scans every listing (includeLegacy), classifies
//     each reply-claiming status against contact signals, returns the
//     reviewable correction list (impossible / unverified / supported).
//     Writes NOTHING.
//   ?apply=1&confirm=FIX-OUTREACH-STATUS-YYYY-MM-DD
//     → applies ONLY the "impossible" corrections (never-contacted records
//       reverted to empty Outreach_Status). "unverified" records are never
//       auto-written — they require a conversation (Quo/Gmail) check first.
//       Gated behind today's-date confirm token (replay protection).
//
// Engine note: this writes Outreach_Status (a legacy field), NOT
// Pipeline_Stage. Once Outreach_Status is corrected, the stage engine
// re-derives the stage on its next pass (it had derived "responded" FROM
// the corrupt Outreach_Status), so the fix propagates without a raw
// Pipeline_Stage write.
//
// Auth: dashboard cookie / CRON_SECRET / OAuth waterfall.

import { NextResponse } from "next/server";
import { getListings, updateListingRecord } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import { auditOutreachStatuses, type OutreachAuditInput } from "@/lib/outreach-status-audit";

export const runtime = "nodejs";
export const maxDuration = 120;

function todayToken(now = new Date()): string {
  return `FIX-OUTREACH-STATUS-${now.toISOString().slice(0, 10)}`;
}

export async function GET(req: Request) {
  const t0 = Date.now();

  const cookieHeader = req.headers.get("cookie");
  let authKind = "none";
  if (hasDashboardSession(cookieHeader)) {
    authKind = "dashboard_session";
  } else {
    const env = readAuthEnv();
    const headers = readAuthHeaders(req);
    const authRequired = kvConfigured() || env.cronSecret !== null || env.bearerDevToken !== null;
    if (authRequired) {
      const auth = await authenticate(headers, env, kvProd);
      if (!auth.ok) return NextResponse.json({ error: "unauthorized", reason: auth.reason }, { status: 401 });
      authKind = auth.kind;
    }
  }

  const url = new URL(req.url);
  const apply = url.searchParams.get("apply") === "1";
  const confirm = url.searchParams.get("confirm");

  let listings;
  try {
    listings = await getListings({ includeLegacy: true });
  } catch (err) {
    return NextResponse.json(
      { error: "listings_fetch_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  const inputs: OutreachAuditInput[] = listings.map((l) => ({
    id: l.id,
    address: l.address,
    state: l.state,
    sourceVersion: l.sourceVersion,
    outreachStatus: l.outreachStatus,
    lastInboundAt: l.lastInboundAt ?? null,
    lastOutboundAt: l.lastOutboundAt ?? null,
    executionPath: l.executionPath,
  }));

  const { findings, summary } = auditOutreachStatuses(inputs);

  // ── Apply (impossible-only, gated) ───────────────────────────────
  let applied: { attempted: number; written: number; errors: string[] } | null = null;
  if (apply) {
    if (confirm !== todayToken()) {
      return NextResponse.json(
        { error: "confirm_required", expected: todayToken(), note: "apply writes only the 'impossible' set; unverified records are never auto-written" },
        { status: 409 },
      );
    }
    const impossible = findings.filter((f) => f.verdict === "impossible");
    const errors: string[] = [];
    let written = 0;
    for (const f of impossible) {
      if (Date.now() - t0 > 100_000) break;
      try {
        // Revert to pre-outreach empty. The engine re-derives stage next pass.
        await updateListingRecord(f.id, { Outreach_Status: "" });
        written++;
        await audit({
          agent: "sentinel",
          event: "outreach_status_corrected",
          status: "confirmed_success",
          recordId: f.id,
          inputSummary: { from: f.outreachStatus, verdict: f.verdict, reason: f.reasoning },
          outputSummary: { to: "" },
          decision: "reverted_unbacked_reply_status",
        });
      } catch (err) {
        errors.push(`${f.id}: ${String(err).slice(0, 120)}`);
      }
    }
    applied = { attempted: impossible.length, written, errors };
  }

  await audit({
    agent: "sentinel",
    event: "outreach_status_audit",
    status: "confirmed_success",
    inputSummary: { auth_kind: authKind, apply },
    outputSummary: { ...summary, applied_written: applied?.written ?? 0 },
    ms: Date.now() - t0,
  });

  return NextResponse.json({
    ok: true,
    auth_kind: authKind,
    mode: apply ? "apply" : "dry_run",
    summary,
    applied,
    // Full reviewable list — impossible + unverified first (supported last).
    findings,
    duration_ms: Date.now() - t0,
  });
}
