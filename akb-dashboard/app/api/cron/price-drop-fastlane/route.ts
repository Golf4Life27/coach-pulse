// Price-drop fast lane (operator "get started" 2026-07-11). @agent: scout
//
// GET /api/cron/price-drop-fastlane
//   default    DRY: list the newly-penciling cuts (record, ask, prev, ZIP
//              renovated value, spread) — zero credits.
//   ?apply=1   re-verify them NOW (1-credit known-URL scrape each, same
//              semantics as freshness-reverify), stamping Last_Verified +
//              Live_Status so the NEXT send slot fires the opener while
//              the cut is hot. Sends nothing itself.
//   ?limit=N   cap re-verifies (default 8, max 20).
//
// NEW LANE, NEW FILES ONLY — imports the belt's libs read-only, edits none.

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
import { verifyListingByUrl } from "@/lib/crawler/sources/firecrawl";
import { getZipArvSeed, arvForSubjectFromSeed, type ZipArvSeed } from "@/lib/zip-arv-seed-store";
import { priceDropFastlaneVerdict, rankFastlaneTargets } from "@/lib/price-drop-fastlane";
import type { Listing } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 180;

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
const BUDGET_MS = 150_000;

export async function GET(req: Request) {
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

  const apply = url.searchParams.get("apply") === "1";
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(MAX_LIMIT, Math.floor(limitRaw)) : DEFAULT_LIMIT;
  const now = new Date();

  let all: Listing[];
  try {
    all = await getListings();
  } catch (err) {
    return NextResponse.json(
      { error: "listings_fetch_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  // Cheap pre-filter before any seed I/O: cut evidence + first-touch pool.
  const rough = all.filter(
    (l) =>
      (l.outreachStatus ?? "").trim() === "" &&
      ((l.priceDropCount ?? 0) >= 1 ||
        (l.prevListPrice != null && l.listPrice != null && l.listPrice < l.prevListPrice)),
  );

  const seedCache = new Map<string, ZipArvSeed | null>();
  const targets: Array<{ listing: Listing; seedArv: number; spread: number }> = [];
  const skipped: Record<string, number> = {};
  for (const l of rough) {
    const zip5 = (l.zip ?? "").trim();
    if (zip5 && !seedCache.has(zip5)) {
      seedCache.set(zip5, await getZipArvSeed(zip5).catch(() => null));
    }
    const seed = zip5 ? (seedCache.get(zip5) ?? null) : null;
    const seedArv = seed ? arvForSubjectFromSeed(seed, l.buildingSqFt ?? null) : null;
    const v = priceDropFastlaneVerdict(l, seedArv, now);
    if (v.due && seedArv != null && v.spread != null) {
      targets.push({ listing: l, seedArv, spread: v.spread });
    } else if (v.reason) {
      skipped[v.reason] = (skipped[v.reason] ?? 0) + 1;
    }
  }
  const ranked = rankFastlaneTargets(targets).slice(0, limit);

  const preview = ranked.map((t) => ({
    record_id: t.listing.id,
    address: t.listing.address,
    zip: t.listing.zip,
    list_price: t.listing.listPrice,
    prev_list_price: t.listing.prevListPrice ?? null,
    renovated_value: t.seedArv,
    headroom_under_arv: t.spread,
  }));

  if (!apply) {
    return NextResponse.json({
      ok: true,
      mode: "dry_run",
      auth_kind: authKind,
      cut_evidence_pool: rough.length,
      due_total: targets.length,
      skipped_reasons: skipped,
      targets: preview,
      duration_ms: Date.now() - t0,
    });
  }

  // ── Apply: 1-credit known-URL re-verify per target (reverify semantics:
  // infra miss leaves the record as-is; a confirmed verdict stamps). ─────
  const results: Array<{ record_id: string; address: string; still_active: boolean | null; credits: number; error: string | null }> = [];
  let creditsUsed = 0;
  for (const t of ranked) {
    if (Date.now() - t0 > BUDGET_MS) break;
    const iso = new Date().toISOString();
    try {
      const fc = await verifyListingByUrl(t.listing.verificationUrl!, t.listing.address);
      creditsUsed += fc.creditsUsed;
      if (fc.paymentRequired) {
        results.push({ record_id: t.listing.id, address: t.listing.address, still_active: null, credits: fc.creditsUsed, error: "firecrawl_payment_required" });
        break;
      }
      if (!fc.resolved) {
        results.push({ record_id: t.listing.id, address: t.listing.address, still_active: null, credits: fc.creditsUsed, error: fc.error ?? "unresolved" });
        continue;
      }
      const newLive = fc.stillActive ? "Active" : "Off Market";
      await updateListingRecord(t.listing.id, { Live_Status: newLive, Last_Verified: iso });
      results.push({ record_id: t.listing.id, address: t.listing.address, still_active: fc.stillActive, credits: fc.creditsUsed, error: null });
      await audit({
        agent: "scout",
        event: "price_drop_fastlane_reverify",
        status: "confirmed_success",
        recordId: t.listing.id,
        inputSummary: { list: t.listing.listPrice, prev: t.listing.prevListPrice ?? null, renovated_value: t.seedArv },
        outputSummary: { still_active: fc.stillActive, headroom_under_arv: t.spread },
        decision: fc.stillActive ? "fastlaned_to_sendable" : "cut_but_gone",
      });
    } catch (err) {
      results.push({ record_id: t.listing.id, address: t.listing.address, still_active: null, credits: 0, error: String(err).slice(0, 160) });
    }
  }

  return NextResponse.json({
    ok: true,
    mode: "apply",
    auth_kind: authKind,
    due_total: targets.length,
    summary: {
      attempted: results.length,
      now_sendable: results.filter((r) => r.still_active === true).length,
      cut_but_gone: results.filter((r) => r.still_active === false).length,
      unresolved: results.filter((r) => r.error && r.still_active === null).length,
      credits_used: creditsUsed,
    },
    targets: preview,
    results,
    duration_ms: Date.now() - t0,
  });
}
