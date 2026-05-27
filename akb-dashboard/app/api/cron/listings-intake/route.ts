// Listings auto-intake cron (Ship 2 — RentCast source).
// @agent: scout
//
// GET /api/cron/listings-intake[?dry_run=1]
//
// Daily 03:00 UTC. ZIPs come from ZIP_Registry (D1 — Market_Tier ∈
// {launch, active} AND NOT Wholesale_Restricted); `?zips=` overrides for
// manual runs. For each target ZIP:
//   RentCast /listings/sale → normalize → intake-filter (price/beds/SFR/
//   state/listed_date) → dedup vs Listings_V1 → Firecrawl verify (INV-028:
//   exclude renovated/turnkey via portal-page scrape + still-Active check)
//   → (live) create / (dry) report → ZIP_Registry per-ZIP stats write-back.
//
// Firecrawl verify runs AFTER dedup (never scrape a known address) and is
// budget-gated (FIRECRAWL_MAX_SCRAPES_PER_RUN). New reject reasons:
// firecrawl_renovated, firecrawl_inactive, firecrawl_url_unresolved.
//
// Source-neutral route name (RentCast today; pluggable later). ATTOM
// adapter is retained for INV-023 Underwriter deep-math, not intake.
//
// Safety rails (per ship order):
//   - DRY RUN by default; writes only when CRAWLER_INTAKE_LIVE="true"
//     AND not ?dry_run=1. First execution is dry — operator reviews.
//   - ZIP_Registry is the ZIP source (D1, replaces CRAWLER_TARGET_ZIPS).
//     No active registry rows → clean no-op surfacing the blocker.
//   - RentCast quota gate (rentcastQuotaAllows): hard per-run cap +
//     soft weekly-remaining estimate. Over budget → stall + Spine-write.
//   - MAVERICK_CRON_ENABLED gate, dedup-by-address, Outreach_Status=""
//     on live write so H2 Crier picks it up.

import { NextResponse } from "next/server";
import { getListings } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import { writeState } from "@/lib/maverick/write-state";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import { fetchListingsByZip } from "@/lib/crawler/sources/rentcast";
import {
  filterIntakeCandidates,
  normalizeAddressKey,
  daysOnMarketFrom,
  type IntakeCandidate,
} from "@/lib/crawler/intake-filter";
import { shouldAutoPromote, type AutoPromoteBlockReason } from "@/lib/crawler/auto-promote";
import { SOURCE_VERSION_FIELD_NAME, SOURCE_VERSION_V2 } from "@/lib/source-version";
import { rentcastQuotaAllows, computeBurnRate } from "@/lib/maverick/rentcast-burn-rate";
import { fetchExternalRentCastState } from "@/lib/maverick/sources/external-rentcast";
import { fetchVercelKvAuditState } from "@/lib/maverick/sources/vercel-kv-audit";
import { verifyListing, classifyVerifiedListing, FIRECRAWL_RATE_LIMIT_PER_MINUTE } from "@/lib/crawler/sources/firecrawl";
import { runAsyncPool, makeRateGate } from "@/lib/crawler/async-pool";
import { getActiveIntakeRows, updateZipStats } from "@/lib/zip-registry";

export const runtime = "nodejs";
export const maxDuration = 300;

const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
const LISTINGS_TABLE = "tbldMjKBgPiq45Jjs";

const PER_RUN_CAP = Number(process.env.RENTCAST_INTAKE_MAX_CALLS_PER_RUN ?? "30");
// Firecrawl verification budget — one /v2/search (inline scrape) per
// accepted, non-duplicate candidate. Default 1000 covers the ~974 baseline
// + headroom. Over budget → skip remainder + Spine-write.
const FIRECRAWL_MAX_SCRAPES_PER_RUN = Number(process.env.FIRECRAWL_MAX_SCRAPES_PER_RUN ?? "1000");
// Bounded concurrency for the Firecrawl verify pool. Default 20 stays under
// the 50-browser Standard ceiling with headroom; raise if tier upgrades.
const FIRECRAWL_MAX_CONCURRENT = Number(process.env.FIRECRAWL_MAX_CONCURRENT ?? "20");
// Wall-clock guard: Vercel Hobby caps maxDuration at 300s. Stop DISPATCHING
// new Firecrawl calls at 270s (in-flight calls finish); the run ends cleanly
// instead of being killed mid-write. With ~20-way concurrency a single ZIP
// (~50-135 candidates) finishes well inside this.
const FIRECRAWL_TIME_BUDGET_MS = 270_000;

