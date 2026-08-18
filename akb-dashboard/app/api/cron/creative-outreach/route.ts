// Creative outreach — seller-finance terms first-touch (DARK until approved).
// @agent: crier
//
// GET /api/cron/creative-outreach[?dry_run=false&limit=N&force_run=1]
//
// THE LANE (operator green-light 2026-08-17, spine recNb0eYjIyeyCnPW /
// recRsJAJThBsqoL2T): send-eligible records the CASH lane refuses
// (cash_no_pencil / infeasible_ask) receive the terms opener — the seller's
// price (value-capped) paid over time — with the MORTGAGE QUESTION folded
// into the first touch because lien status is unknown cohort-wide. Nothing
// binding goes out; the reply collects loan status and the terms math
// re-runs on real numbers before anything firms.
//
// RAILS — the same stack the cash lane runs on, in the same order:
//   1. H2_OUTREACH_HARD_DISABLE master kill covers this lane too (503).
//   2. CREATIVE_OUTREACH_LIVE !== "true" ⇒ forced dry regardless of params —
//      the operator's terms-template approval is the flip.
//   3. dry_run default TRUE; live needs an explicit ?dry_run=false.
//   4. isH2Eligible does eligibility (v2, fresh, status, phone, renovated
//      veto); evaluateSendWindow does quiet hours (TCPA, non-disableable);
//      sendGuarded does doNotText / renovated / number-dedupe / audit tags.
//   5. SHARED daily send meter with H2 — cash + creative together are
//      bounded by the one H2_DAILY_SEND_CAP; creative adds its own tight
//      per-run cap (default 5, ceiling 15).
//   6. KV per-record dispatch claim (creative:dispatch:*) — claim BEFORE
//      send, so a crashed run never double-texts.
//   7. Sticky receipt: the exact price/down/monthly texted is stamped into
//      Verification_Notes with the Quo message id; Opener_Basis becomes
//      seller_finance_terms_v1. Outreach_Offer_Price (the CASH sticky
//      field) is deliberately NOT written — cross-lane drift protection.

import { NextResponse } from "next/server";
import { getListings, updateListingRecord } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import { isH2Eligible } from "@/lib/h2-outreach";
import { evaluateSendWindow } from "@/lib/h2-working-hours";
import { priceOpenerWithSeed } from "@/lib/opener-pricing";
import { classifyHold } from "@/lib/pricing/hold-reason";
import { getMarketForListing, openerArvPctMax } from "@/lib/markets/registry";
import { resolveAnchorPct } from "@/lib/markets/anchor";
import { getZipArvSeed, seedSelfPricesNonDisclosure, type ZipArvSeed } from "@/lib/zip-arv-seed-store";
import { estimateRent, fitRentModel, type RentPoint } from "@/lib/creative/rent-model";
import {
  creativePriority,
  isAbsentee,
  isFreeAndClear,
  parsePropStreamEnrichment,
  pickRentWithEnrichment,
  type PropStreamEnrichment,
} from "@/lib/creative/enrichment";
import { priceSellerFinance, readSellerFinanceConfig, type SellerFinanceOffer } from "@/lib/creative/seller-finance";
import { renderTermsOpener } from "@/lib/creative/terms-opener";
import { sendGuarded } from "@/lib/outreach/send-gate";
import { readDailySendCap, governDailySends, dailySendMeterKey, DAILY_SEND_METER_TTL_S } from "@/lib/outreach/send-cap";
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

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 15;
const CLAIM_PREFIX = "creative:dispatch:";
const CLAIM_TTL_S = 60 * 60 * 24 * 90; // one first touch per record, ~forever

