// Email recovery lane (operator "get started" 2026-07-11). @agent: crier
//
// GET|POST /api/cron/email-recovery
//   ?live=1    — actually send (default: DRY report of exactly what would
//                go out, priced). The cron slot runs dry until the env
//                EMAIL_RECOVERY_LIVE=true; the controlled workflow can pass
//                ?live=1 for an operator-clicked live run after reviewing
//                the dry output (no env surgery needed).
//   ?limit=N   — cap sends per run (default 5, max 15).
//
// WHAT IT DOES: Dead-by-carrier records (SMS undeliverable) that carry an
// Agent_Email get ONE value-anchored email opener — the same seed pricer as
// the SMS lane, every guard intact (HOLD → skip; never a list fraction).
// First touch by email: the SMS never delivered, so there is no sticky
// number to honor; the priced number becomes this record's stamped number.
//
// RAILS: v2-only; Do_Not_Text respected across channels; property-local
// business hours; per-run cap; KV claim per record + a notes stamp makes it
// one recovery email per record EVER; Gmail send is positively confirmed by
// lib/gmail (SENT label verification) before the record is stamped.
//
// NEW LANE, NEW FILES ONLY — no send/intake pipeline files touched.

import { NextResponse } from "next/server";
import { getListings, updateListingRecord } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import { sendEmail } from "@/lib/gmail";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import { priceOpenerWithSeed } from "@/lib/opener-pricing";
import { getZipArvSeed, type ZipArvSeed } from "@/lib/zip-arv-seed-store";
import { getMarketForListing, openerArvPctMax } from "@/lib/markets/registry";
import { resolveAnchorPct } from "@/lib/markets/anchor";
import { minOfferFloor } from "@/lib/per-market-pricer";
import { evaluateSendWindow } from "@/lib/h2-working-hours";
import {
  selectEmailRecoveryCandidates,
  buildRecoveryEmail,
  buildEmailSentNote,
} from "@/lib/email-recovery";

export const runtime = "nodejs";
export const maxDuration = 120;

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 15;
const CLAIM_TTL_S = 30 * 86_400;
const claimKey = (recordId: string) => `email:recovery:${recordId}`;