/** Manual ZIP override (comma-sep 5-digit) via `?zips=` or `?zip_override=`.
 *  When present it BYPASSES ZIP_Registry — used for manual per-ZIP dry-run
 *  validation within the lambda ceiling. Empty/absent → registry-driven. */
function readZipOverride(url: URL): string[] {
  const raw = url.searchParams.get("zips") ?? url.searchParams.get("zip_override") ?? "";
  return raw
    .split(",")
    .map((z) => z.trim())
    .filter((z) => /^\d{5}$/.test(z));
}

/** Best-effort estimate of remaining RentCast quota this cycle. Optimistic
 *  (burn-rate consumed estimate counts pricing-agent events only) — used as
 *  the SOFT gate; the per-run cap is the hard one. null on any failure. */
async function estimateRentcastRemaining(): Promise<number | null> {
  try {
    const [rc, au] = await Promise.all([
      fetchExternalRentCastState(),
      fetchVercelKvAuditState(),
    ]);
    if (!rc.ok || !rc.data) return null;
    const now = new Date();
    const daysElapsedInCycle = now.getUTCDate(); // days into the month
    const burn = computeBurnRate({
      rentcast: rc.data,
      audit: au.ok ? au.data : null,
      windowHours: 24,
      daysElapsedInCycle,
    });
    return burn.estimated_calls_remaining;
  } catch {
    return null;
  }
}

