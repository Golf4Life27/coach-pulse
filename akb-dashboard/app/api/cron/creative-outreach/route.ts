// Creative outreach — seller-finance terms first-touch (LIVE 2026-08-18,
// operator-approved v4 template + 5-year balloon default).
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
//   2. CREATIVE_OUTREACH_LIVE must be EXPLICITLY "true" or every run is
//      forced dry — the per-lane switch (explicit opt-in since 2026-08-23;
//      an absent, deleted, or malformed var means DARK, never sending).
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
import { outreachReadyReason, buildDeliveryQuarantineNote } from "@/lib/h2-outreach";
import { getMessageStatus } from "@/lib/quo";
import { normalizePhone } from "@/lib/phone-normalize";
import { evaluateSendWindow } from "@/lib/h2-working-hours";
import { verifyListing, classifyVerifiedListing } from "@/lib/crawler/sources/firecrawl";
import { checkFirecrawlBreaker } from "@/lib/crawler/firecrawl-circuit-breaker";
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

// Delivery-confirmation polling — same envs as the cash lane so ops tuning
// applies to both. A 2xx from Quo means QUEUED, not DELIVERED; Texted is
// only stamped on a confirmed terminal success (2026-08-22 external review,
// Pass B #7 — this lane was stamping Texted on dispatch).
const POLL_ATTEMPTS = Number(process.env.H2_CRON_POLL_ATTEMPTS ?? "6");
const POLL_DELAY_MS = Number(process.env.H2_CRON_POLL_DELAY_MS ?? "5000");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  // ── Lane flag: LIVE since 2026-08-18 (operator ordered the flip, spine
  // reczqSOSqJ3MTY9fi); EXPLICIT OPT-IN since 2026-08-23 (external review +
  // operator, after setting CREATIVE_OUTREACH_LIVE=true in Vercel first).
  // v1 was `!== "false"` — live-by-default, so an absent, deleted, or
  // malformed var silently ENABLED a lane that texts real people. Now only
  // the exact string "true" goes live; anything else forces dry-run.
  // H2_OUTREACH_HARD_DISABLE remains the master kill for every SMS lane.
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
    toE164: string;
  };
  const queue: Candidate[] = [];
  let eligibleCount = 0;

  for (const l of listings) {
    // FRESHNESS + MARKET GATE (operator catch 2026-08-18: "some of those
    // records are from May and April... we don't even know if they're on the
    // market still"). v1 of this route gated on isH2Eligible ALONE, which has
    // no freshness window — the terms queue happily held listings nobody had
    // verified in months. Same selector as the cash lane now: eligible AND
    // actionable market (paused/excluded markets never text) AND confirmed
    // on-market inside the freshness window. A terms offer on a delisted
    // property is spam with our name on it.
    if (!outreachReadyReason(l).ready) continue;
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
    // E.164 — Airtable stores agent phones as bare 10-digit strings; Quo's
    // API 400s anything not ^\+[1-9]\d{1,14}$. The cash lane normalizes in
    // its planner; v1 of this route passed the raw field and the entire
    // first live run (2026-08-18 21:35Z) refused as thread_truth_unavailable
    // on Quo 400s. Same normalizer, unroutable numbers drop here.
    const toE164 = normalizePhone(l.agentPhone);
    if (!toE164) continue;

    queue.push({
      l,
      offer: sf,
      rentBasis,
      body: renderTermsOpener({ agentName: l.agentName, address: l.address, listPrice: l.listPrice!, offer: sf }),
      enrichment,
      toE164,
    });
  }

  // Lien-aware ordering: free-and-clear > absentee > last-cash-buyer tiers,
  // then the offer-quality score (full-ask first, buyer CoC tiebreak).
  queue.sort((a, b) => creativePriority(b.offer, b.enrichment) - creativePriority(a.offer, a.enrichment));
  // ── Candidate pool vs send cap (2026-08-23, the Sunday 0-for-10 live-lock).
  // The gate-parity fix armed thread-truth on this lane, and refusals turned
  // out to CLUSTER: brokerage switchboard numbers with any recent inbound
  // refuse every property they carry (doctrine-correct, Canfield rule). v1
  // planned exactly `limit` candidates, so when the deterministic top-10 all
  // refused, the slot sent zero — and the next slot rebuilt the SAME top-10:
  // both 2026-08-23 slots went 0/10 while 127 sendable candidates below never
  // got tried. Cash-lane parity: try a DEEPER pool, stop at `limit` actual
  // sends. TRY_FACTOR bounds the Firecrawl probe spend a refusal-heavy slot
  // can burn (the hourly breaker still rides on top of it).
  const TRY_FACTOR = 3;
  const planned = queue.slice(0, limit * TRY_FACTOR);

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
  // maxPerRun is the SEND cap (`limit`), not the candidate-pool size — the
  // pool is deliberately deeper so refusals skip to the next candidate.
  const daily = governDailySends({ maxPerRun: Math.min(limit, planned.length), dailyCap, usedToday: meterReadable ? usedAtStart : null });

  const results: Array<Record<string, unknown>> = [];
  let sent = 0;
  let claimed = 0;
  let outsideHours = 0;
  let refused = 0;
  let deliveredCount = 0;
  let unconfirmedCount = 0;
  let quarantinedCount = 0;
  const probe = { probes: 0, credits_used: 0, disposed_inactive: 0, content_rejected: 0, infra_skipped: 0 };
  const probeBreaker = dryRun ? null : await checkFirecrawlBreaker().catch(() => null);

  for (const c of planned) {
    // Stop at the SEND cap, not the candidate count — refused candidates do
    // not consume the slot's allowance.
    if (!dryRun && sent >= daily.maxPerRunToday) break;
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

    // ── PRE-SEND CONTENT PROBE — the LAST look at the live page before a
    // money-bearing text (same rail as the cash lane; ported 2026-08-18 with
    // the freshness-gate fix). Even a 48h-fresh record can have delisted or
    // gone pending since its last verify; a full-ask terms offer on a dead
    // listing is worse than a lowball on a live one. Content verdicts route
    // the record OUT of the queue; infra failures skip fail-closed and the
    // record stays queued for the next slot. Runs BEFORE the claim — probe
    // outcomes must never wedge a claim.
    {
      const breakerBlocked =
        !probeBreaker || probeBreaker.tripped || probeBreaker.spentRecent + probe.credits_used >= probeBreaker.cap;
      const fc = breakerBlocked || !c.l.address ? null : await verifyListing(c.l.address).catch(() => null);
      if (fc) {
        probe.probes++;
        probe.credits_used += fc.creditsUsed ?? 0;
      }
      const verdict = fc ? classifyVerifiedListing(fc) : null;
      const iso0 = new Date().toISOString();
      const notes0 = c.l.notes ?? "";
      if (verdict?.outcome === "reject" && verdict.reason === "firecrawl_inactive") {
        await updateListingRecord(c.l.id, {
          Outreach_Status: "Dead",
          Verification_Notes:
            `${notes0 ? notes0 + "\n\n" : ""}[${iso0}] Creative pre-send probe: listing no longer active — disposed before terms text.`,
        }).catch(() => {});
        row.action = "probe_disposed_inactive";
        probe.disposed_inactive++;
        continue;
      }
      if (
        verdict?.outcome === "reject" &&
        (verdict.reason === "firecrawl_renovated" ||
          verdict.reason === "new_construction_excluded" ||
          verdict.reason === "wholesaler_excluded")
      ) {
        await updateListingRecord(c.l.id, {
          ...(verdict.reason === "firecrawl_renovated" ? { Renovated_Language: true } : {}),
          Outreach_Status: "Review",
          Verification_Notes:
            `${notes0 ? notes0 + "\n\n" : ""}[${iso0}] Creative pre-send probe: ${verdict.reason} — terms text SUPPRESSED, routed to Review.`,
        }).catch(() => {});
        row.action = `probe_content_reject:${verdict.reason}`;
        probe.content_rejected++;
        continue;
      }
      if (!verdict || verdict.outcome === "reject") {
        row.action = `probe_infra_skip:${breakerBlocked ? "breaker_blocked" : verdict?.reason ?? "probe_failed"}`;
        probe.infra_skipped++;
        continue;
      }
    }

    // Claim BEFORE send: a crashed run must never double-text. ATOMIC setNx
    // (2026-08-22 external review, Pass B #2): the v1 get-then-setEx pair let
    // two overlapping runs both observe "no claim" and both send — the same
    // race h2's dispatch claim already closes. Exactly one setNx wins.
    if (kvConfigured()) {
      try {
        const key = `${CLAIM_PREFIX}${c.l.id}`;
        const acquired = await kvProd.setNx(key, new Date().toISOString(), CLAIM_TTL_S);
        if (!acquired) {
          row.action = "idempotent_skipped";
          claimed++;
          continue;
        }
      } catch {
        row.action = "kv_unavailable_skipped"; // fail toward NOT sending
        continue;
      }
    } else {
      row.action = "kv_unavailable_skipped";
      continue;
    }

    const gate = await sendGuarded({
      to: c.toE164,
      body: c.body,
      purpose: "first_touch",
      recordId: c.l.id,
      agent: "crier",
      // The gate's compliance vetoes — doNotText, Blacklist/operator-kill,
      // NEVER_RESURFACE, renovated — CANNOT fire when listing is omitted, and
      // v1 of this route omitted it (2026-08-22 external review, Pass B #1;
      // fourth rail-parity miss). Queue-build eligibility checked these flags
      // earlier, but data can change between selection and dispatch — the
      // choke point gets the same fresh snapshot the cash lane passes.
      listing: {
        doNotText: c.l.doNotText,
        renovatedLanguage: c.l.renovatedLanguage ?? null,
        blacklist: c.l.blacklist ?? null,
        address: c.l.address,
        notes: c.l.notes,
        lastInboundAt: c.l.lastInboundAt,
      },
      auditContext: { lane: "creative_terms", price: c.offer.price, monthly: c.offer.monthlyPayment, rent_basis: c.rentBasis },
    });
    if (!gate.sent) {
      row.action = `refused:${gate.reason ?? "unknown"}`;
      refused++;
      // No SMS went out — release the claim taken above, or a transient
      // refusal (thread-truth blip, dedupe window) poisons this record for
      // the full 90-day claim TTL. Same defect class as the 2026-08-18
      // h2 poison-claim fix (Spine rec0so7DROpDz86LN).
      if (kvConfigured()) {
        await kvProd.del(`${CLAIM_PREFIX}${c.l.id}`).catch(() => {});
      }
      continue;
    }
    sent++;
    row.action = "sent";
    row.quo_message_id = gate.result?.id ?? null;

    // ── CONFIRM via message-status polling (2026-08-22 external review, Pass
    // B #7 — h2 parity). A 2xx from Quo means QUEUED, not DELIVERED. Three
    // outcomes: confirmed success → Texted; confirmed carrier failure →
    // auto-quarantine Dead + claim released (dead number, never re-fire);
    // unconfirmed → the sticky receipt (WITH the Quo msg id, so thread-truth
    // stays informed) but NOT Texted — quo-sync/reconcile flips the status
    // when the delivery surfaces. The claim is KEPT on unconfirmed: the SMS
    // may have landed, and a re-text is worse than a stale status.
    const msgId = gate.result?.id ?? null;
    let delivered = false;
    let terminalFailure = false;
    let confirmedStatus: string | null = gate.result?.status ?? null;
    if (msgId) {
      for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
        await sleep(POLL_DELAY_MS);
        try {
          const st = await getMessageStatus(msgId);
          confirmedStatus = st.status;
          if (st.isTerminal) {
            delivered = st.isSuccess;
            terminalFailure = !st.isSuccess;
            break;
          }
        } catch (err) {
          row.poll_error = String(err).slice(0, 120);
        }
      }
    } else {
      row.poll_error = "send returned no message id — cannot confirm";
    }
    row.confirmed_status = confirmedStatus;
    row.delivered = delivered;
    if (delivered) deliveredCount++;
    else if (!terminalFailure) unconfirmedCount++;

    const iso = new Date().toISOString();
    const existingNotes = c.l.notes ?? "";
    if (terminalFailure) {
      row.action = "delivery_quarantined";
      quarantinedCount++;
      await updateListingRecord(c.l.id, {
        Outreach_Status: "Dead",
        Verification_Notes: buildDeliveryQuarantineNote(existingNotes, iso, c.toE164, confirmedStatus, msgId),
      }).catch((err) => {
        row.airtable_error = String(err).slice(0, 160);
      });
      await audit({
        agent: "crier",
        event: "creative_delivery_quarantine",
        status: "confirmed_failure",
        recordId: c.l.id,
        externalId: msgId ?? undefined,
        inputSummary: { phone: c.toE164, confirmedStatus },
        outputSummary: { quarantined: true, reason: `carrier ${confirmedStatus ?? "undelivered"}` },
      }).catch(() => {});
      // Dead record leaves the queue — free the 90-day claim.
      if (kvConfigured()) await kvProd.del(`${CLAIM_PREFIX}${c.l.id}`).catch(() => {});
      continue;
    }
    const receiptNote =
      `${existingNotes ? existingNotes + "\n\n" : ""}[CREATIVE terms ${delivered ? "sent" : "sent (delivery unconfirmed)"} ${iso}] Quo msg ${msgId ?? "?"}: ` +
      `price $${c.offer.price}${c.offer.priceCappedToValue ? " (value-capped, ask $" + c.l.listPrice + ")" : " (full ask)"}, ` +
      `$${c.offer.downPayment} down, $${c.offer.monthlyPayment}/mo x ${c.offer.termMonths}mo` +
      `${c.offer.balloonAmount > 0 ? ` + balloon $${c.offer.balloonAmount} at month ${c.offer.termMonths}` : ""}, ` +
      `rent basis ${c.rentBasis}. Mortgage status asked in opener.`;
    await updateListingRecord(c.l.id, {
      // Texted ONLY on confirmed delivery; the unconfirmed receipt still
      // carries the exact number texted + the Quo id (sticky truth), and the
      // reconcile lane upgrades the status once Quo shows terminal success.
      ...(delivered ? { Outreach_Status: "Texted" } : {}),
      // STAMP FIX (2026-08-30, Roselawn recncTnM2UzSz1luw): creative sends
      // wrote neither Last_Outbound_At nor Last_Outreach_Date, so creative-
      // touched records were invisible to the brief-active sweep pool AND to
      // reply-pending scans, and the bump lane could double-send into a live
      // terms thread. Every outbound stamps both, in every lane.
      Last_Outbound_At: iso,
      Last_Outreach_Date: iso.slice(0, 10),
      Opener_Basis: "seller_finance_terms_v1",
      Verification_Notes: receiptNote,
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
    delivered: deliveredCount,
    unconfirmed: unconfirmedCount,
    delivery_quarantined: quarantinedCount,
    idempotent_skipped: claimed,
    outside_hours: outsideHours,
    refused,
    presend_probe: probe,
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
