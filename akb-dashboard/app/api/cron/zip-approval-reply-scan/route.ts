// ZIP approval SMS sweep (Workstream D1, item 5).
// @agent: scout
//
// GET /api/cron/zip-approval-reply-scan
//
// Sub-daily cron (Vercel Pro — Hobby's daily-only cap no longer binds).
// Two sweeps over ZIP_Registry where Market_Tier=approval_pending:
//
//   1. Notify sweep — any pending ZIP not yet SMS'd gets an outbound
//      "Reply YES/NO [ZIP]" prompt (idempotent via Approval_Notified_
//      Channels). This is the backstop for ZIPs that entered
//      approval_pending out-of-band; in-code flips notify immediately.
//
//   2. Reply sweep — poll the operator's inbound OpenPhone messages,
//      parse "YES [ZIP]" / "NO [ZIP]" (strict command parser), and flip
//      the matching pending ZIP to active / paused with Approval_Method
//      ="sms". Idempotent: once a ZIP leaves approval_pending a repeated
//      reply finds no pending row and is a no-op.

import { NextResponse } from "next/server";
import { audit } from "@/lib/audit-log";
import { writeState } from "@/lib/maverick/write-state";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import { getMessagesForParticipant } from "@/lib/quo";
import {
  getApprovalPendingRows,
  approveZip,
  rejectZip,
  type ZipRegistryRow,
} from "@/lib/zip-registry";
import { notifyZipApprovalPending, readOperatorTarget } from "@/lib/zip-approval/notify";
import { parseZipApprovalReply } from "@/lib/zip-approval/reply-parser";

export const runtime = "nodejs";
export const maxDuration = 60;

const APPROVAL_GATE_SPINE = "recGtpPH4YxvUL2V8";
const REPLY_WINDOW_MIN = Number(process.env.ZIP_APPROVAL_REPLY_WINDOW_MIN ?? "30");

export async function GET(req: Request) {
  const t0 = Date.now();

  // ── Auth waterfall (mirrors listings-intake) ───────────────────
  const cookieHeader = req.headers.get("cookie");
  let authKind: "dashboard_session" | "oauth" | "cron" | "bearer_dev" | "none" = "none";
  if (hasDashboardSession(cookieHeader)) {
    authKind = "dashboard_session";
  } else {
    const env = readAuthEnv();
    const headers = readAuthHeaders(req);
    const authRequired = kvConfigured() || env.cronSecret !== null || env.bearerDevToken !== null;
    if (authRequired) {
      const auth = await authenticate(headers, env, kvProd);
      if (!auth.ok) {
        return NextResponse.json({ error: "unauthorized", reason: auth.reason }, { status: 401 });
      }
      authKind = auth.kind;
    }
  }
  if (authKind === "cron" && process.env.MAVERICK_CRON_ENABLED !== "true") {
    return NextResponse.json({ error: "cron_disabled" }, { status: 503 });
  }

  const summary = {
    pending: 0,
    notified: 0,
    notify_skipped: 0,
    inbound_scanned: 0,
    replies_parsed: 0,
    approved: 0,
    rejected: 0,
    unmatched_replies: [] as Array<{ zip: string; decision: string }>,
    errors: [] as string[],
  };

  let pending: ZipRegistryRow[];
  try {
    pending = await getApprovalPendingRows();
  } catch (err) {
    return NextResponse.json(
      { error: "registry_fetch_failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
  summary.pending = pending.length;

  // ── Sweep 1: notify un-SMS'd pending ZIPs ───────────────────────
  for (const row of pending) {
    try {
      const r = await notifyZipApprovalPending(row);
      if (r.sent) summary.notified++;
      else summary.notify_skipped++;
    } catch (err) {
      summary.errors.push(`notify ${row.zip}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Sweep 2: parse inbound YES/NO [ZIP] replies ─────────────────
  // Track rows flipped this run so a second reply for the same ZIP in
  // the same window doesn't double-act. Skip the inbound poll entirely
  // when nothing is pending (the common case) — no reply can match.
  const flipped = new Set<string>();
  if (pending.length > 0 && process.env.QUO_API_KEY) {
    try {
      const messages = await getMessagesForParticipant(readOperatorTarget(), REPLY_WINDOW_MIN);
      const inbound = messages.filter((m) => m.direction === "incoming");
      summary.inbound_scanned = inbound.length;

      for (const msg of inbound) {
        const parsed = parseZipApprovalReply(msg.body);
        if (!parsed) continue;
        summary.replies_parsed++;

        const row = pending.find((r) => r.zip === parsed.zip && !flipped.has(r.recordId));
        if (!row) {
          summary.unmatched_replies.push({ zip: parsed.zip, decision: parsed.decision });
          continue;
        }

        const approvedBy = `operator (sms ${msg.from}) @ ${new Date().toISOString()}`;
        try {
          if (parsed.decision === "approve") {
            await approveZip(row.recordId, { approvedBy, method: "sms" });
            summary.approved++;
          } else {
            await rejectZip(row.recordId, { approvedBy, method: "sms", existingNotes: row.notes });
            summary.rejected++;
          }
          flipped.add(row.recordId);

          const nextTier = parsed.decision === "approve" ? "active" : "paused";
          await writeState({
            event_type: "decision",
            attribution_agent: "scout",
            title: `ZIP ${row.zip} ${parsed.decision === "approve" ? "APPROVED" : "REJECTED"} (SMS) → ${nextTier}`,
            description:
              `Operator ${parsed.decision === "approve" ? "approved" : "rejected"} ZIP ${row.zip} ` +
              `(${[row.market, row.state].filter(Boolean).join(", ")}) by SMS reply "${msg.body.slice(0, 60)}". ` +
              `Market_Tier approval_pending → ${nextTier}. ${approvedBy}.`,
            related_spine_decision: APPROVAL_GATE_SPINE,
          });
        } catch (err) {
          summary.errors.push(
            `decision ${row.zip}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err) {
      summary.errors.push(`inbound_scan: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await audit({
    agent: "scout",
    event: "zip_approval_reply_scan",
    status: summary.errors.length > 0 ? "uncertain" : "confirmed_success",
    inputSummary: { auth_kind: authKind, pending: summary.pending, window_min: REPLY_WINDOW_MIN },
    outputSummary: {
      notified: summary.notified,
      approved: summary.approved,
      rejected: summary.rejected,
      replies_parsed: summary.replies_parsed,
      unmatched: summary.unmatched_replies.length,
    },
    ms: Date.now() - t0,
  });

  return NextResponse.json({ ok: true, auth_kind: authKind, duration_ms: Date.now() - t0, ...summary });
}
