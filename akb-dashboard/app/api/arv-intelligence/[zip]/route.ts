// Phase 4A — ARV Intelligence Engine endpoint (stateless).
//
// GET /api/arv-intelligence/[zip]?address=...&city=...&state=...
//                                 &beds=...&baths=...&sqft=...
//                                 &condition_target=renovated&rehab_mid=...
//
// Pulls RentCast sale comparables for the subject and runs them through
// the bimodal + uplift math in lib/arv-intelligence.ts. Returns both
// arv_as_is and arv_renovated bands + the headline (chosen by
// condition_target). Writes nothing to Airtable.
//
// rehab_mid is OPTIONAL but recommended when condition_target=renovated.
// Without it, Detroit/Memphis (markets where the comp cluster is as-is
// by default) cannot run the uplift path and the renovated headline
// falls back to the as-is mirror.

import { NextResponse } from "next/server";
import { getSaleComparables } from "@/lib/rentcast";
import { computeArvIntelligence } from "@/lib/arv-intelligence";
import { audit } from "@/lib/audit-log";

export const runtime = "nodejs";
export const maxDuration = 30;

const CACHE_TTL_MS = 7 * 24 * 60 * 60_000;
const cache: Record<string, { data: unknown; ts: number }> = {};

function parseNum(v: string | null): number | null {
  if (!v) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ zip: string }> },
) {
  const t0 = Date.now();
  const { zip } = await params;
  const url = new URL(req.url);
  const address = url.searchParams.get("address") ?? "";
  const city = url.searchParams.get("city") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const beds = parseNum(url.searchParams.get("beds"));
  const baths = parseNum(url.searchParams.get("baths"));
  const sqft = parseNum(url.searchParams.get("sqft"));
  const condition_target = url.searchParams.get("condition_target");
  const rehab_mid = parseNum(url.searchParams.get("rehab_mid"));

  if (!zip || !/^\d{5}$/.test(zip)) {
    return NextResponse.json({ error: "Invalid ZIP" }, { status: 400 });
  }

  if (!process.env.RENTCAST_API_KEY) {
    return NextResponse.json({ error: "RENTCAST_API_KEY not set" }, { status: 500 });
  }

  const cacheKey = `arv:${zip}:${address}:${beds}:${baths}:${sqft}:${condition_target ?? "default"}:${rehab_mid ?? "none"}`;
  const cached = cache[cacheKey];
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return NextResponse.json(cached.data);
  }

  // RentCast comp lookup requires at minimum a usable address; if the
  // caller supplies only a ZIP, RentCast returns nothing. We surface the
  // gap as an explicit error rather than an empty success.
  if (!address) {
    return NextResponse.json(
      {
        error: "address query param required",
        detail: "RentCast sale-comparables resolves by full address. Caller must supply address (+ city + state) so the comp engine can anchor.",
        zip,
      },
      { status: 400 },
    );
  }

  let comps;
  try {
    comps = await getSaleComparables({
      address,
      city,
      state,
      zip,
      bedrooms: beds,
      bathrooms: baths,
      squareFootage: sqft,
    });
  } catch (err) {
    await audit({
      agent: "appraiser",
      event: "rentcast_error",
      status: "confirmed_failure",
      inputSummary: { zip, address, beds, baths, sqft },
      error: String(err),
      ms: Date.now() - t0,
    });
    return NextResponse.json(
      { error: "RentCast call failed", detail: String(err), zip },
      { status: 502 },
    );
  }

  const result = computeArvIntelligence(comps, {
    zip,
    beds,
    baths,
    sqft,
    condition_target,
    rehab_mid,
  });

  // RentCast returned, math ran. Confidence label is a separate quality
  // signal — a LOW-confidence result is still a confirmed compute (we
  // know we got 0/few comps, not that we silently dropped them).
  await audit({
    agent: "appraiser",
    event: "arv_computed",
    status: "confirmed_success",
    inputSummary: { zip, address, beds, baths, sqft, condition_target, rehab_mid },
    outputSummary: {
      arv_mid: result.arv_mid,
      arv_method: result.arv_method,
      arv_as_is_mid: result.arv_as_is.mid,
      arv_renovated_mid: result.arv_renovated.mid,
      data_state_default: result.data_state_default,
      market: result.market,
      avg_per_sqft: result.avg_per_sqft,
      comp_count_used: result.comp_count_used,
      comp_count_excluded: result.comp_count_excluded,
      confidence: result.confidence,
      filter_quality: result.filter_quality,
    },
    decision: result.confidence,
    ms: Date.now() - t0,
  });

  // Cross-method disagreement gets its OWN audit event so the morning
  // brief can surface it via readUncertain() without trawling every
  // arv_computed entry.
  if (result.cross_method_disagreement.fired) {
    await audit({
      agent: "appraiser",
      event: "arv_cross_method_disagreement",
      status: "uncertain",
      inputSummary: { zip, address, condition_target, rehab_mid, market: result.market },
      outputSummary: {
        cluster_mid: result.cross_method_disagreement.cluster_mid,
        uplift_mid: result.cross_method_disagreement.uplift_mid,
        delta_pct: result.cross_method_disagreement.delta_pct,
        threshold_pct: result.cross_method_disagreement.threshold_pct,
        consensus_mid: result.arv_renovated.mid,
      },
      decision: "flag_for_review",
    });
  }

  cache[cacheKey] = { data: result, ts: Date.now() };
  return NextResponse.json(result);
}
