// Detroit spread sweep — server-side, one-shot cron.
// @agent: appraiser / orchestrator
//
// GET/POST /api/cron/detroit-spread-sweep?limit=40
//
// Runs the market-agnostic deal-math engine over Active Detroit (48xxx)
// listings using ATTOM renovated-cluster ARV, ranks the spread-positive
// rows (the TARGET LIST), and writes results to the Detroit_Spread_Targets
// Airtable table + the audit log. Server-side so the long serial-ATTOM
// run never hits the MCP-gateway 502 the synchronous report did.
//
// Detroit is force-lived for the COMPUTATION (to generate the proof the
// operator flips arv_source_verified on); the registry flag itself is a
// separate, deliberate git edit made only after a real listing produces a
// passing renovated-cluster ARV. The control row (23 Fields, TN) is run
// through the same engine — expected HOLD/BLOCK.
//
// ARV is renovated-cluster only (lib/attom/property.synthesizeArv); never
// AVM, never the arv_uplift.json multiplier.

import { NextResponse } from "next/server";
import { getListings } from "@/lib/airtable";
import { fetchArvFromAttom } from "@/lib/attom/property";
import { evaluateDeal } from "@/lib/markets/deal-math";
import { listMarkets, getMarketForListing } from "@/lib/markets/registry";
import type { Market } from "@/lib/markets/registry";
import type { Listing } from "@/lib/types";
import { audit } from "@/lib/audit-log";
import {
  authenticate,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";

export const runtime = "nodejs";
export const maxDuration = 300;

const RESULTS_TABLE = "tbllJ74U8AmMTteDC";
const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
const CONTROL_RECORDS = [{ id: "rec1HTUqK0YEVb7uA", label: "23 Fields (TN control)" }];

// Days-on-market negative-information threshold. v1 absolute (a true
// zip-norm DOM benchmark needs a market-stats source — flagged). DOM far
// above this at the current price = the market rejecting the price →
// blocks underwritten-mode (off the allowlist) until explained.
const DOM_FLAG_DAYS = 120;

interface SweepRow {
  Address: string;
  Record_Id: string;
  Zip: string;
  Status: string;
  List_Price: number | null;
  ARV: number | null;
  Rehab: number | null;
  MAO: number | null;
  Spread: number | null;
  Renovated_Comps: number | null;
  Reno_PSF: number | null;
  Zip_Benchmark_PSF: number | null;
  Guard: string;
  DOM: number | null;
  Allowlist_Clean: boolean;
  Reno_Comps: string;
  Bimodal: boolean;
  ATTOM_Match: boolean;
  Reason: string;
  Run_At: string;
}

async function upsertRows(rows: SweepRow[]): Promise<{ written: number; errors: string[] }> {
  if (!AIRTABLE_PAT) return { written: 0, errors: ["AIRTABLE_PAT not set"] };
  const url = `https://api.airtable.com/v0/${BASE_ID}/${RESULTS_TABLE}`;
  let written = 0;
  const errors: string[] = [];
  for (let i = 0; i < rows.length; i += 10) {
    const batch = rows.slice(i, i + 10).map((f) => ({ fields: f as unknown as Record<string, unknown> }));
    const res = await fetch(url, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${AIRTABLE_PAT}`, "Content-Type": "application/json" },
      body: JSON.stringify({ performUpsert: { fieldsToMergeOn: ["Record_Id"] }, records: batch, typecast: true }),
    });
    if (res.ok) written += batch.length;
    else errors.push(`${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }
  return { written, errors };
}

async function evalListing(
  l: Pick<Listing, "id" | "address" | "city" | "state" | "zip" | "liveStatus" | "outreachStatus" | "listPrice" | "contractOfferPrice" | "estRehab" | "estRehabMid" | "bedrooms" | "bathrooms" | "buildingSqFt" | "dom">,
  market: Market,
  runAt: string,
): Promise<SweepRow> {
  const arvOut = await fetchArvFromAttom({
    street: l.address,
    city: l.city ?? "",
    state: l.state ?? "",
    zip: l.zip ?? "",
    subjectSqft: l.buildingSqFt ?? null,
    searchRadiusMi: 1,
    minComps: 5,
    maxComps: 20,
  }).catch((e) => ({ status: "hold" as const, arv: null, synthesis: null, fetchError: e instanceof Error ? e.message : String(e) }));

  const attomMatch = arvOut.fetchError == null;
  const rehab = (l.estRehabMid ?? l.estRehab ?? null) as number | null;
  const result = evaluateDeal(
    {
      arv: arvOut.arv,
      rehab,
      listPrice: l.listPrice,
      contractPrice: l.contractOfferPrice ?? null,
      beds: l.bedrooms ?? null,
      baths: l.bathrooms ?? null,
      sqft: l.buildingSqFt ?? null,
    },
    market,
  );

  // ── Comp-sanity guard: zip-benchmark + DOM → allowlist gate ──────────
  const syn = arvOut.synthesis;
  const dom = typeof l.dom === "number" && Number.isFinite(l.dom) ? l.dom : null;
  const domFlag = dom != null && dom > DOM_FLAG_DAYS;
  const guardStatus = syn?.guardStatus ?? "no_zip_benchmark";
  const guard = domFlag ? `dom_flag(${dom}d)` : guardStatus;
  // Allowlist = PASS AND guard clean AND no DOM flag. A benchmark breach or
  // a cross-zip (no-benchmark) cluster never auto-passes (comp audit first).
  const allowlistClean = result.status === "pass" && guardStatus === "clean" && !domFlag;

  const renoCompsText = (syn?.renovatedComps ?? [])
    .map((c) => `${c.address ?? "?"} | ${c.zip ?? "?"} | ${c.distanceMi != null ? c.distanceMi.toFixed(2) : "?"}mi | ${c.sqft ?? "?"}sf | $${c.saleAmount.toLocaleString()} | ${(c.saleDate ?? "").slice(0, 10)} | $${c.ppsf}/sf`)
    .join("\n");

  return {
    Address: l.address,
    Record_Id: l.id,
    Zip: l.zip ?? "",
    Status: result.status,
    List_Price: l.listPrice,
    ARV: arvOut.arv,
    Rehab: rehab,
    MAO: result.mao,
    Spread: result.spread,
    Renovated_Comps: syn?.renovatedCount ?? null,
    Reno_PSF: syn?.renovatedMedianPpsf ?? null,
    Zip_Benchmark_PSF: syn?.zipBenchmarkPpsf ?? null,
    Guard: guard,
    DOM: dom,
    Allowlist_Clean: allowlistClean,
    Reno_Comps: renoCompsText,
    Bimodal: syn?.bimodal ?? false,
    ATTOM_Match: attomMatch,
    Reason: `${result.reason} | ARV: ${syn?.reason ?? arvOut.fetchError ?? "n/a"}`,
    Run_At: runAt,
  };
}

async function handle(req: Request) {
  const t0 = Date.now();
  const env = readAuthEnv();
  const headers = readAuthHeaders(req);
  const auth = await authenticate(headers, env, kvProd);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized", reason: auth.reason }, { status: 401 });
  if (auth.kind !== "cron" && auth.kind !== "oauth") {
    return NextResponse.json({ error: "unauthorized", reason: "unsupported_auth_kind" }, { status: 401 });
  }
  if (auth.kind === "oauth" && !kvConfigured()) return NextResponse.json({ error: "kv_not_configured" }, { status: 500 });

  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(60, parseInt(url.searchParams.get("limit") ?? "40", 10) || 40));
  const runAt = new Date().toISOString();

  const detroit = listMarkets().find((m) => m.id === "detroit_mi");
  if (!detroit) return NextResponse.json({ ok: false, error: "detroit_market_missing" }, { status: 500 });
  // Force-live for the COMPUTATION only (proof generator). Registry flag is
  // flipped separately by a human-reviewed git edit on proof.
  const detroitForced: Market = { ...detroit, arv_source_verified: true };

  let all: Listing[];
  try {
    all = await getListings();
  } catch (err) {
    return NextResponse.json({ ok: false, error: "listings_fetch_failed", message: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
  const detroitActive = all.filter((l) => l.liveStatus === "Active" && (l.zip ?? "").startsWith("48")).slice(0, limit);

  const rows: SweepRow[] = [];
  for (const l of detroitActive) rows.push(await evalListing(l, detroitForced, runAt));
  // Control row(s) through the SAME engine (market resolved normally → TN
  // has no live params → HOLD; that's the control's expected verdict).
  for (const cr of CONTROL_RECORDS) {
    const l = all.find((x) => x.id === cr.id);
    if (l) rows.push(await evalListing(l, getMarketForListing(l) ?? detroitForced, runAt));
  }

  // Rank: spread-positive first (by spread desc), then the rest.
  rows.sort((a, b) => {
    const av = a.Spread == null ? -Infinity : a.Spread;
    const bv = b.Spread == null ? -Infinity : b.Spread;
    return bv - av;
  });

  const write = await upsertRows(rows);

  const passing = rows.filter((r) => r.Status === "pass");
  const allowlist = rows.filter((r) => r.Allowlist_Clean);
  const breached = rows.filter((r) => r.Guard === "benchmark_breach");
  const noBenchmark = rows.filter((r) => r.Guard === "no_zip_benchmark");
  const domFlagged = rows.filter((r) => r.Guard.startsWith("dom_flag"));
  const attomMatched = rows.filter((r) => r.ATTOM_Match);
  const arvProduced = rows.filter((r) => r.ARV != null);
  const summary = {
    evaluated: rows.length,
    detroit_active: detroitActive.length,
    attom_match: `${attomMatched.length}/${rows.length}`,
    arv_produced: `${arvProduced.length}/${rows.length}`,
    pass_pre_guard: passing.length,
    allowlist_clean: allowlist.length,
    guard_benchmark_breach: breached.length,
    guard_no_zip_benchmark: noBenchmark.length,
    guard_dom_flag: domFlagged.length,
    allowlist: allowlist.map((r) => ({ address: r.Address, zip: r.Zip, spread: r.Spread, mao: r.MAO, arv: r.ARV, list: r.List_Price })),
    pass_but_guard_caught: passing.filter((r) => !r.Allowlist_Clean).map((r) => ({ address: r.Address, zip: r.Zip, guard: r.Guard, cluster_psf: r.Reno_PSF, zip_psf: r.Zip_Benchmark_PSF, spread: r.Spread })),
    airtable_written: write.written,
    airtable_errors: write.errors,
    run_at: runAt,
  };

  console.log("[detroit_spread_sweep]", JSON.stringify(summary).slice(0, 800));
  await audit({
    agent: "appraiser",
    event: "detroit_spread_sweep",
    status: "confirmed_success",
    inputSummary: { limit, auth_kind: auth.ok ? auth.kind : "?" },
    outputSummary: summary,
    ms: Date.now() - t0,
  });

  return NextResponse.json({ ok: true, summary, results_table: RESULTS_TABLE, elapsed_ms: Date.now() - t0 });
}

export async function GET(req: Request) { return handle(req); }
export async function POST(req: Request) { return handle(req); }
