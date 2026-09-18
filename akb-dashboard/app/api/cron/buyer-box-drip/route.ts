// BUY-BOX DRIP CRON — automated, so buyers fill their own box without the
// operator chasing them (operator ruling 2026-09-18, Spine
// recnmCDflZ43MEsDp). @agent: scout
//
// GET. For every buyer eligible per lib/buyers/box-drip.selectDripCandidates
// (email on file, no price box, intake form not completed, not
// opted-out/DNC/inactive, next step's gap satisfied): compose the
// deterministic step email, send it live (not a draft), and stamp
// Box_Drip_Step / Box_Drip_Last_At / Email_Sent_At (if unset) / a one-line
// Notes stamp on success. A failed send is audited and skipped — nothing is
// stamped, so the next run retries it.
//
// Auth waterfall + MAVERICK_CRON_ENABLED kill switch match dispo-trigger.
// BUYER_DRIP_HARD_DISABLE=true is a harder kill: 200 { held: true }, nothing
// read or sent. ?dry_run=true reports the plan (who, which step, subject)
// without sending or writing anything. ?limit=N caps the batch (default 20,
// ceiling 40).

import { NextResponse } from "next/server";
import { listBuyersV2, updateBuyerV2, BUYER_V2_FIELDS } from "@/lib/buyers-v2";
import { selectDripCandidates, composeDripEmail, dripIntakeUrl } from "@/lib/buyers/box-drip";
import { sendEmail } from "@/lib/gmail";
import { audit } from "@/lib/audit-log";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import { resolveBaseUrl } from "@/lib/maverick/decision-card";

export const runtime = "nodejs";
export const maxDuration = 120;

const FALLBACK_BASE_URL = "https://coach-pulse-ten.vercel.app";
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 40;

function clampLimit(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

function stamp(dateIso: string): string {
  return dateIso.slice(0, 10);
}

interface PlanRow {
  buyerId: string;
  name: string;
  step: 1 | 2 | 3;
  subject: string;
}

interface OutcomeRow extends PlanRow {
  sent: boolean;
  error?: string;
}

export async function GET(req: Request) {
  const t0 = Date.now();

  // ── Auth waterfall (+ dashboard cookie) — copied from dispo-trigger. ──
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
  if (authKind === "cron" && process.env.MAVERICK_CRON_ENABLED !== "true") {
    return NextResponse.json({ error: "cron_disabled" }, { status: 503 });
  }

  // ── Hard kill switch — nothing read, nothing sent. ──
  if (process.env.BUYER_DRIP_HARD_DISABLE === "true") {
    await audit({
      agent: "scout",
      event: "buyer_box_drip_held",
      status: "uncertain",
      decision: "hard_disable",
    }).catch(() => {});
    return NextResponse.json({ held: true });
  }

  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dry_run") === "true";
  const limit = clampLimit(url.searchParams.get("limit"));

  let buyers;
  try {
    buyers = await listBuyersV2();
  } catch (err) {
    return NextResponse.json({ error: "buyers_fetch_failed", detail: String(err).slice(0, 200) }, { status: 502 });
  }

  const nowIso = new Date().toISOString();
  const candidates = selectDripCandidates(buyers, nowIso, limit);
  const baseUrl = resolveBaseUrl() ?? FALLBACK_BASE_URL;

  const plan: PlanRow[] = candidates.map(({ buyer, step }) => {
    const { subject } = composeDripEmail({
      buyerName: buyer.name,
      step,
      markets: buyer.markets,
      intakeUrl: dripIntakeUrl(baseUrl, buyer.id),
    });
    return { buyerId: buyer.id, name: buyer.name, step, subject };
  });

  if (dryRun) {
    await audit({
      agent: "scout",
      event: "buyer_box_drip_dry_run",
      status: "confirmed_success",
      inputSummary: { limit },
      outputSummary: { candidates: plan.length },
      ms: Date.now() - t0,
    }).catch(() => {});
    return NextResponse.json({ ok: true, dry_run: true, held: false, candidates: plan.length, plan, ms: Date.now() - t0 });
  }

  const outcomes: OutcomeRow[] = [];
  for (const { buyer, step } of candidates) {
    const { subject, body } = composeDripEmail({
      buyerName: buyer.name,
      step,
      markets: buyer.markets,
      intakeUrl: dripIntakeUrl(baseUrl, buyer.id),
    });
    const row: OutcomeRow = { buyerId: buyer.id, name: buyer.name, step, subject, sent: false };
    outcomes.push(row);
    try {
      const res = await sendEmail({ to: buyer.email as string, subject, body });
      if (!res.success) throw new Error(res.error ?? "Gmail send failed");
      row.sent = true;

      const fields: Record<string, unknown> = {
        [BUYER_V2_FIELDS.Box_Drip_Step]: step,
        [BUYER_V2_FIELDS.Box_Drip_Last_At]: nowIso,
        [BUYER_V2_FIELDS.Notes]: `${buyer.notes ? buyer.notes + "\n" : ""}[${stamp(nowIso)}] Box drip ${step} sent`,
      };
      if (!buyer.emailSentAt) fields[BUYER_V2_FIELDS.Email_Sent_At] = nowIso;
      // Reply-ingestion key (app/api/cron/dispo-buyer-replies), same role
      // Dispo_Blast_Thread_Id plays for blast replies — a STOP reply on this
      // thread is what lets the drip stop itself.
      if (res.threadId) fields[BUYER_V2_FIELDS.Box_Drip_Thread_Id] = res.threadId;
      await updateBuyerV2(buyer.id, fields);
    } catch (err) {
      row.error = String(err);
      await audit({
        agent: "scout",
        event: "buyer_box_drip_send_failed",
        status: "confirmed_failure",
        recordId: buyer.id,
        decision: `step_${step}`,
        error: row.error,
      }).catch(() => {});
    }
  }

  const sent = outcomes.filter((o) => o.sent).length;
  const failed = outcomes.length - sent;

  await audit({
    agent: "scout",
    event: "buyer_box_drip_live",
    status: failed > 0 && sent === 0 ? "confirmed_failure" : "confirmed_success",
    inputSummary: { candidates: candidates.length, limit },
    outputSummary: { sent, failed },
    ms: Date.now() - t0,
  }).catch(() => {});

  return NextResponse.json({ ok: true, dry_run: false, held: false, candidates: outcomes.length, sent, failed, outcomes, ms: Date.now() - t0 });
}
