// SOLD-FOR FEEDBACK — daily roll-up of agent-reported sale prices.
// @agent: sentinel
//
// GET /api/admin/sold-feedback
//   default        compute the report from every listing carrying
//                  Reported_Sale_Price, write it to KV (sold_feedback:latest)
//                  and return it.
//   ?backfill=1    ALSO scan Verification_Notes on listings with no reported
//                  sale for "sold for $X" replies that landed before this loop
//                  existed and stamp them (apply=1 required to write; without
//                  it the route only reports what it WOULD stamp).
//   ?apply=1       with backfill=1: write the stamps.
//
// Operator 2026-09-05 (Spine recSPi62i3U3vgJVe). Read-mostly; the only
// writes are the two Reported_Sale_* fields on backfill and the KV report.
// Auth: dashboard cookie / CRON_SECRET / OAuth waterfall (same as audit-tail).

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
import {
  computeSoldFeedback,
  reportedSaleFields,
  scanNotesForReportedSale,
  SOLD_FEEDBACK_KV_KEY,
  type SoldFeedbackRow,
} from "@/lib/sold-feedback";

export const runtime = "nodejs";
export const maxDuration = 120;

const BACKFILL_MAX_WRITES = 50;

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
  const backfill = url.searchParams.get("backfill") === "1";
  const apply = url.searchParams.get("apply") === "1";

  const listings = await getListings();

  // ── Backfill: replies that reported a sale before the capture hook existed.
  const backfillRows: Array<{ id: string; address: string | null; price: number; kind: string; ts: string; written: boolean }> = [];
  if (backfill) {
    for (const l of listings) {
      if (typeof l.reportedSalePrice === "number" && l.reportedSalePrice > 0) continue;
      const hit = scanNotesForReportedSale(l.notes ?? null);
      if (!hit) continue;
      let written = false;
      if (apply && backfillRows.filter((r) => r.written).length < BACKFILL_MAX_WRITES) {
        await updateListingRecord(l.id, reportedSaleFields({ price: hit.price, kind: hit.kind as "sold" | "under_contract", matchedPattern: "backfill" }, hit.ts));
        l.reportedSalePrice = hit.price;
        l.reportedSaleDate = hit.ts.slice(0, 10);
        written = true;
      }
      backfillRows.push({ id: l.id, address: l.address ?? null, price: hit.price, kind: hit.kind, ts: hit.ts, written });
    }
  }

  const rows: SoldFeedbackRow[] = listings.map((l) => ({
    id: l.id,
    zip: l.zip ?? null,
    state: l.state ?? null,
    listPrice: l.listPrice ?? null,
    openerUsd: l.roughOpenerAmount ?? l.outreachOfferPrice ?? null,
    reportedSalePrice: l.reportedSalePrice ?? null,
    reportedSaleDate: l.reportedSaleDate ?? null,
    buildingSqFt: l.buildingSqFt ?? null,
    lastOutreachDate: l.lastOutreachDate ?? null,
    address: l.address ?? null,
  }));
  const report = computeSoldFeedback(rows);

  let kvWritten = false;
  if (kvConfigured()) {
    try {
      await kvProd.set(SOLD_FEEDBACK_KV_KEY, JSON.stringify(report));
      kvWritten = true;
    } catch (err) {
      console.error("[sold-feedback] kv write failed:", err);
    }
  }

  await audit({
    agent: "sentinel",
    event: "sold_feedback_rollup",
    status: "confirmed_success",
    inputSummary: { backfill, apply, listings: listings.length },
    outputSummary: {
      sample_size: report.sampleSize,
      zips: Object.keys(report.byZip).length,
      saturated_zips: Object.values(report.byZip).filter((b) => b.saturated).map((b) => b.key),
      backfill_found: backfillRows.length,
      backfill_written: backfillRows.filter((r) => r.written).length,
      kv_written: kvWritten,
    },
    decision: "rollup",
  });

  return NextResponse.json({
    ok: true,
    auth_kind: authKind,
    kv_written: kvWritten,
    backfill: backfill ? { apply, found: backfillRows.length, written: backfillRows.filter((r) => r.written).length, rows: backfillRows } : null,
    report,
    duration_ms: Date.now() - t0,
  });
}
