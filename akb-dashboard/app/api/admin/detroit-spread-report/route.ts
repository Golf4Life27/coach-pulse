// Detroit spread report — V1 market live-test + 23 Fields control.
// @agent: appraiser
//
// GET /api/admin/detroit-spread-report?limit=25
//   ?include_control=1  also runs 23 Fields (TN control) through the model
//                       so we can see what the engine says about a known
//                       BLOCK record under the new buy-box (replaces
//                       Highland as anchor).
//   ?force_live=1       overrides arv_source_verified gate (operator only,
//                       for the very first probe-then-report flow).
//
// What it does: pulls Active Detroit listings from Airtable, fetches an
// ATTOM ARV (recorded sold comps via /salescomparables — disclosure state,
// CLEAN), runs each through the market-agnostic deal-math engine, and
// reports the spread distribution + how many clear every gate.
//
// REPORT-ONLY. No writes to Airtable; nothing persists. The point is to
// see, in numbers, whether the engine + ATTOM combination is real before
// we wire it to anything downstream.

import { NextResponse } from "next/server";
import { getListings } from "@/lib/airtable";
import { fetchArvFromAttom } from "@/lib/attom/property";
import { evaluateDeal } from "@/lib/markets/deal-math";
import { getMarketForListing, listMarkets } from "@/lib/markets/registry";
import type { Market } from "@/lib/markets/registry";
import { audit } from "@/lib/audit-log";
import {
  authenticate,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";

export const runtime = "nodejs";
export const maxDuration = 300;

interface SpreadRow {
  recordId: string;
  address: string;
  city: string | null;
  state: string | null;
  zip: string | null;
  list_price: number | null;
  rehab: number | null;
  arv: number | null;
  arv_synthesis_reason: string | null;
  mao: number | null;
  spread: number | null;
  status: string;
  gates: Record<string, { ok: boolean; reason: string }>;
}

const CONTROL_RECORDS: Array<{ id: string; label: string }> = [
  { id: "rec1HTUqK0YEVb7uA", label: "23 Fields Ave (TN — control: must BLOCK under economic gate)" },
];

async function evaluateOne(
  listing: { id: string; address: string; city: string | null; state: string | null; zip: string | null; listPrice: number | null; contractOfferPrice?: number | null; estRehab?: number | null; estRehabMid?: number | null; bedrooms?: number | null; bathrooms?: number | null; buildingSqFt?: number | null },
  market: Market | null,
  forceLive: boolean,
): Promise<SpreadRow> {
  const arvOut = market && (market.id === "detroit_mi" || forceLive)
    ? await fetchArvFromAttom({
        street: listing.address,
        city: listing.city ?? "",
        state: listing.state ?? "",
        zip: listing.zip ?? "",
        searchRadiusMi: 1,
        minComps: 5,
        maxComps: 20,
      })
    : { status: "hold" as const, arv: null, synthesis: null, fetchError: market ? null : "no market matched" };

  const effectiveMarket = forceLive && market ? { ...market, arv_source_verified: true } : market;
  const result = evaluateDeal(
    {
      arv: arvOut.arv,
      rehab: listing.estRehabMid ?? listing.estRehab ?? null,
      listPrice: listing.listPrice,
      contractPrice: listing.contractOfferPrice ?? null,
      beds: listing.bedrooms ?? null,
      baths: listing.bathrooms ?? null,
      sqft: listing.buildingSqFt ?? null,
    },
    effectiveMarket,
  );

  return {
    recordId: listing.id,
    address: listing.address,
    city: listing.city,
    state: listing.state,
    zip: listing.zip,
    list_price: listing.listPrice,
    rehab: (listing.estRehabMid ?? listing.estRehab) as number | null,
    arv: arvOut.arv,
    arv_synthesis_reason: arvOut.synthesis?.reason ?? arvOut.fetchError ?? null,
    mao: result.mao,
    spread: result.spread,
    status: result.status,
    gates: result.gates,
  };
}

async function handle(req: Request) {
  const t0 = Date.now();
  const env = readAuthEnv();
  const headers = readAuthHeaders(req);
  const auth = await authenticate(headers, env, kvProd);
  if (!auth.ok) {
    return NextResponse.json({ error: "unauthorized", reason: auth.reason }, { status: 401 });
  }
  if (auth.kind !== "cron" && auth.kind !== "oauth") {
    return NextResponse.json({ error: "unauthorized", reason: "unsupported_auth_kind" }, { status: 401 });
  }
  if (auth.kind === "oauth" && !kvConfigured()) {
    return NextResponse.json({ error: "kv_not_configured" }, { status: 500 });
  }

  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(50, parseInt(url.searchParams.get("limit") ?? "25", 10) || 25));
  const includeControl = url.searchParams.get("include_control") === "1";
  const forceLive = url.searchParams.get("force_live") === "1";

  // Detroit-resolvable listings from the full population. ZIP 48xxx.
  const all = await getListings();
  const detroitMarket = listMarkets().find((m) => m.id === "detroit_mi") ?? null;
  const detroitActive = all
    .filter((l) => l.liveStatus === "Active" && (l.zip ?? "").startsWith("48"))
    .slice(0, limit);

  const rows: SpreadRow[] = [];
  for (const l of detroitActive) {
    rows.push(await evaluateOne(l, detroitMarket, forceLive));
  }

  let controlRows: SpreadRow[] = [];
  if (includeControl) {
    for (const cr of CONTROL_RECORDS) {
      const l = all.find((x) => x.id === cr.id);
      if (!l) continue;
      const market = getMarketForListing(l);
      controlRows.push(await evaluateOne(l, market, forceLive));
    }
  }

  const passing = rows.filter((r) => r.status === "pass");
  const blocking = rows.filter((r) => r.status === "block");
  const holding = rows.filter((r) => r.status === "hold");
  const spreads = rows.map((r) => r.spread).filter((s): s is number => s != null);
  spreads.sort((a, b) => a - b);
  const median = spreads.length === 0 ? null : spreads[Math.floor(spreads.length / 2)];

  const summary = {
    detroit_market_live_today: !!detroitMarket?.arv_source_verified,
    forced_live_for_this_run: forceLive,
    detroit_active_evaluated: rows.length,
    pass: passing.length,
    block: blocking.length,
    hold: holding.length,
    spread_min: spreads[0] ?? null,
    spread_median: median,
    spread_max: spreads[spreads.length - 1] ?? null,
    holds_lacking_arv: rows.filter((r) => r.arv == null).length,
    holds_lacking_rehab: rows.filter((r) => r.rehab == null).length,
  };

  await audit({
    agent: "appraiser",
    event: "detroit_spread_report",
    status: "confirmed_success",
    inputSummary: { limit, include_control: includeControl, force_live: forceLive, auth_kind: auth.kind },
    outputSummary: summary,
    ms: Date.now() - t0,
  });

  return NextResponse.json({
    ok: true,
    note: "REPORT-ONLY Detroit spread distribution under the market-agnostic deal-math engine. ARV from ATTOM /salescomparables (recorded MI retail sold comps; NEVER AVM). The control row is 23 Fields (TN) — expected economic BLOCK.",
    summary,
    rows: rows.slice(0, 25),
    control_rows: controlRows,
    elapsed_ms: Date.now() - t0,
  });
}

export async function GET(req: Request) { return handle(req); }
export async function POST(req: Request) { return handle(req); }
