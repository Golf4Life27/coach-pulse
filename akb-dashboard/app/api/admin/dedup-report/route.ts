// Address-level dedup report (v1_legacy vs v2 collisions).
// @agent: scout
//
// GET /api/admin/dedup-report
//   → every normalized-address collision across the listings table, with
//     the riskiest (double-contact, then cross-version) first. Read-only.
//   ?limit=N   cap the returned groups (default 100; summary always full).
//
// Server-side by the standing rule (SYSTEM_FACTS §8 — operational sweeps
// are Code's, not browser/console). The pure analysis lives in
// lib/dedup/address-dedup.ts; this route is the I/O shell.
//
// Auth: dashboard cookie / CRON_SECRET / OAuth waterfall.

import { NextResponse } from "next/server";
import { getListings } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import { analyzeAddressDedup, summarizeDedup, type DedupListing } from "@/lib/dedup/address-dedup";

export const runtime = "nodejs";
export const maxDuration = 60;

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
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 100;

  let listings;
  try {
    // includeLegacy → the whole table, so v1↔v2 collisions are visible.
    listings = await getListings({ includeLegacy: true });
  } catch (err) {
    return NextResponse.json(
      { error: "listings_fetch_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  const rows: DedupListing[] = listings.map((l) => ({
    id: l.id,
    address: l.address,
    sourceVersion: l.sourceVersion,
    pipelineStage: l.pipelineStage ?? null,
    outreachStatus: l.outreachStatus,
    liveStatus: l.liveStatus,
    doNotText: l.doNotText,
  }));

  const groups = analyzeAddressDedup(rows);
  const summary = summarizeDedup(rows, groups);

  await audit({
    agent: "scout",
    event: "dedup_report",
    status: "confirmed_success",
    inputSummary: { auth_kind: authKind },
    outputSummary: { ...summary },
    ms: Date.now() - t0,
  });

  return NextResponse.json({
    ok: true,
    auth_kind: authKind,
    summary,
    // The actionable set first: double-contact-risk groups, capped.
    groups: groups.slice(0, limit).map((g) => ({
      address: g.sampleAddress,
      crossVersion: g.crossVersion,
      doubleContactRisk: g.doubleContactRisk,
      contactableIds: g.contactableIds,
      records: g.records.map((r) => ({
        id: r.id,
        sourceVersion: r.sourceVersion,
        pipelineStage: r.pipelineStage,
        outreachStatus: r.outreachStatus,
        liveStatus: r.liveStatus,
        doNotText: r.doNotText,
      })),
    })),
    duration_ms: Date.now() - t0,
  });
}