async function createIntakeListing(c: IntakeCandidate, promote: boolean): Promise<string> {
  if (!AIRTABLE_PAT) throw new Error("AIRTABLE_PAT not set");
  const url = `https://api.airtable.com/v0/${BASE_ID}/${LISTINGS_TABLE}`;
  const iso = new Date().toISOString();
  // promote → written H2-ready (Outreach_Status empty + Auto Proceed + Active).
  // !promote → Review queue for operator/Maverick triage (today's behavior).
  const fields: Record<string, unknown> = {
    Address: c.address ?? "",
    City: c.city ?? "",
    State: c.state ?? "",
    Zip: c.zip ?? "",
    // Every crawler-written record is v2 (INV-LEGACY-BACKSTOP) — promoted,
    // review-queued, all of them. Marks the active working surface.
    [SOURCE_VERSION_FIELD_NAME]: SOURCE_VERSION_V2,
  };
  if (c.propertyType) fields["Property_Type"] = c.propertyType;
  if (c.beds != null) fields["Bedrooms"] = c.beds;
  if (c.listPrice != null) fields["List_Price"] = c.listPrice;
  // Agent contact (INV-CRAWLER-AGENT-ENRICHMENT) — written as-is; H2 normalizes
  // phone format. Set only when present; never synthesize.
  if (c.agentName) fields["Agent_Name"] = c.agentName;
  if (c.agentPhone) fields["Agent_Phone"] = c.agentPhone;
  if (c.agentEmail) fields["Agent_Email"] = c.agentEmail;
  if (promote) {
    fields["Outreach_Status"] = ""; // empty → H2 eligibility filter picks it up
    fields["Execution_Path"] = "Auto Proceed";
    fields["Live_Status"] = "Active";
    fields["Do_Not_Text"] = false;
    // NOTE: Stage_Calc (fldA8B9zOCneF0rjp) is a FORMULA field — writing it 422s
    // the create. H2 eligibility never reads it (only Outreach_Status +
    // Live_Status + Execution_Path + Do_Not_Text + Agent_Phone), so the promote
    // state is fully expressed by the four writable fields above.
    fields["Verification_Notes"] =
      `[${iso}] RentCast auto-intake (${c.sourceId}) — auto-promoted to Auto Proceed (clean agent phone + math gate passed).`;
  } else {
    fields["Outreach_Status"] = "Review";
    fields["Verification_Notes"] =
      `[${iso}] RentCast auto-intake (${c.sourceId}) — queued for Review.`;
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${AIRTABLE_PAT}`, "Content-Type": "application/json" },
    body: JSON.stringify({ records: [{ fields }], typecast: true }),
  });
  if (!res.ok) throw new Error(`intake create ${res.status}: ${await res.text().catch(() => "")}`);
  const body = (await res.json()) as { records?: Array<{ id: string }> };
  const id = body.records?.[0]?.id;
  if (!id) throw new Error("intake create returned no record id");
  return id;
}

export async function GET(req: Request) {
  const t0 = Date.now();
  const url = new URL(req.url);

  // ── Auth waterfall ──────────────────────────────────────────────
  const cookieHeader = req.headers.get("cookie");
  const isDashboard = hasDashboardSession(cookieHeader);
  let authKind: "dashboard_session" | "oauth" | "cron" | "bearer_dev" | "none" = "none";
  if (isDashboard) {
    authKind = "dashboard_session";
  } else {
    const env = readAuthEnv();
    const headers = readAuthHeaders(req);
    const authRequired = kvConfigured() || env.cronSecret !== null || env.bearerDevToken !== null;
    if (authRequired) {
      const auth = await authenticate(headers, env, kvProd);
      if (!auth.ok) {
        return NextResponse.json({ error: "unauthorized", reason: auth.reason }, { status: 401 });
      }
      authKind = auth.kind;
    }
  }
  if (authKind === "cron" && process.env.MAVERICK_CRON_ENABLED !== "true") {
    return NextResponse.json({ error: "cron_disabled" }, { status: 503 });
  }

  const liveEnv = process.env.CRAWLER_INTAKE_LIVE === "true";
  const forcedDry = url.searchParams.get("dry_run") === "1";
  const dryRun = !liveEnv || forcedDry;

  // Auto-promote flags (INV-CRAWLER-AGENT-ENRICHMENT). Independent of the
  // intake dry/live gate above: even on a live intake run, clean accepts only
  // skip Review when LIVE is on AND DRY_RUN is off. Default (both unset) =
  // today's behavior: everything → Review queue.
  const autoPromoteLive = process.env.CRAWLER_AUTO_PROMOTE_LIVE === "true";
  const autoPromoteDryRun = process.env.CRAWLER_AUTO_PROMOTE_DRY_RUN === "true";

  // ?debug=true — investigation only. Adds a per-record `debug` block to the
  // response (basic-filter rejects, duplicates, and per-record Firecrawl
  // decisions with matched phrases + surrounding page context). Changes NO
  // filter behavior; just surfaces what each classifier decided and why.
  const debug = url.searchParams.get("debug") === "true";
  const debugBasicRejected: Array<{ sourceId: string; address: string | null; zip: string | null; reasons: string[] }> = [];
  const debugDuplicates: Array<{ sourceId: string; address: string | null; zip: string | null }> = [];
  const debugDecisions: Array<Record<string, unknown>> = [];

  // ── ZIP source: manual override bypasses the registry; otherwise
  // read launch/active, non-wholesale-restricted ZIPs from ZIP_Registry
  // (D1 — replaces the CRAWLER_TARGET_ZIPS env). zipToRecordId lets the
  // post-run stats write-back find each ZIP's registry row. ───────────
  const overrideZips = readZipOverride(url);
  const overrideUsed = overrideZips.length > 0;
  let zips: string[] = overrideZips;
  const zipToRecordId = new Map<string, string>();
  let zipSource: "override" | "registry" = "override";
  if (!overrideUsed) {
    zipSource = "registry";
    try {
      const rows = await getActiveIntakeRows();
      zips = Array.from(new Set(rows.map((r) => r.zip))).sort();
      for (const r of rows) if (!zipToRecordId.has(r.zip)) zipToRecordId.set(r.zip, r.recordId);
    } catch (err) {
      return NextResponse.json(
        { error: "zip_registry_fetch_failed", message: err instanceof Error ? err.message : String(err) },
        { status: 502 },
      );
    }
  }

  if (zips.length === 0) {
    await audit({
      agent: "scout",
      event: "listings_intake_no_zips",
      status: "uncertain",
      inputSummary: { auth_kind: authKind, dry_run: dryRun, zip_source: zipSource },
      outputSummary: { blocker: "no active ZIPs in ZIP_Registry", duration_ms: Date.now() - t0 },
    });
    return NextResponse.json({
      ok: true,
      blocked: "no_target_zips",
      detail:
        "No launch/active, non-wholesale-restricted ZIPs in ZIP_Registry. Add/activate ZIPs there, or pass ?zips=78201 for a manual run.",
      zip_source: zipSource,
      dry_run: dryRun,
      auth_kind: authKind,
      duration_ms: Date.now() - t0,
    });
  }

  // ── RentCast quota gate (stall + Spine-write if would exceed) ───
  const estimatedRemaining = await estimateRentcastRemaining();
  const quota = rentcastQuotaAllows({
    estimatedRemaining,
    callsNeeded: zips.length,
    perRunCap: PER_RUN_CAP,
  });
  if (!quota.allowed) {
    await audit({
      agent: "scout",
      event: "listings_intake_quota_stall",
      status: "uncertain",
      inputSummary: { auth_kind: authKind, calls_needed: quota.callsNeeded, per_run_cap: quota.perRunCap },
      outputSummary: { reason: quota.reason, estimated_remaining: estimatedRemaining, duration_ms: Date.now() - t0 },
    });
    try {
      await writeState({
        event_type: "decision",
        attribution_agent: "scout",
        title: `Listings-intake cron STALLED on RentCast quota (${quota.reason})`,
        description:
          `listings-intake aborted before spending RentCast quota. reason=${quota.reason}, ` +
          `calls_needed=${quota.callsNeeded}, per_run_cap=${quota.perRunCap}, ` +
          `estimated_weekly_remaining=${estimatedRemaining ?? "unknown"}. No ZIPs fetched. ` +
          `Raise RENTCAST_INTAKE_MAX_CALLS_PER_RUN or wait for quota reset.`,
      });
    } catch (err) {
      console.error("[listings-intake] Spine write (quota stall) failed:", err);
    }
    return NextResponse.json({
      ok: true,
      blocked: "rentcast_quota",
      reason: quota.reason,
      calls_needed: quota.callsNeeded,
      per_run_cap: quota.perRunCap,
      estimated_remaining: estimatedRemaining,
      dry_run: dryRun,
      duration_ms: Date.now() - t0,
    });
  }

  // ── Existing-address dedup set ──────────────────────────────────
  let existingKeys: Set<string>;
  try {
    const listings = await getListings();
    existingKeys = new Set(listings.map((l) => normalizeAddressKey(l.address)));
  } catch (err) {
    return NextResponse.json(
      { error: "listings_fetch_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  const summary = {
    source: "rentcast",
    dry_run: dryRun,
    zips_scanned: zips.length,
    raw_candidates: 0,
    accepted: 0,
    flagged_review: 0,
    rejected: 0,
    duplicates: 0,
    written: 0,
    per_zip: [] as Array<{ zip: string; raw: number; accepted: number; review: number }>,
    // Auto-promote accounting (INV-CRAWLER-AGENT-ENRICHMENT). Counts span every
    // record that reached the write stage; on a dry intake run they are the
    // "would" figures. eligible = intrinsically promotable; promoted = actually
    // (or would be) written H2-ready after the LIVE/DRY_RUN flags apply.
    auto_promote: {
      live: autoPromoteLive,
      dry_run: autoPromoteDryRun,
      eligible: 0,
      promoted: 0,
      review_queued: 0,
      missing_agent_phone: 0,
      reasons_blocked: {} as Record<string, number>,
    },
    would_write: [] as Array<{ sourceId: string; address: string | null; zip: string | null; listPrice: number | null; firecrawlUrl: string | null; outreachStatus: "" | "Review"; promote: boolean; agentPhonePresent: boolean }>,
    reject_reason_counts: {} as Record<string, number>,
    per_zip_errors: [] as Array<{ zip: string; error: string }>,
    credentialed: true,
    firecrawl: {
      credentialed: true,
      scrapes_used: 0,
      credits_used: 0,
      budget: FIRECRAWL_MAX_SCRAPES_PER_RUN,
      budget_hit: false,
      time_budget_hit: false,
      rate_limit_per_minute: FIRECRAWL_RATE_LIMIT_PER_MINUTE,
    },
  };
  const now = new Date();
  const bump = (reason: string, n = 1) => {
    summary.reject_reason_counts[reason] = (summary.reject_reason_counts[reason] ?? 0) + n;
  };

  // ── Phase 1: collect — RentCast fetch batched 3-concurrent (D1), then
  // synchronous basic-filter + dedup per result. Only the network fetch
  // runs in parallel; the dedup Sets are mutated synchronously after each
  // batch resolves, so there are no intra-run dedup races.
  const ZIP_FETCH_CONCURRENCY = 3;
  const perZipRaw = new Map<string, number>();
  const perZipAccepted = new Map<string, number>();
  const perZipReview = new Map<string, number>();
  // D1 stats accumulators (per-ZIP) for the ZIP_Registry write-back.
  const perZipConsidered = new Map<string, number>(); // classified (accept+review+reject)
  const perZipIngested = new Map<string, number>(); // written (accept+review)
  const perZipDom = new Map<string, { sum: number; n: number }>();
  const perZipPrice = new Map<string, { sum: number; n: number }>();
  const zipsProcessedOk = new Set<string>(); // RentCast fetch succeeded (incl. 0 candidates)
  const seenKeys = new Set<string>(); // intra-run dedup across overlapping ZIPs
  const toVerify: Array<{ candidate: IntakeCandidate; zip: string }> = [];

  for (let i = 0; i < zips.length; i += ZIP_FETCH_CONCURRENCY) {
    const chunk = zips.slice(i, i + ZIP_FETCH_CONCURRENCY);
    const fetched = await Promise.all(
      chunk.map((zip) =>
        fetchListingsByZip(zip).then(
          (r) => ({ zip, result: r as Awaited<ReturnType<typeof fetchListingsByZip>>, err: null as unknown }),
          (err) => ({ zip, result: null, err }),
        ),
      ),
    );

    for (const { zip, result: fetchResult, err } of fetched) {
      if (err || !fetchResult) {
        summary.per_zip_errors.push({ zip, error: err instanceof Error ? err.message : String(err) });
        continue;
      }
      if (!fetchResult.credentialed) {
        summary.credentialed = false;
        summary.per_zip_errors.push({ zip, error: "RENTCAST_API_KEY not set" });
        continue;
      }
      if (fetchResult.error) {
        summary.per_zip_errors.push({ zip, error: fetchResult.error });
        continue;
      }
      zipsProcessedOk.add(zip);
      summary.raw_candidates += fetchResult.candidates.length;
      perZipRaw.set(zip, fetchResult.candidates.length);

      const { accepted, rejected } = filterIntakeCandidates(fetchResult.candidates, now);
      summary.rejected += rejected.length;
      for (const r of rejected) {
        for (const reason of r.reasons) bump(reason);
        if (debug) debugBasicRejected.push({ sourceId: r.candidate.sourceId, address: r.candidate.address, zip: r.candidate.zip, reasons: r.reasons });
      }

      for (const c of accepted) {
        // Dedup BEFORE Firecrawl — never spend a scrape on a known/seen address.
        const key = normalizeAddressKey(c.address);
        if (key && (existingKeys.has(key) || seenKeys.has(key))) {
          summary.duplicates++;
          if (debug) debugDuplicates.push({ sourceId: c.sourceId, address: c.address, zip: c.zip });
          continue;
        }
        if (key) seenKeys.add(key);
        toVerify.push({ candidate: c, zip });
      }
    }
  }

  // ── Budget split: dispatch up to the per-run Firecrawl scrape budget. ──
  const dispatchable = toVerify.slice(0, FIRECRAWL_MAX_SCRAPES_PER_RUN);
  const budgetSkipped = toVerify.slice(FIRECRAWL_MAX_SCRAPES_PER_RUN);
  if (budgetSkipped.length > 0) {
    summary.firecrawl.budget_hit = true;
    bump("firecrawl_skipped_budget", budgetSkipped.length);
  }

  // ── Phase 2: parallel Firecrawl verification — bounded concurrency +
  // global rate gate + wall-clock guard. In-flight calls finish on stop;
  // undispatched land in pool.skipped.
  const rateGate = makeRateGate(FIRECRAWL_RATE_LIMIT_PER_MINUTE);
  const pool = await runAsyncPool({
    items: dispatchable,
    concurrency: FIRECRAWL_MAX_CONCURRENT,
    beforeDispatch: rateGate,
    shouldStopDispatch: () => Date.now() - t0 > FIRECRAWL_TIME_BUDGET_MS,
    worker: async (it) => verifyListing(it.candidate.address, { debug }),
  });
  const timeBudgetHit = pool.skipped.length > 0;
  if (timeBudgetHit) bump("firecrawl_skipped_time", pool.skipped.length);

  // ── Phase 3: classify completed results (sequential — accurate count
  // aggregation regardless of non-deterministic completion order). ──
  const toWrite: Array<{ candidate: IntakeCandidate; zip: string; promote: boolean }> = [];
  const bumpBlocked = (reason: AutoPromoteBlockReason | "auto_promote_disabled" | "auto_promote_dry_run") => {
    summary.auto_promote.reasons_blocked[reason] = (summary.auto_promote.reasons_blocked[reason] ?? 0) + 1;
  };
  for (const { item, value: fc } of pool.results) {
    const { candidate: c, zip } = item;
    summary.firecrawl.scrapes_used++;
    summary.firecrawl.credits_used += fc.creditsUsed;
    // D1: every verified candidate is "considered" for the per-ZIP
    // classifier accept rate (denominator includes classifier rejects).
    perZipConsidered.set(zip, (perZipConsidered.get(zip) ?? 0) + 1);

    // DOM / priceReduced are DIAGNOSTIC ONLY (operator amendment 2026-05-27) —
    // surfaced in the debug payload below, but no longer an input to the
    // classifier. DOM falls back to a listed-date derivation when the feed
    // omits daysOnMarket.
    const dom = c.daysOnMarket ?? daysOnMarketFrom(c.listedDate, now);
    const priceReduced = c.priceReduced ?? false;
    const decision = classifyVerifiedListing(fc);
    if (debug) {
      debugDecisions.push({
        sourceId: c.sourceId,
        address: c.address,
        zip,
        url: fc.url,
        resolved: fc.resolved,
        outcome: decision.outcome,
        reason: "reason" in decision ? decision.reason : null,
        stillActive: fc.stillActive,
        hasRenovatedLanguage: fc.hasRenovatedLanguage,
        isNewConstruction: fc.isNewConstruction,
        hasConditionSignal: fc.hasConditionSignal,
        daysOnMarket: dom,
        priceReduced,
        wholesalerExcluded: fc.wholesalerExcluded,
        matched: {
          new_construction: fc.matchedNewConstructionSignals,
          renovation: fc.matchedKeywords,
          inactive: fc.matchedInactiveMarkers,
          wholesaler: fc.matchedWholesalerKeywords,
          distress: fc.matchedDistressKeywords,
        },
        contexts: fc.debugContexts ?? [],
        page_excerpt: fc.pageExcerpt ?? null,
      });
    }
    if (decision.outcome === "reject") {
      bump(decision.reason);
      // Surface infra-class failures into per_zip_errors for triage.
      if (decision.reason === "firecrawl_not_configured") summary.firecrawl.credentialed = false;
      if (
        decision.reason === "firecrawl_not_configured" ||
        decision.reason === "firecrawl_rate_limited" ||
        decision.reason === "firecrawl_error"
      ) {
        summary.per_zip_errors.push({ zip, error: `${decision.reason}: ${c.sourceId}${fc.error ? ` (${fc.error})` : ""}` });
      }
      continue;
    }

    // accept or review (condition-missing) — both WRITE. Only accepts can
    // auto-promote; reviews always land in the Review queue.
    const accepted = decision.outcome === "accept";
    if (accepted) {
      summary.accepted++;
      perZipAccepted.set(zip, (perZipAccepted.get(zip) ?? 0) + 1);
    } else {
      bump("condition_signal_missing_flagged"); // audit tag — still writes
      summary.flagged_review++;
      perZipReview.set(zip, (perZipReview.get(zip) ?? 0) + 1);
    }
    // D1 write-back accumulators: accepts + reviews both write to
    // Listings_V1 (ingested volume); DOM/price means use accepted only.
    perZipIngested.set(zip, (perZipIngested.get(zip) ?? 0) + 1);
    if (accepted) {
      if (typeof dom === "number" && Number.isFinite(dom)) {
        const d = perZipDom.get(zip) ?? { sum: 0, n: 0 };
        perZipDom.set(zip, { sum: d.sum + dom, n: d.n + 1 });
      }
      if (typeof c.listPrice === "number" && Number.isFinite(c.listPrice)) {
        const p = perZipPrice.get(zip) ?? { sum: 0, n: 0 };
        perZipPrice.set(zip, { sum: p.sum + c.listPrice, n: p.n + 1 });
      }
    }

    // Intrinsic auto-promote eligibility, then layer the feature flags.
    const ap = shouldAutoPromote({ accepted, agentPhone: c.agentPhone, state: c.state, listPrice: c.listPrice });
    if (ap.promote) summary.auto_promote.eligible++;
    if (accepted && !ap.promote && ap.reason) {
      bumpBlocked(ap.reason);
      if (ap.reason === "no_agent_phone") summary.auto_promote.missing_agent_phone++;
    }
    // A record actually writes H2-ready only when intrinsically eligible AND
    // the master flag is on AND not in auto-promote dry-run.
    let promote = ap.promote;
    if (ap.promote && !autoPromoteLive) { promote = false; bumpBlocked("auto_promote_disabled"); }
    else if (ap.promote && autoPromoteDryRun) { promote = false; bumpBlocked("auto_promote_dry_run"); }

    if (promote) summary.auto_promote.promoted++;
    else summary.auto_promote.review_queued++;

    // One structured line per written record — operator reads the promote
    // decision straight from Vercel logs without grep gymnastics.
    console.log(
      `[listings-intake][auto-promote] ${c.sourceId} accepted=${accepted} ` +
      `promote=${promote} reason=${ap.reason ?? "-"} phone=${c.agentPhone ? "y" : "n"} state=${c.state ?? "?"}`,
    );

    if (dryRun) {
      summary.would_write.push({
        sourceId: c.sourceId, address: c.address, zip: c.zip, listPrice: c.listPrice,
        firecrawlUrl: fc.url, outreachStatus: promote ? "" : "Review",
        promote, agentPhonePresent: !!c.agentPhone,
      });
    } else {
      toWrite.push({ candidate: c, zip, promote });
    }
  }

  // ── Phase 4: writes (live only; sequential, post-pool — no concurrent
  // Airtable writes / intra-run dup races). ──
  if (!dryRun) {
    for (const { candidate: c, zip, promote } of toWrite) {
      try {
        await createIntakeListing(c, promote);
        summary.written++;
      } catch (err) {
        summary.per_zip_errors.push({
          zip,
          error: `write ${c.sourceId}: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  for (const zip of zips) {
    summary.per_zip.push({ zip, raw: perZipRaw.get(zip) ?? 0, accepted: perZipAccepted.get(zip) ?? 0, review: perZipReview.get(zip) ?? 0 });
  }

  // ── Phase 4b: ZIP_Registry stats write-back (D1). Registry-driven live
  // runs only — manual ?zips= overrides have no registry row, and dry runs
  // never mutate. Writes the latest-run snapshot into the *_30d fields
  // (see lib/zip-registry ZipStatsUpdate note: true 30d rolling lands with
  // the saturation follow-up, the sole consumer of these fields).
  const registryWriteback = { written: 0, skipped: false as boolean | string, errors: [] as string[] };
  if (overrideUsed) {
    registryWriteback.skipped = "manual_override";
  } else if (dryRun) {
    registryWriteback.skipped = "dry_run";
  } else {
    const nowIso = new Date().toISOString();
    for (const zip of zipsProcessedOk) {
      const recordId = zipToRecordId.get(zip);
      if (!recordId) continue;
      const considered = perZipConsidered.get(zip) ?? 0;
      const accepted = perZipAccepted.get(zip) ?? 0;
      const dom = perZipDom.get(zip);
      const price = perZipPrice.get(zip);
      try {
        await updateZipStats(recordId, {
          lastIngestedAt: nowIso,
          acceptRate30d: considered > 0 ? accepted / considered : 0,
          avgDom: dom && dom.n > 0 ? Math.round(dom.sum / dom.n) : null,
          avgListPrice: price && price.n > 0 ? Math.round(price.sum / price.n) : null,
          recordsIngested30d: perZipIngested.get(zip) ?? 0,
        });
        registryWriteback.written++;
      } catch (err) {
        registryWriteback.errors.push(`${zip}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  summary.firecrawl.time_budget_hit = timeBudgetHit;

  // Firecrawl budget OR the 300s lambda wall-clock exceeded mid-run →
  // Spine-write so the operator knows the run was partial.
  if (summary.firecrawl.budget_hit || timeBudgetHit) {
    const cause = timeBudgetHit ? "300s lambda wall-clock" : "Firecrawl credit budget";
    try {
      await writeState({
        event_type: "decision",
        attribution_agent: "scout",
        title: `Listings-intake PARTIAL run — stopped on ${cause}`,
        description:
          `listings-intake stopped mid-run. cause=${cause}. ` +
          `firecrawl scrapes_used=${summary.firecrawl.scrapes_used} (budget ${FIRECRAWL_MAX_SCRAPES_PER_RUN}), ` +
          `credits_used=${summary.firecrawl.credits_used}, accepted=${summary.accepted}. ` +
          `Remaining candidates skipped (firecrawl_skipped_time / firecrawl_skipped_budget). ` +
          `A single Vercel Hobby 300s invocation cannot verify the full ~974 set (per-call Firecrawl ` +
          `latency × volume far exceeds 300s, independent of Firecrawl tier). To validate all 15 ZIPs, ` +
          `run the dry-run per-ZIP via ?zips=<zip>; live intake chips through via daily runs + address dedup.`,
      });
    } catch (err) {
      console.error("[listings-intake] Spine write (partial-run) failed:", err);
    }
  }

  await audit({
    agent: "scout",
    event: dryRun ? "listings_intake_dry_run" : "listings_intake_live",
    status: summary.per_zip_errors.length > 0 ? "uncertain" : "confirmed_success",
    inputSummary: { auth_kind: authKind, zips: zips.length, dry_run: dryRun, source: "rentcast" },
    outputSummary: {
      raw: summary.raw_candidates,
      accepted: summary.accepted,
      flagged_review: summary.flagged_review,
      rejected: summary.rejected,
      duplicates: summary.duplicates,
      written: summary.written,
      reject_reasons: summary.reject_reason_counts,
      firecrawl_scrapes: summary.firecrawl.scrapes_used,
      firecrawl_credits: summary.firecrawl.credits_used,
      per_zip: summary.per_zip,
      auto_promote: summary.auto_promote,
    },
    ms: Date.now() - t0,
  });

  return NextResponse.json({
    ok: true,
    auth_kind: authKind,
    duration_ms: Date.now() - t0,
    zip_source: zipSource,
    registry: registryWriteback,
    ...summary,
    ...(debug
      ? {
          debug: {
            basic_rejected: debugBasicRejected,
            duplicates: debugDuplicates,
            verify_decisions: debugDecisions,
            time_skipped: pool.skipped.map((it) => ({ sourceId: it.candidate.sourceId, address: it.candidate.address, zip: it.zip })),
            budget_skipped: budgetSkipped.map((it) => ({ sourceId: it.candidate.sourceId, address: it.candidate.address, zip: it.zip })),
          },
        }
      : {}),
  });
}