async function handle(req: Request): Promise<Response> {
  const t0 = Date.now();
  const url = new URL(req.url);

  const cookieHeader = req.headers.get("cookie");
  let authKind = "none";
  if (hasDashboardSession(cookieHeader)) authKind = "dashboard_session";
  else {
    const env = readAuthEnv();
    const headers = readAuthHeaders(req);
    const authRequired = kvConfigured() || env.cronSecret !== null || env.bearerDevToken !== null;
    if (authRequired) {
      const auth = await authenticate(headers, env, kvProd);
      if (!auth.ok) return NextResponse.json({ error: "unauthorized", reason: auth.reason }, { status: 401 });
      authKind = auth.kind;
    }
  }
  const forceRun = url.searchParams.get("force_run") === "1";
  if (authKind === "cron" && process.env.MAVERICK_CRON_ENABLED !== "true" && !forceRun) {
    return NextResponse.json({ error: "cron_disabled" }, { status: 503 });
  }

  // Watched-first posture for a brand-new outbound channel: live requires
  // the env OR an explicit ?live=1 from the authed controlled workflow.
  const live = process.env.EMAIL_RECOVERY_LIVE === "true" || url.searchParams.get("live") === "1";
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(MAX_LIMIT, Math.floor(limitRaw)) : DEFAULT_LIMIT;

  let all;
  try {
    all = await getListings();
  } catch (err) {
    return NextResponse.json(
      { error: "listings_fetch_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  const candidates = selectEmailRecoveryCandidates(all);

  const anchorCache = new Map<string, number>();
  const seedCache = new Map<string, ZipArvSeed | null>();
  const rows: Array<{
    record_id: string;
    address: string;
    to: string;
    offer: number | null;
    status: string;
    detail: string | null;
    subject?: string;
  }> = [];
  let sent = 0;

  for (const l of candidates) {
    if (sent >= limit) break;
    if (Date.now() - t0 > 100_000) break;

    // Price via the SAME canonical seed pricer as the SMS lane — HOLD skips.
    const market = getMarketForListing({ state: l.state, zip: l.zip });
    const marketId = market?.id ?? "";
    let anchorPct = anchorCache.get(marketId);
    if (anchorPct == null) {
      anchorPct = await resolveAnchorPct(marketId || null);
      anchorCache.set(marketId, anchorPct);
    }
    const zip5 = (l.zip ?? "").trim();
    if (zip5 && !seedCache.has(zip5)) {
      seedCache.set(zip5, await getZipArvSeed(zip5).catch(() => null));
    }
    const pw = priceOpenerWithSeed({
      listPrice: l.listPrice ?? null,
      storedArv: l.realArvMedian ?? null,
      storedArvConfidence: l.arvConfidence ?? null,
      estRehabMid: l.estRehabMid ?? null,
      estRehab: l.estRehab ?? null,
      sqft: l.buildingSqFt ?? null,
      arvPctMax: openerArvPctMax(market, l.state),
      wholesaleFee: l.wholesaleFeeTarget ?? null,
      anchorPct,
      seed: zip5 ? (seedCache.get(zip5) ?? null) : null,
    });
    const opener = pw.result.opener;
    if (opener == null || (l.listPrice != null && opener < minOfferFloor(l.listPrice))) {
      rows.push({
        record_id: l.id,
        address: l.address,
        to: l.agentEmail!,
        offer: opener,
        status: "skipped_hold",
        detail: opener == null ? `pricer HOLD (${pw.result.basis})` : "below_min_offer_floor",
      });
      continue;
    }

    // Business-hours window (property-local) — email decency + reply rate.
    const wh = evaluateSendWindow(l.state ?? null);
    if (!wh.inside) {
      rows.push({ record_id: l.id, address: l.address, to: l.agentEmail!, offer: opener, status: "outside_hours", detail: `local_hour=${wh.meta.local_hour}` });
      continue;
    }

    const { subject, body } = buildRecoveryEmail(l.agentName, l.address, opener);

    if (!live) {
      rows.push({ record_id: l.id, address: l.address, to: l.agentEmail!, offer: opener, status: "would_send", subject, detail: body.split("\n")[2] ?? null });
      sent++; // counts toward the per-run cap so the dry preview matches live
      continue;
    }

    // One recovery email per record EVER — KV claim before dispatch (the
    // notes stamp is the durable second belt).
    if (kvConfigured()) {
      const claimed = await kvProd.setNx(claimKey(l.id), new Date().toISOString(), CLAIM_TTL_S).catch(() => false);
      if (!claimed) {
        rows.push({ record_id: l.id, address: l.address, to: l.agentEmail!, offer: opener, status: "idempotent_skip", detail: "claim exists" });
        continue;
      }
    }

    try {
      const result = await sendEmail({ to: l.agentEmail!, subject, body, listingRecordId: l.id });
      if (!result.success) {
        // Release so a config fix can retry; nothing went out.
        if (kvConfigured()) await kvProd.del(claimKey(l.id)).catch(() => {});
        rows.push({ record_id: l.id, address: l.address, to: l.agentEmail!, offer: opener, status: "send_failed", detail: result.error ?? "gmail_send_failed" });
        continue;
      }
      const iso = new Date().toISOString();
      await updateListingRecord(l.id, {
        Outreach_Status: "Emailed",
        Last_Outbound_At: iso,
        Verification_Notes: buildEmailSentNote(l.notes, iso, result.messageId ?? null, subject, body),
      });
      rows.push({ record_id: l.id, address: l.address, to: l.agentEmail!, offer: opener, status: "sent", subject, detail: result.messageId ?? null });
      sent++;
      await audit({
        agent: "crier",
        event: "email_recovery_sent",
        status: "confirmed_success",
        recordId: l.id,
        externalId: result.messageId,
        inputSummary: { to_masked: l.agentEmail!.replace(/^(.).*(@.*)$/, "$1***$2"), offer: opener },
        outputSummary: { subject },
      });
    } catch (err) {
      if (kvConfigured()) await kvProd.del(claimKey(l.id)).catch(() => {});
      rows.push({ record_id: l.id, address: l.address, to: l.agentEmail!, offer: opener, status: "send_failed", detail: String(err).slice(0, 160) });
    }
  }

  await audit({
    agent: "crier",
    event: live ? "email_recovery_live" : "email_recovery_dry_run",
    status: "confirmed_success",
    inputSummary: { auth_kind: authKind, live, limit },
    outputSummary: {
      candidates: candidates.length,
      processed: rows.length,
      sent: rows.filter((r) => r.status === "sent").length,
      would_send: rows.filter((r) => r.status === "would_send").length,
      held: rows.filter((r) => r.status === "skipped_hold").length,
    },
    ms: Date.now() - t0,
  });

  return NextResponse.json({
    ok: true,
    mode: live ? "live" : "dry_run",
    candidates_total: candidates.length,
    rows,
    duration_ms: Date.now() - t0,
  });
}

export async function GET(req: Request) {
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
}
