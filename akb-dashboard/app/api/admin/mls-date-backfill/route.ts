// MLS-date backfill — one-time, scoped (operator 2026-06-19).
// @agent: appraiser / scout
//
// GET /api/admin/mls-date-backfill
//   default     DRY-RUN: re-fetch listedDate from RentCast for the existing
//               priced cohort, PROJECT the resulting DOM / distress / routing,
//               and report how many would clear to Auto Proceed. ZERO writes.
//   ?apply=1    LIVE: write MLS_Date_Raw = listedDate for the matched records.
//               (Gated — left for a separate explicit operator go.)
//   ?zips=a,b   covered ZIPs (default the Detroit priced cohort 48204,48213,48219).
//
// WHY: createIntakeListing didn't write MLS_Date_Raw until the 2026-06-19 fix, so
// the existing priced cohort short-circuits Stage_Calc to "Data Issue: Missing
// MLS Date" -> Manual Review. Intake dedups on known addresses, so it never
// re-touches them; this backfills the listedDate. RentCast read-only; no Firecrawl,
// no sends. The projection replicates the live Airtable formulas (mls-date-projection).

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
import { fetchListingsByZip } from "@/lib/crawler/sources/rentcast";
import { normalizeAddressKey } from "@/lib/crawler/intake-filter";
import { projectMlsRouting } from "@/lib/admin/mls-date-projection";

export const runtime = "nodejs";
export const maxDuration = 120;

const DETROIT_ZIPS = ["48204", "48213", "48219"];

export async function GET(req: Request) {
  const t0 = Date.now();
  const url = new URL(req.url);

  // ── Auth waterfall (mirror of the guarded admin routes) ──
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

  const apply = url.searchParams.get("apply") === "1";
  const zipFilter = (url.searchParams.get("zips") ?? DETROIT_ZIPS.join(","))
    .split(",").map((z) => z.trim()).filter((z) => /^\d{5}$/.test(z));
  const now = new Date();
  // A1 (operator 2026-06-21): drop the (List − MAO) spread term from the distress
  // replica so the projection stops encoding the spurious "expensive = distressed"
  // contamination. Default OFF (live formula behavior); flip to re-verify A1.
  const dropSpreadTerm = process.env.DISTRESS_DROP_SPREAD_TERM === "true";

  // ── Cohort: priced + MI + missing MLS date (the rows intake won't re-touch) ──
  const all = await getListings();
  const cohort = all.filter(
    (l) =>
      ((l.pipelineStage ?? "") as string).trim() === "priced" &&
      ((l.state ?? "") as string).trim() === "MI",
  );

  // ── Re-fetch RentCast active listings for the cohort ZIPs (READ-ONLY) ──
  const cohortZips = [...new Set(cohort.map((l) => (l.zip ?? "").trim()).filter(Boolean))]
    .filter((z) => zipFilter.includes(z));
  const dateByAddr = new Map<string, string | null>();
  const rentcast = { credentialed: true, errors: [] as string[], raw_total: 0, zips: cohortZips };
  for (const zip of cohortZips) {
    const r = await fetchListingsByZip(zip);
    rentcast.credentialed = rentcast.credentialed && r.credentialed;
    if (r.error) rentcast.errors.push(`${zip}: ${r.error}`);
    rentcast.raw_total += r.raw_count;
    for (const c of r.candidates) {
      const key = normalizeAddressKey((c.address ?? "").split(",")[0]);
      if (key && !dateByAddr.has(key)) dateByAddr.set(key, c.listedDate ?? null);
    }
  }

  // ── Project each record (REPLICATES the live Airtable formulas) ──
  const rows = cohort.map((l) => {
    const key = normalizeAddressKey((l.address ?? "").split(",")[0]);
    const listedDate = (key && dateByAddr.has(key)) ? (dateByAddr.get(key) ?? null) : null;
    const mao = l.mao ?? null; // the operative opener (Airtable fldWtbkObtIBRQCf0 / flduPNI7iLK8Yj07E)
    const hasAgentPhone = !!(l.agentPhone && String(l.agentPhone).trim());
    const proj = projectMlsRouting({
      listedDate,
      now,
      listPrice: l.listPrice ?? null,
      mao,
      priceDrops: l.priceDropCount ?? null,
      hasAgentPhone,
      dropSpreadTerm,
    });
    return {
      recordId: l.id,
      address: l.address ?? null,
      zip: l.zip ?? null,
      listedDate,
      listedDate_found: proj.hasMlsDate,
      dom: proj.dom,
      distress_score: proj.distressScore,
      distress_bucket: proj.distressBucket,
      has_agent_phone: hasAgentPhone,
      projected_stage_calc: proj.stageCalc,
      projected_routing: proj.routing,
      auto_proceed_sendable: proj.autoProceedSendable,
    };
  });

  const phoneRows = rows.filter((r) => r.has_agent_phone);
  const summary = {
    cohort: cohort.length,
    with_agent_phone: phoneRows.length,
    listed_date_found: rows.filter((r) => r.listedDate_found).length,
    listed_date_not_found: rows.filter((r) => !r.listedDate_found).length,
    // The headline: of the phone-having leads, how many project to Auto Proceed.
    auto_proceed_sendable: rows.filter((r) => r.auto_proceed_sendable).length,
    projected_routing: {
      auto_proceed: rows.filter((r) => r.projected_routing === "Auto Proceed").length,
      manual_review: rows.filter((r) => r.projected_routing === "Manual Review").length,
      reject: rows.filter((r) => r.projected_routing === "Reject").length,
    },
  };

  // ── DRY-RUN: report only, write nothing ──
  if (!apply) {
    await audit({
      agent: "appraiser",
      event: "mls_date_backfill_dry_run",
      status: "confirmed_success",
      inputSummary: { zips: cohortZips, auth_kind: authKind },
      outputSummary: { ...summary, rentcast_errors: rentcast.errors },
    });
    return NextResponse.json({ mode: "dry_run", rentcast, summary, rows, duration_ms: Date.now() - t0 });
  }

  // ── LIVE (gated — separate operator go): write MLS_Date_Raw for matched rows.
  // No stage/routing writes — Airtable recomputes the formulas off the date.
  const writes: Array<{ recordId: string; written: boolean; error: string | null }> = [];
  for (const r of rows) {
    if (!r.listedDate) continue;
    try {
      await updateListingRecord(r.recordId, { MLS_Date_Raw: r.listedDate });
      writes.push({ recordId: r.recordId, written: true, error: null });
    } catch (e) {
      writes.push({ recordId: r.recordId, written: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  await audit({
    agent: "appraiser",
    event: "mls_date_backfill_apply",
    status: writes.some((w) => !w.written) ? "uncertain" : "confirmed_success",
    inputSummary: { zips: cohortZips, auth_kind: authKind },
    outputSummary: { ...summary, written: writes.filter((w) => w.written).length },
  });
  return NextResponse.json({ mode: "live", rentcast, summary, written: writes.filter((w) => w.written).length, writes, duration_ms: Date.now() - t0 });
}