export async function GET(req: Request) {
  const t0 = Date.now();
  const url = new URL(req.url);

  // ── Auth waterfall + cron gate (mirror of h2-outreach) ──
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
    return NextResponse.json({ error: "crons_disabled", hint: "MAVERICK_CRON_ENABLED != true (force_run=1 to override)" }, { status: 503 });
  }

  // ── Master kill: the ONE switch that darkens every seller/agent SMS lane.
  if (process.env.H2_OUTREACH_HARD_DISABLE !== "false") {
    return NextResponse.json({ error: "outreach_hard_disabled" }, { status: 503 });
  }

  // ── Lane flag: dark until the operator approves the terms template.
  const laneLive = process.env.CREATIVE_OUTREACH_LIVE === "true";
  const dryRun = !laneLive || url.searchParams.get("dry_run") !== "false";

  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Math.min(MAX_LIMIT, Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : DEFAULT_LIMIT);

  let listings: Listing[];
  try {
    listings = await getListings();
  } catch (err) {
    return NextResponse.json(
      { error: "listings_fetch_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  // ── Rent model from data already owned (zero marginal calls).
  const metroFor = (l: Listing): string =>
    getMarketForListing({ state: l.state, zip: l.zip })?.id ?? (l.zip ?? "").slice(0, 3);
  const rentPoints: RentPoint[] = listings
    .filter((l) => (l.estimatedMonthlyRent ?? 0) > 0 && (l.buildingSqFt ?? 0) > 0 && !!l.zip)
    .map((l) => ({ zip: l.zip!, metro: metroFor(l), sqft: l.buildingSqFt!, rent: l.estimatedMonthlyRent! }));
  const rentModel = fitRentModel(rentPoints);
  const sfConfig = readSellerFinanceConfig();

  // ── Build the ranked terms queue: send-eligible ∩ cash-refused ∩ sendable.
  const anchorCache = new Map<string, number>();
  const seedCache = new Map<string, ZipArvSeed | null>();
  type Candidate = {
    l: Listing;
    offer: SellerFinanceOffer;
    rentBasis: string;
    body: string;
    enrichment: PropStreamEnrichment | null;
  };
  const queue: Candidate[] = [];
  let eligibleCount = 0;

  for (const l of listings) {
    if (!isH2Eligible(l)) continue;
    eligibleCount++;

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
    if (pw.result.opener != null) continue; // cash works — cash lane's record

    const hold = classifyHold({
      opener: pw.result.opener,
      arvDistrusted: pw.result.arvDistrusted,
      flooredToFallback: pw.result.flooredToFallback,
      flagReseed: pw.result.flagReseed,
      arvSource: pw.arvSource,
      seedDontPrice: !!seed?.dontPrice,
      marketHasBuybox: openerArvPctMax(market, l.state, { selfPricingSeed }) != null,
      overListTripwire: pw.result.overListTripwire,
      corroborationFlags: pw.corroborationFlags,
    });
    const inCohort = hold.category === "cash_no_pencil" || pw.corroborationFlags.includes("infeasible_ask");
    if (!inCohort) continue;

    // Rent chain: RentCast AVM on the record → modeled (ZIP/metro) with the
    // PropStream snapshot as a conservative second opinion (lower wins) →
    // PropStream alone (haircut) → none. See lib/creative/enrichment.ts for
    // the +9.5%-hot calibration finding that ordered this.
    const enrichment = parsePropStreamEnrichment(l.propStreamEnrichmentJson);
    let monthlyRent: number | null = null;
    let rentBasis = "none";
    if ((l.estimatedMonthlyRent ?? 0) > 0) {
      monthlyRent = l.estimatedMonthlyRent!;
      rentBasis = "rentcast_avm";
    } else {
      const modeled = estimateRent(rentModel, { zip: l.zip, metro: metroFor(l), sqft: l.buildingSqFt });
      const picked = pickRentWithEnrichment(modeled, enrichment);
      if (picked) {
        monthlyRent = picked.rent;
        rentBasis = picked.basis;
      }
    }

    const sf = priceSellerFinance(
      {
        listPrice: l.listPrice ?? null,
        monthlyRent,
        arvBasis: pw.arvUsed ?? null,
        arvSource: pw.arvSource,
        wholesaleFee: l.wholesaleFeeTarget ?? null,
      },
      sfConfig,
    );
    if (sf.verdict !== "sendable_terms") continue;
    if (!l.address || !l.agentPhone) continue;

    queue.push({
      l,
      offer: sf,
      rentBasis,
      body: renderTermsOpener({ agentName: l.agentName, address: l.address, listPrice: l.listPrice!, offer: sf }),
      enrichment,
    });
  }

  // Lien-aware ordering: free-and-clear > absentee > last-cash-buyer tiers,
  // then the offer-quality score (full-ask first, buyer CoC tiebreak).
  queue.sort((a, b) => creativePriority(b.offer, b.enrichment) - creativePriority(a.offer, a.enrichment));
  const planned = queue.slice(0, limit);

  // ── Shared daily meter (cash + creative bounded together).
  const dailyCap = readDailySendCap();
  let usedAtStart = 0;
  let meterReadable = true;
  if (kvConfigured()) {
    try {
      usedAtStart = Number((await kvProd.get(dailySendMeterKey(new Date()))) ?? 0) || 0;
    } catch {
      meterReadable = false;
    }
  } else meterReadable = false;
  const daily = governDailySends({ maxPerRun: planned.length, dailyCap, usedToday: meterReadable ? usedAtStart : null });

  const results: Array<Record<string, unknown>> = [];
  let sent = 0;
  let claimed = 0;
  let outsideHours = 0;
  let refused = 0;

  for (const c of planned.slice(0, daily.maxPerRunToday)) {
    const row: Record<string, unknown> = {
      recordId: c.l.id,
      address: c.l.address,
      agent_name: c.l.agentName,
      price: c.offer.price,
      price_capped_to_value: c.offer.priceCappedToValue,
      down: c.offer.downPayment,
      monthly: c.offer.monthlyPayment,
      term_months: c.offer.termMonths,
      rent_basis: c.rentBasis,
      free_and_clear: isFreeAndClear(c.enrichment),
      absentee: isAbsentee(c.enrichment),
      last_cash_buyer: c.enrichment?.lastCashBuyer === true,
      body: c.body,
      action: "planned",
    };
    results.push(row);
    if (dryRun) continue;

    // Quiet hours — non-disableable (TCPA).
    const wh = evaluateSendWindow(c.l.state ?? null);
    if (!wh.inside) {
      row.action = "outside_hours";
      outsideHours++;
      continue;
    }

    // Claim BEFORE send: a crashed run must never double-text.
    if (kvConfigured()) {
      try {
        const key = `${CLAIM_PREFIX}${c.l.id}`;
        const existing = await kvProd.get(key);
        if (existing) {
          row.action = "idempotent_skipped";
          claimed++;
          continue;
        }
        await kvProd.setEx(key, new Date().toISOString(), CLAIM_TTL_S);
      } catch {
        row.action = "kv_unavailable_skipped"; // fail toward NOT sending
        continue;
      }
    } else {
      row.action = "kv_unavailable_skipped";
      continue;
    }

    const gate = await sendGuarded({
      to: c.l.agentPhone!,
      body: c.body,
      purpose: "first_touch",
      recordId: c.l.id,
      agent: "crier",
      auditContext: { lane: "creative_terms", price: c.offer.price, monthly: c.offer.monthlyPayment, rent_basis: c.rentBasis },
    });
    if (!gate.sent) {
      row.action = `refused:${gate.reason ?? "unknown"}`;
      refused++;
      continue;
    }
    sent++;
    row.action = "sent";
    row.quo_message_id = gate.result?.id ?? null;

    const iso = new Date().toISOString();
    const existingNotes = c.l.notes ?? "";
    await updateListingRecord(c.l.id, {
      Outreach_Status: "Texted",
      Opener_Basis: "seller_finance_terms_v1",
      Verification_Notes:
        `${existingNotes ? existingNotes + "\n\n" : ""}[CREATIVE terms sent ${iso}] Quo msg ${gate.result?.id ?? "?"}: ` +
        `price $${c.offer.price}${c.offer.priceCappedToValue ? " (value-capped, ask $" + c.l.listPrice + ")" : " (full ask)"}, ` +
        `$${c.offer.downPayment} down, $${c.offer.monthlyPayment}/mo x ${c.offer.termMonths}mo, rent basis ${c.rentBasis}. ` +
        `Mortgage status asked in opener.`,
    }).catch((err) => {
      row.airtable_error = String(err).slice(0, 160);
    });
  }

  // Meter write-back (advisory, mirrors h2).
  if (!dryRun && kvConfigured() && sent > 0) {
    try {
      const key = dailySendMeterKey(new Date());
      const cur = Number((await kvProd.get(key)) ?? 0) || 0;
      await kvProd.setEx(key, String(cur + sent), DAILY_SEND_METER_TTL_S);
    } catch { /* advisory */ }
  }

  const summary = {
    mode: dryRun ? "dry_run" : "live",
    lane_live_flag: laneLive,
    eligible_count: eligibleCount,
    terms_queue: queue.length,
    queue_tiers: {
      free_and_clear: queue.filter((c) => isFreeAndClear(c.enrichment)).length,
      absentee: queue.filter((c) => isAbsentee(c.enrichment)).length,
      enriched: queue.filter((c) => c.enrichment != null).length,
    },
    planned: planned.length,
    daily: { cap: dailyCap, used_at_start: usedAtStart, allowed_this_run: daily.maxPerRunToday, meter_readable: meterReadable },
    sent,
    idempotent_skipped: claimed,
    outside_hours: outsideHours,
    refused,
  };

  await audit({
    agent: "crier",
    event: dryRun ? "creative_outreach_dry_run" : "creative_outreach_live",
    status: "confirmed_success",
    inputSummary: { auth_kind: authKind, dry_run: dryRun, limit },
    outputSummary: summary,
    ms: Date.now() - t0,
  });

  return NextResponse.json({ ...summary, results, duration_ms: Date.now() - t0 });
}
