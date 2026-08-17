// Creative-lane dry-run — the seller-finance EYEBALL surface. @agent: appraiser
//
// GET /api/admin/creative-lane-dry-run
//   ?limit=N      cap records scanned (default all)
//   ?zips=a,b     scope to ZIPs
//   ?sample=N     cap per-record rows in the response (default 50; aggregates
//                 always cover the full scanned set)
//
// WHAT IT DOES: runs the SAME cash pricing + hold classification the send
// lane uses (one pricer, no drift), takes the records the cash gate refuses
// as cash_no_pencil or infeasible_ask — the creative cohort — and computes
// the seller-finance terms offer (lib/creative/seller-finance) each would
// receive. Reports, per record, the terms package and whether it clears the
// lane's gates, plus the hold breakdown (no_rent_estimate = the machine-
// fixable rent-leg backfill target).
//
// READ-ONLY BY CONSTRUCTION: no writes, no sends, no paid calls — prices off
// stored fields only. Terms offers reach sellers ONLY after the operator
// approves the terms template (spine recNb0eYjIyeyCnPW); this route is the
// watched-first eyeball that sizes the lane before anything fires.

import { NextResponse } from "next/server";
import { getListings } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import { priceOpenerWithSeed } from "@/lib/opener-pricing";
import { classifyHold } from "@/lib/pricing/hold-reason";
import { getMarketForListing, openerArvPctMax } from "@/lib/markets/registry";
import { resolveAnchorPct } from "@/lib/markets/anchor";
import { getZipArvSeed, seedSelfPricesNonDisclosure, type ZipArvSeed } from "@/lib/zip-arv-seed-store";
import {
  priceSellerFinance,
  readSellerFinanceConfig,
  type SellerFinanceResult,
} from "@/lib/creative/seller-finance";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import type { Listing } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: Request) {
  const t0 = Date.now();
  const url = new URL(req.url);

  // ── Auth waterfall (mirror of opener-dry-run) ──
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

  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : Infinity;
  const sampleRaw = Number(url.searchParams.get("sample"));
  const sampleCap = Number.isFinite(sampleRaw) && sampleRaw >= 0 ? Math.floor(sampleRaw) : 50;
  const zipScope = new Set(
    (url.searchParams.get("zips") ?? "").split(",").map((z) => z.trim()).filter((z) => /^\d{5}$/.test(z)),
  );

  let listings: Listing[];
  try {
    listings = await getListings();
  } catch (err) {
    return NextResponse.json(
      { error: "listings_fetch_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  const scoped = listings.filter((l) => {
    if (zipScope.size > 0 && !(l.zip && zipScope.has(l.zip))) return false;
    return typeof l.listPrice === "number" && l.listPrice > 0;
  });

  const sfConfig = readSellerFinanceConfig();
  const agg = {
    scanned: 0,
    cash_priced: 0,
    creative_cohort: 0,
    cohort_by_trigger: { cash_no_pencil: 0, infeasible_ask: 0, both: 0 } as Record<string, number>,
    sendable_terms: 0,
    price_capped_to_value: 0,
    by_hold: {} as Record<string, number>,
    rent_present: 0,
    rent_missing: 0,
    sum_price: 0,
    sum_payment: 0,
    sum_entry: 0,
  };
  const rows: Array<Record<string, unknown>> = [];
  const anchorCache = new Map<string, number>();
  const seedCache = new Map<string, ZipArvSeed | null>();

  for (const l of scoped) {
    if (agg.scanned >= limit) break;
    agg.scanned++;

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
    const seed = zip5 ? seedCache.get(zip5) ?? null : null;
    const selfPricingSeed = seedSelfPricesNonDisclosure(seed);

    const pw = priceOpenerWithSeed({
      listPrice: l.listPrice ?? null,
      storedArv: l.realArvMedian ?? null,
      storedArvConfidence: l.arvConfidence ?? null,
      estRehabMid: l.estRehabMid ?? null,
      estRehab: l.estRehab ?? null,
      sqft: l.buildingSqFt ?? null,
      arvPctMax: openerArvPctMax(market, l.state, { selfPricingSeed }),
      wholesaleFee: l.wholesaleFeeTarget ?? null,
      anchorPct,
      seed,
      ownCompsJson: l.arvCompDetailsJson ?? null,
    });
    const priced = pw.result;
    if (priced.opener != null) {
      agg.cash_priced++;
      continue; // cash works — not creative-lane inventory
    }

    const hold = classifyHold({
      opener: priced.opener,
      arvDistrusted: priced.arvDistrusted,
      flooredToFallback: priced.flooredToFallback,
      flagReseed: priced.flagReseed,
      arvSource: pw.arvSource,
      seedDontPrice: !!seed?.dontPrice,
      marketHasBuybox: openerArvPctMax(market, l.state, { selfPricingSeed }) != null,
      overListTripwire: priced.overListTripwire,
      corroborationFlags: pw.corroborationFlags,
    });
    const infeasible = pw.corroborationFlags.includes("infeasible_ask");
    const cashNoPencil = hold.category === "cash_no_pencil";
    if (!infeasible && !cashNoPencil) continue;

    agg.creative_cohort++;
    agg.cohort_by_trigger[infeasible && cashNoPencil ? "both" : infeasible ? "infeasible_ask" : "cash_no_pencil"]++;
    if (l.estimatedMonthlyRent != null && l.estimatedMonthlyRent > 0) agg.rent_present++;
    else agg.rent_missing++;

    const sf: SellerFinanceResult = priceSellerFinance(
      {
        listPrice: l.listPrice ?? null,
        monthlyRent: l.estimatedMonthlyRent ?? null,
        arvBasis: pw.arvUsed ?? null,
        arvSource: pw.arvSource,
        wholesaleFee: l.wholesaleFeeTarget ?? null,
      },
      sfConfig,
    );

    if (sf.verdict === "sendable_terms") {
      agg.sendable_terms++;
      if (sf.priceCappedToValue) agg.price_capped_to_value++;
      agg.sum_price += sf.price;
      agg.sum_payment += sf.monthlyPayment;
      agg.sum_entry += sf.totalEntry;
    } else {
      agg.by_hold[sf.reason] = (agg.by_hold[sf.reason] ?? 0) + 1;
    }

    if (rows.length < sampleCap) {
      rows.push({
        id: l.id,
        address: l.address ?? null,
        zip: l.zip ?? null,
        list_price: l.listPrice ?? null,
        rent: l.estimatedMonthlyRent ?? null,
        arv_basis: pw.arvUsed ?? null,
        arv_source: pw.arvSource,
        trigger: infeasible && cashNoPencil ? "both" : infeasible ? "infeasible_ask" : "cash_no_pencil",
        ...(sf.verdict === "sendable_terms"
          ? {
              verdict: sf.verdict,
              price: sf.price,
              price_capped_to_value: sf.priceCappedToValue,
              down: sf.downPayment,
              monthly: sf.monthlyPayment,
              term_months: sf.termMonths,
              entry_pct: Math.round(sf.entryPct * 1000) / 10,
              buyer_cashflow: sf.buyerMonthlyCashflow,
              buyer_coc_pct: Math.round(sf.buyerCashOnCash * 1000) / 10,
              derivation: sf.derivation,
            }
          : { verdict: sf.verdict, hold_reason: sf.reason, hold_detail: sf.detail }),
      });
    }
  }

  const summary = {
    scanned: agg.scanned,
    cash_priced_skipped: agg.cash_priced,
    creative_cohort: agg.creative_cohort,
    cohort_by_trigger: agg.cohort_by_trigger,
    sendable_terms: agg.sendable_terms,
    price_capped_to_value: agg.price_capped_to_value,
    by_hold: agg.by_hold,
    rent_coverage: { present: agg.rent_present, missing: agg.rent_missing },
    avg_price: agg.sendable_terms > 0 ? Math.round(agg.sum_price / agg.sendable_terms) : null,
    avg_monthly: agg.sendable_terms > 0 ? Math.round(agg.sum_payment / agg.sendable_terms) : null,
    avg_entry: agg.sendable_terms > 0 ? Math.round(agg.sum_entry / agg.sendable_terms) : null,
  };

  await audit({
    agent: "appraiser",
    event: "creative_lane_dry_run",
    status: "confirmed_success",
    inputSummary: { auth_kind: authKind, scanned: agg.scanned, zips: [...zipScope] },
    outputSummary: { ...summary, duration_ms: Date.now() - t0 },
  });

  return NextResponse.json({
    ok: true,
    note:
      "DRY-RUN report only. No texts, no writes, no paid calls. Cash pricing + hold classification are the " +
      "live lane's own; the creative cohort is what cash correctly refuses. Terms offers stay dark until the " +
      "operator approves the terms template.",
    summary,
    sample_rows: rows,
    auth_kind: authKind,
    duration_ms: Date.now() - t0,
  });
}
