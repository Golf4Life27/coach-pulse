// Listings auto-intake cron (Ship 2 — RentCast source).
// @agent: scout
//
// GET /api/cron/listings-intake[?dry_run=1]
//
// Schedule: */10 (vercel.json) — was daily 03:00 UTC in the original ship,
// raised to sub-daily on the Pro plan once continuous new-listing capture
// became the desired shape. Gated by CRAWLER_INTAKE_LIVE env: when unset,
// every tick is a dry-run no-op so the slot stays cheap.
// ZIPs come from ZIP_Registry (D1 — Market_Tier ∈
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
import { listSeededZips, FALLBACK_SEEDED_ZIPS } from "@/lib/buyer-median-store";
import {
  filterIntakeCandidates,
  normalizeAddressKey,
  daysOnMarketFrom,
  type IntakeCandidate,
} from "@/lib/crawler/intake-filter";
import { shouldAutoPromote, type AutoPromoteBlockReason } from "@/lib/crawler/auto-promote";
import { type BuyerTrack } from "@/lib/buyer-median-input";
import { buildIntakeListingFields } from "@/lib/crawler/intake-fields";
import { rentcastQuotaAllows, computeBurnRate } from "@/lib/maverick/rentcast-burn-rate";
import { selectDueZips, type ZipDueResult } from "@/lib/crawler/zip-rotation";
import { fetchExternalRentCastState } from "@/lib/maverick/sources/external-rentcast";
import { fetchVercelKvAuditState } from "@/lib/maverick/sources/vercel-kv-audit";
import { verifyListing, classifyVerifiedListing, probeFirecrawlBalance, FIRECRAWL_RATE_LIMIT_PER_MINUTE } from "@/lib/crawler/sources/firecrawl";
import { checkFirecrawlBreaker, recordFirecrawlSpend, shouldHaltVerify } from "@/lib/crawler/firecrawl-circuit-breaker";
import { runAsyncPool, makeRateGate } from "@/lib/crawler/async-pool";
import { getActiveIntakeRows, updateZipStats } from "@/lib/zip-registry";
import { getVerifiedThisCycle, markVerifiedThisCycle } from "@/lib/crawler/verify-cache";
import { transitionToPriced } from "@/lib/pipeline-state/price-transition";
// National crawler (Maverick 2026-06-14) — auto-seed + opener-write, all
// behind CRAWLER_AUTOSEED_LIVE (default off → these paths never execute).
import { decideAutoSeed, runAutoSeed } from "@/lib/crawler/auto-seed";
import { listArvSeededZips, getZipArvSeed, type ZipArvSeed } from "@/lib/zip-arv-seed-store";
import { resolveSeedBudget } from "@/lib/spend/daily-budget";
import { priceOpenerWithSeed } from "@/lib/opener-pricing";
import { getMarketForListing } from "@/lib/markets/registry";
import { resolveAnchorPct } from "@/lib/markets/anchor";

export const runtime = "nodejs";
export const maxDuration = 300;

const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
const LISTINGS_TABLE = "tbldMjKBgPiq45Jjs";

const PER_RUN_CAP = Number(process.env.RENTCAST_INTAKE_MAX_CALLS_PER_RUN ?? "30");
// Per-invocation ZIP cap (2026-06-08 timeout fix). The 30-ZIP daily slice
// hit FUNCTION_INVOCATION_TIMEOUT (300s). Fix forward via FREQUENCY: a
// SMALL cap per invocation + a frequent cron, advancing a freshness cursor.
// Default 6 is a deliberately conservative starting point — the
// self-limiting wall-clock budget below is the hard safety, and the
// per-ZIP timing telemetry in the response lets us size this from
// MEASUREMENT (not a guess): set ≈ floor(LAMBDA_BUDGET_MS / per_zip_avg_ms).
const ZIPS_PER_RUN = Number(process.env.RENTCAST_INTAKE_ZIPS_PER_RUN ?? "6");
// Freshness-cycle window: a ZIP is "due" when last ingested > this many
// hours ago (or never). 24h → each ZIP gets one pass per day, spread
// across many small frequent runs.
const ZIP_CYCLE_HOURS = Number(process.env.RENTCAST_INTAKE_CYCLE_HOURS ?? "24");
// Firecrawl verification budget — one /v2/search (inline scrape) per
// accepted, non-duplicate candidate. Default 1000 covers the ~974 baseline
// + headroom. Over budget → skip remainder + Spine-write.
const FIRECRAWL_MAX_SCRAPES_PER_RUN = Number(process.env.FIRECRAWL_MAX_SCRAPES_PER_RUN ?? "1000");
// Bounded concurrency for the Firecrawl verify pool. Default 20 stays under
// the 50-browser Standard ceiling with headroom; raise if tier upgrades.
const FIRECRAWL_MAX_CONCURRENT = Number(process.env.FIRECRAWL_MAX_CONCURRENT ?? "20");
// SELF-LIMITING wall-clock budget (2026-06-08). maxDuration=300 (Pro max).
// Budget = 180s = 60% of the ceiling → 40% margin per operator directive.
// The route stops DISPATCHING new Firecrawl work at this mark so in-flight
// calls + classify + registry-writeback finish well inside 300s. Combined
// with the small ZIP cap, the run physically cannot hit the lambda timeout
// regardless of per-ZIP variance.
const LAMBDA_BUDGET_MS = Number(process.env.RENTCAST_INTAKE_BUDGET_MS ?? "180000");

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

async function createIntakeListing(
  c: IntakeCandidate,
  promote: boolean,
  firecrawlUrl: string | null,
  portfolioDetected: boolean = false,
  matchedPortfolioKeywords: string[] = [],
  underwrittenMao: number | null = null,
  underwrittenMaoTrack: string | null = null,
  opener: { amount: number | null; basis: string; reseed: boolean } | null = null,
): Promise<string> {
  if (!AIRTABLE_PAT) throw new Error("AIRTABLE_PAT not set");
  const url = `https://api.airtable.com/v0/${BASE_ID}/${LISTINGS_TABLE}`;
  const iso = new Date().toISOString();
  // promote → written H2-ready (Outreach_Status empty + Auto Proceed + Active).
  // !promote → Review queue for operator/Maverick triage (today's behavior).
  // Field assembly extracted to lib/crawler/intake-fields (pure, unit-tested) so
  // the candidate→fields mapping — notably the MLS_Date_Raw write that silently
  // regressed once — can't drop again without a red test.
  const fields = buildIntakeListingFields(c, {
    iso,
    promote,
    firecrawlUrl,
    portfolioDetected,
    matchedPortfolioKeywords,
    underwrittenMao,
    underwrittenMaoTrack,
    opener,
  });
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${AIRTABLE_PAT}`, "Content-Type": "application/json" },
    body: JSON.stringify({ records: [{ fields }], typecast: true }),
  });
  if (!res.ok) throw new Error(`intake create ${res.status}: ${await res.text().catch(() => "")}`);
  const body = (await res.json()) as { records?: Array<{ id: string }> };
  const id = body.records?.[0]?.id;
  if (!id) throw new Error("intake create returned no record id");
  // M7 Part 1 (operator 2026-06-18): the opener-write IS the `priced`
  // checkpoint. A fresh record that passed Firecrawl verify AND received a
  // real opener is born at `priced` (null→priced, legal initial assignment)
  // so it can later flow priced→outreach_ready through Gate 1 once the
  // operator promotes it. No opener (CRAWLER_AUTOSEED_LIVE OFF) → no stage
  // write, exactly as before. Routed through the SOLE WRITER engine (audited).
  // Best-effort: a stage-write hiccup must never fail an already-created
  // record — it simply stays unstaged for the backfill, never silent-forwarded.
  if (opener && typeof opener.amount === "number" && Number.isFinite(opener.amount) && opener.amount > 0) {
    try {
      await transitionToPriced(id, null, `intake_opener_written:${c.sourceId}`);
    } catch {
      // swallowed — the engine audits its own outcome; intake create still succeeds.
    }
  }
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
  // Controlled single-run override (operator 2026-06-22): an AUTHED caller can
  // force ONE live intake pull even with CRAWLER_INTAKE_LIVE off — the 6-hour
  // cron is removed (vercel.json), so this is the on-demand test-pool generator
  // (distress filter is default-ON, so it sources only aged/price-cut leads).
  // An explicit dry_run=1 still wins (fail-safe to dry); creates records, never
  // sends (intake writes Review/empty Outreach_Status; H2 stays hard-disabled).
  const forcedLive = url.searchParams.get("force_live") === "1";
  const dryRun = forcedDry || (!liveEnv && !forcedLive);

  // National-crawler auto-seed + opener-write gate (Maverick 2026-06-14).
  // Default OFF — when unset, every block below guarded by this is skipped,
  // so intake behaves exactly as before. When ON, the loop seeds unseeded
  // live ZIPs from renovated comps (one paid pull/ZIP, budget-clamped) and
  // writes guarded openers off the renovated-comp seed (source-swap away
  // from the contaminated Real_ARV_Median). The seed pull is a paid call, so
  // it is intentionally NOT gated by the intake dry-run flag — the watched
  // run seeds + prices (dry) while sends stay dark via H2_OUTREACH_HARD_DISABLE.
  const autoseedLive = process.env.CRAWLER_AUTOSEED_LIVE === "true";

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
  // Optional per-fire cap override (?cap=N) so a measurement run can pin
  // an exact small slice without touching env.
  const capOverrideRaw = Number(url.searchParams.get("cap"));
  const zipCap = Number.isFinite(capOverrideRaw) && capOverrideRaw > 0
    ? Math.floor(capOverrideRaw)
    : ZIPS_PER_RUN;
  let zips: string[] = overrideZips;
  const zipToRecordId = new Map<string, string>();
  let zipSource: "override" | "registry" = "override";
  // Freshness-cursor selection diagnostic — populated for registry fires.
  let zipDue: ZipDueResult | null = null;
  if (!overrideUsed) {
    zipSource = "registry";
    try {
      const rows = await getActiveIntakeRows();
      for (const r of rows) if (!zipToRecordId.has(r.zip)) zipToRecordId.set(r.zip, r.recordId);

      // FRESHNESS CURSOR (2026-06-08 timeout fix). Pick the `zipCap` stalest
      // DUE ZIPs (null or last-ingested > ZIP_CYCLE_HOURS ago). Many small
      // frequent runs cover the registry; each run is bounded; a ZIP already
      // freshened this cycle is skipped (no re-dig); an errored ZIP stays
      // due for the next run. Replaces the day-index rotation, which picked
      // the SAME slice on every sub-daily run and couldn't advance.
      zipDue = selectDueZips(
        rows.map((r) => ({ zip: r.zip, lastIngestedAt: r.lastIngestedAt })),
        zipCap,
        new Date(),
        ZIP_CYCLE_HOURS,
      );
      zips = zipDue.selected;
    } catch (err) {
      return NextResponse.json(
        { error: "zip_registry_fetch_failed", message: err instanceof Error ? err.message : String(err) },
        { status: 502 },
      );
    }
  }

  if (zips.length === 0) {
    // Disambiguate the two reasons for zero ZIPs:
    //  (a) registry has 0 eligible (launch/active, non-wholesale-restricted)
    //      → REAL misconfiguration; operator action required.
    //  (b) freshness cursor has 0 DUE this cycle (every ZIP was freshened
    //      within ZIP_CYCLE_HOURS) → STEADY-STATE SUCCESS; do nothing.
    // The 2026-06-08 confusion: case (b) was returning the same
    // `blocked: no_target_zips` label as case (a), making a healthy no-op
    // look like a regression. Now they're distinct outcomes with distinct
    // audit + response shapes.
    const allFresh = zipSource === "registry" && zipDue != null && zipDue.dueTotal === 0 && zipDue.freshTotal > 0;
    const outcome = allFresh ? "all_fresh_no_due" : "no_target_zips";
    const auditStatus = allFresh ? "confirmed_success" : "uncertain";
    const detail = allFresh
      ? `All ${zipDue?.freshTotal ?? 0} eligible ZIPs were freshened within the last ${ZIP_CYCLE_HOURS}h. No work this run; the next ZIP becomes due ${ZIP_CYCLE_HOURS}h after its last ingest. This is the steady state, not a blocker.`
      : "No launch/active, non-wholesale-restricted ZIPs in ZIP_Registry. Add/activate ZIPs there, or pass ?zips=78201 for a manual run.";
    await audit({
      agent: "scout",
      event: "listings_intake_no_zips",
      status: auditStatus,
      inputSummary: { auth_kind: authKind, dry_run: dryRun, zip_source: zipSource, outcome },
      outputSummary: {
        outcome,
        blocker: allFresh ? null : "no active ZIPs in ZIP_Registry",
        fresh_total: zipDue?.freshTotal ?? null,
        due_total: zipDue?.dueTotal ?? null,
        cycle_hours: zipDue?.cycleHours ?? null,
        duration_ms: Date.now() - t0,
      },
    });
    return NextResponse.json({
      ok: true,
      outcome,
      // Keep `blocked` populated only for the REAL blocker case so
      // existing operators / dashboards reading that key see "blocked" only
      // when action is actually needed.
      blocked: allFresh ? null : "no_target_zips",
      detail,
      zip_source: zipSource,
      zip_due: zipDue
        ? {
            selected: [],
            due_total: zipDue.dueTotal,
            fresh_total: zipDue.freshTotal,
            cap: zipDue.cap,
            cycle_hours: zipDue.cycleHours,
            runs_to_clear_backlog: zipDue.runsToClearBacklog,
          }
        : null,
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
    would_write: [] as Array<{ sourceId: string; address: string | null; zip: string | null; listPrice: number | null; firecrawlUrl: string | null; outreachStatus: "" | "Review"; promote: boolean; agentPhonePresent: boolean; portfolioDetected: boolean }>,
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
      // 402 wallet-empty signal (operator 2026-06-08). When true, the run
      // did zero useful verify work — the CRITICAL Pulse alert fires and
      // the affected ZIPs stay DUE (not stamped fresh).
      payment_required: false,
      payment_required_count: 0,
      // Real Firecrawl account balance probed once per run (null when the
      // balance endpoint is unavailable). The internal credits_used counter
      // can read 0 while the account is actually drained — this is the
      // ground-truth balance.
      balance_remaining: null as number | null,
      // Spend circuit-breaker (operator 2026-06-09): rolling-hour spend vs the
      // hard cap. breaker_tripped=true means the verify phase was halted.
      hourly_cap: 0,
      spent_recent_hour: 0,
      breaker_tripped: false,
      // Verify phase skipped because the real wallet balance was ≤0 (probed
      // before dispatch). Stops the failed-verify retry-loop burn at any cadence.
      balance_halted: false,
    },
    // Priceable-gate provenance (operator 2026-06-10): which seeded-ZIP
    // allowlist the run used + where it came from. fallback = the store
    // read failed and intake narrowed to FALLBACK_SEEDED_ZIPS.
    seeded_zips_source: "store" as "store" | "fallback",
    seeded_zips_count: 0,
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
  // First fetched candidate per ZIP — the representative subject the auto-
  // seed pulls renovated comps against (comps are address-based).
  const perZipRepresentative = new Map<string, IntakeCandidate>();
  const perZipAccepted = new Map<string, number>();
  const perZipReview = new Map<string, number>();
  // D1 stats accumulators (per-ZIP) for the ZIP_Registry write-back.
  const perZipConsidered = new Map<string, number>(); // classified (accept+review+reject)
  const perZipIngested = new Map<string, number>(); // written (accept+review)
  const perZipDom = new Map<string, { sum: number; n: number }>();
  const perZipPrice = new Map<string, { sum: number; n: number }>();
  const zipsProcessedOk = new Set<string>(); // RentCast fetch succeeded (incl. 0 candidates)
  // ZIPs whose verify phase was BLOCKED by an infra failure (Firecrawl
  // 402/429/error) or left candidates unverified (scrape/time budget). These
  // did NO real ingest work, so they are NOT stamped fresh — they stay DUE
  // so the freshness cursor retries them next run (operator bug 2026-06-08:
  // a fully-402'd ZIP was being marked fresh, idling the cron for 24h on a
  // full wallet). A ZIP with zero candidates is NOT blocked — it legitimately
  // scanned empty and is done.
  const zipVerifyBlocked = new Set<string>();
  const seenKeys = new Set<string>(); // intra-run dedup across overlapping ZIPs
  const toVerify: Array<{ candidate: IntakeCandidate; zip: string }> = [];

  // ── Priceable-market gate (operator 2026-06-09) ───────────────────
  // Intake only verifies markets we can actually price: a sourced
  // arv_pct_max + a seeded ZIP buyer-median. Don't spend Firecrawl on a
  // market we can't make an MAO-checked offer in (e.g. TX SA/Dallas/Houston,
  // or any not-yet-seeded ZIP). Reversible via INTAKE_REQUIRE_PRICEABLE.
  //
  // FAIL-NARROW (operator 2026-06-10): if the seeded-ZIP store read fails
  // (e.g. AIRTABLE_PAT scoped before Buyer_Median_ZIP existed), fall back to
  // the hardcoded FALLBACK_SEEDED_ZIPS allowlist — NEVER disable the gate.
  // Disabling widens scope to every priceable market in the registry; that's
  // the wrong direction. The fallback always narrows (or stays the same).
  // Fires a Pulse alert so the operator sees the PAT-scope drift.
  const requirePriceable = process.env.INTAKE_REQUIRE_PRICEABLE !== "false";
  let seededZips: ReadonlySet<string> = new Set<string>();
  let seededZipsSource: "store" | "fallback" = "store";
  if (requirePriceable) {
    try {
      seededZips = await listSeededZips();
    } catch (e) {
      seededZips = FALLBACK_SEEDED_ZIPS;
      seededZipsSource = "fallback";
      summary.per_zip_errors.push({ zip: "*", error: `seeded_zip_store_unavailable_falling_back_to_allowlist: ${e instanceof Error ? e.message : String(e)} (fallback=${[...FALLBACK_SEEDED_ZIPS].join(",")})` });
      try {
        await writeState({
          event_type: "decision",
          attribution_agent: "scout",
          title: `⚠️ Buyer_Median_ZIP store unavailable — intake fell back to allowlist [${[...FALLBACK_SEEDED_ZIPS].join(", ")}]`,
          description:
            `listings-intake could not read Buyer_Median_ZIP (tbleoqYRBmnJq5V0Z). Likely cause: AIRTABLE_PAT scope excludes the table. ` +
            `Intake remains priceable-gated against the hardcoded fallback allowlist (${[...FALLBACK_SEEDED_ZIPS].join(",")}); ` +
            `no widening to all markets. Extend the PAT to include Buyer_Median_ZIP to restore the live store read. Error: ${e instanceof Error ? e.message : String(e)}`,
        });
      } catch (err) {
        console.error("[listings-intake] fail-narrow Spine write failed:", err);
      }
    }
  }
  // Echoed in the response so dry-runs surface which path was taken.
  summary.seeded_zips_source = seededZipsSource;
  summary.seeded_zips_count = seededZips.size;

  // ── Phase 1 timing: RentCast collect (per-ZIP wall-time instrumentation) ──
  const tCollectStart = Date.now();
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
      if (autoseedLive && fetchResult.candidates.length > 0 && !perZipRepresentative.has(zip)) {
        perZipRepresentative.set(zip, fetchResult.candidates[0]);
      }

      const { accepted, rejected } = filterIntakeCandidates(fetchResult.candidates, now, { seededZips, requirePriceable });
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

  const collectMs = Date.now() - tCollectStart;

  // ── AUTO-SEED PASS (Maverick 2026-06-14, root-cause fix) ───────────────
  // The contaminated Real_ARV_Median field is repaired at the ZIP level: for
  // each live ZIP with no ZIP_ARV_Seed yet, pull renovated comps once (one
  // paid call, self-audited), derive the renovated $/sqft, and cache it.
  // Budget-clamped (DAILY_INTAKE_BUDGET_USD): at the cap, NEW seeds pause
  // while already-seeded ZIPs keep pricing free. Restricted states are never
  // seeded (load-frozen in the market registry). Entirely gated by
  // CRAWLER_AUTOSEED_LIVE — when off, this whole block is skipped.
  const zipSeedMap = new Map<string, ZipArvSeed | null>();
  const autoSeed = {
    live: autoseedLive,
    attempted: 0,
    seeded: 0,
    dont_priced: 0,
    comp_pulls: 0,
    reseed: false,
    seed_only: false,
    skipped: {} as Record<string, number>,
    errors: [] as string[],
    budget: null as null | { spentUsd: number; budgetUsd: number; seedsRemaining: number },
  };
  // ?reseed=1 (manual-override runs only) re-pulls + overwrites the seed for
  // the explicitly listed ZIPs, bypassing the already-seeded skip — used to
  // re-seed after a gate/widen change. Ignored on registry-driven fires.
  const reseed = url.searchParams.get("reseed") === "1" && overrideUsed;
  autoSeed.reseed = reseed;
  // ?seed_only=1 (manual-override runs only): do the auto-seed pass, then STOP
  // before the Firecrawl listing-verification phase. Seeding never uses verify,
  // so a re-seed should cost comp pulls only (~$0.20/ZIP), not ~168 Firecrawl
  // credits/run. Keeps the watched re-seed loop cheap + off the Firecrawl wallet.
  const seedOnly = url.searchParams.get("seed_only") === "1" && overrideUsed;
  autoSeed.seed_only = seedOnly;
  if (autoseedLive) {
    let arvSeeded: Set<string>;
    try {
      arvSeeded = await listArvSeededZips();
    } catch {
      arvSeeded = new Set<string>();
    }
    let budget = await resolveSeedBudget();
    autoSeed.budget = { spentUsd: budget.spentUsd, budgetUsd: budget.budgetUsd, seedsRemaining: budget.seedsRemaining };
    for (const zip of zipsProcessedOk) {
      const rep = perZipRepresentative.get(zip);
      const decision = decideAutoSeed({
        zip,
        state: rep?.state ?? null,
        alreadySeeded: arvSeeded.has(zip) && !reseed,
        canSeed: budget.canSeed,
        hasRepresentativeSubject: !!(rep && rep.address),
      });
      if (!decision.seed) {
        autoSeed.skipped[decision.reason] = (autoSeed.skipped[decision.reason] ?? 0) + 1;
        continue;
      }
      autoSeed.attempted++;
      autoSeed.comp_pulls++;
      const res = await runAutoSeed({
        address: rep!.address!,
        city: rep!.city ?? "",
        state: rep!.state ?? "",
        zip,
        bedrooms: rep!.beds ?? null,
        bathrooms: rep!.bathrooms ?? null,
        squareFootage: rep!.squareFootage ?? null,
      });
      if (res.seeded) {
        autoSeed.seeded++;
        arvSeeded.add(zip);
        budget = await resolveSeedBudget(); // re-read the meter after the spend
      } else if (res.dontPrice) {
        // Gate failed: a sentinel was cached (the ZIP still spent its pull and
        // is now "covered" — it prices off 65%-of-list and won't re-pull).
        autoSeed.dont_priced++;
        arvSeeded.add(zip);
        budget = await resolveSeedBudget();
      } else {
        autoSeed.errors.push(`${zip}: ${res.reason}`);
      }
    }
    // Load the (now-current) seeds for every processed ZIP so opener-write
    // prices off the renovated-comp ARV.
    for (const zip of zipsProcessedOk) {
      if (!zipSeedMap.has(zip)) {
        zipSeedMap.set(zip, await getZipArvSeed(zip).catch(() => null));
      }
    }
  }

  // ── seed_only short-circuit: the auto-seed pass is done; skip the entire
  // Firecrawl verify/classify/write phase (it is irrelevant to seeding and is
  // what drains the Firecrawl wallet). Manual-override runs only. ──
  if (seedOnly) {
    await audit({
      agent: "scout",
      event: "listings_intake_seed_only",
      status: "confirmed_success",
      inputSummary: { auth_kind: authKind, zips, reseed },
      outputSummary: { auto_seed: autoSeed, raw_candidates: summary.raw_candidates, duration_ms: Date.now() - t0 },
    });
    return NextResponse.json({
      ok: true,
      mode: "seed_only",
      note: "Auto-seed pass only — Firecrawl verify/classify/write skipped (zero Firecrawl spend). Use without seed_only for a full intake.",
      auth_kind: authKind,
      zip_source: zipSource,
      zips_scanned: zips.length,
      zips_fetched_ok: zipsProcessedOk.size,
      raw_candidates: summary.raw_candidates,
      auto_seed: autoSeed,
      seeded_zips_source: summary.seeded_zips_source,
      per_zip_errors: summary.per_zip_errors,
      duration_ms: Date.now() - t0,
    });
  }

  // ── Guard (3): drop candidates already verified THIS cycle (KV cache)
  // BEFORE any paid Firecrawl call. Catches partial-ZIP-retry re-searches
  // of prior rejects + cross-ZIP-boundary dups. KV-down → empty set →
  // verifies everything (today's behavior). ──
  let verifyCacheSkipped = 0;
  if (!overrideUsed) {
    const cachedNorm = await getVerifiedThisCycle(toVerify.map((it) => it.candidate.address));
    if (cachedNorm.size > 0) {
      const before = toVerify.length;
      const kept = toVerify.filter((it) => !cachedNorm.has(normalizeAddressKey(it.candidate.address)));
      verifyCacheSkipped = before - kept.length;
      toVerify.length = 0;
      toVerify.push(...kept);
      if (verifyCacheSkipped > 0) bump("verify_cache_hit", verifyCacheSkipped);
    }
  }

  // ── Budget split: dispatch up to the per-run Firecrawl scrape budget. ──
  const tVerifyStart = Date.now();
  const dispatchable = toVerify.slice(0, FIRECRAWL_MAX_SCRAPES_PER_RUN);
  const budgetSkipped = toVerify.slice(FIRECRAWL_MAX_SCRAPES_PER_RUN);
  if (budgetSkipped.length > 0) {
    summary.firecrawl.budget_hit = true;
    bump("firecrawl_skipped_budget", budgetSkipped.length);
    // Candidates we never even dispatched → their ZIPs aren't complete.
    for (const it of budgetSkipped) zipVerifyBlocked.add(it.zip);
  }

  // ── SPEND CIRCUIT-BREAKER (permanent, operator 2026-06-09) ──────────
  // No background process touches Firecrawl without a brake. If we've already
  // spent the hourly cap (across ticks), HALT the verify phase entirely —
  // alert + audit, zero spend — so a repeating per-tick loop can't bleed the
  // balance. The in-run cap below stops a single run mid-flight too.
  const breaker = await checkFirecrawlBreaker();
  summary.firecrawl.hourly_cap = breaker.cap;
  summary.firecrawl.spent_recent_hour = breaker.spentRecent;
  summary.firecrawl.breaker_tripped = false;

  // ── BALANCE GATE (structural fix, 2026-06-15) ── probe the REAL wallet
  // BEFORE dispatching. A drained balance (≤0) means every verify will
  // 402/error, and a failed verify leaves its ZIP "due" → re-scraped next tick
  // → loop-burn. So skip the verify phase entirely when the wallet is empty
  // (just like a tripped spend breaker): the ZIPs stay DUE and retry once the
  // wallet is funded — no attempt-and-fail burn at ANY cron cadence. Probe
  // only when there is work to dispatch (no balance call on no-op ticks).
  let preBalance: number | null = null;
  if (dispatchable.length > 0) {
    try {
      preBalance = (await probeFirecrawlBalance()).remaining;
    } catch {
      preBalance = null; // probe failed → don't block on an unknown balance
    }
    summary.firecrawl.balance_remaining = preBalance;
  }
  // Either a tripped spend breaker OR a drained wallet halts the verify phase
  // (no dispatch, zero spend) — pure decision, unit-tested.
  const haltVerdict = shouldHaltVerify({ breakerTripped: breaker.tripped, balanceRemaining: preBalance });
  const balanceUnhealthy = haltVerdict.balanceUnhealthy;
  const verifyHalted = haltVerdict.halt;

  if (verifyHalted && dispatchable.length > 0) {
    summary.firecrawl.breaker_tripped = breaker.tripped;
    summary.firecrawl.balance_halted = balanceUnhealthy;
    for (const it of toVerify) zipVerifyBlocked.add(it.zip); // not done → cursor retries next window
    const haltReason = balanceUnhealthy ? "balance_nonpositive" : "spend_cap";
    bump(balanceUnhealthy ? "firecrawl_balance_halted" : "firecrawl_breaker_halted", dispatchable.length);
    await audit({
      agent: "scout",
      event: "firecrawl_verify_halted",
      status: "confirmed_failure",
      inputSummary: { reason: haltReason, balance_remaining: preBalance, spent_recent_hour: breaker.spentRecent, hourly_cap: breaker.cap, would_dispatch: dispatchable.length },
      outputSummary: { halted: true },
      decision: `verify_phase_halted_on_${haltReason}`,
    });
    try {
      await writeState({
        event_type: "decision",
        attribution_agent: "scout",
        title: balanceUnhealthy
          ? `🛑 Firecrawl wallet EMPTY (balance ${preBalance}) — intake verify HALTED before dispatch`
          : `🛑 Firecrawl spend circuit-breaker TRIPPED — intake verify HALTED (${breaker.spentRecent}/${breaker.cap} credits/hr)`,
        description: balanceUnhealthy
          ? `listings-intake skipped the Firecrawl verify phase: real balance ${preBalance} ≤ 0. ` +
            `${dispatchable.length} candidate(s) left unverified; their ZIPs stay DUE and retry once the wallet is funded. ` +
            `Zero Firecrawl spend this run — this is the structural guard against the failed-verify retry-loop burn. Top up Firecrawl to resume verification.`
          : `listings-intake halted the Firecrawl verify phase: ~${breaker.spentRecent} credits spent in the last hour ≥ cap ${breaker.cap}. ` +
            `${dispatchable.length} candidate(s) left unverified; their ZIPs stay DUE for the next window. ` +
            `Investigate the burn before raising FIRECRAWL_HOURLY_CREDIT_CAP. No further Firecrawl spend this run.`,
      });
    } catch (err) {
      console.error("[listings-intake] verify-halt Spine write failed:", err);
    }
  }

  // ── Phase 2: parallel Firecrawl verification — bounded concurrency +
  // global rate gate + wall-clock guard + spend cap. In-flight calls finish
  // on stop; undispatched land in pool.skipped.
  const rateGate = makeRateGate(FIRECRAWL_RATE_LIMIT_PER_MINUTE);
  let creditsThisRun = 0; // exact in-run tally for the spend cap
  const pool = verifyHalted
    ? { results: [] as Array<{ item: { candidate: IntakeCandidate; zip: string }; value: Awaited<ReturnType<typeof verifyListing>> }>, skipped: [] as Array<{ candidate: IntakeCandidate; zip: string }> }
    : await runAsyncPool({
        items: dispatchable,
        concurrency: FIRECRAWL_MAX_CONCURRENT,
        beforeDispatch: rateGate,
        // Stop on the wall-clock budget OR once this hour's spend would cross
        // the cap (prior-hour spend + what we've already spent this run).
        shouldStopDispatch: () =>
          Date.now() - t0 > LAMBDA_BUDGET_MS ||
          breaker.spentRecent + creditsThisRun >= breaker.cap,
        worker: async (it) => {
          const fc = await verifyListing(it.candidate.address, { debug });
          creditsThisRun += fc.creditsUsed;
          return fc;
        },
      });
  // Persist this run's spend into the rolling-hour bucket for the next tick.
  await recordFirecrawlSpend(creditsThisRun);
  if (!verifyHalted && breaker.spentRecent + creditsThisRun >= breaker.cap && pool.skipped.length > 0) {
    summary.firecrawl.breaker_tripped = true; // tripped mid-run
    for (const it of pool.skipped) zipVerifyBlocked.add(it.zip);
  }
  const verifyMs = Date.now() - tVerifyStart;
  const timeBudgetHit = pool.skipped.length > 0;
  if (timeBudgetHit) {
    bump("firecrawl_skipped_time", pool.skipped.length);
    // Candidates dropped on the wall-clock budget → their ZIPs aren't done.
    for (const it of pool.skipped) zipVerifyBlocked.add(it.zip);
  }

  // Real account balance — re-probe after we ACTUALLY ran verify (refreshes
  // the pre-dispatch reading with the post-spend balance). Skipped when the
  // verify phase was halted — preBalance already holds the ground truth and a
  // second probe would be wasted. Ground truth vs the internal credits counter.
  if (!verifyHalted && dispatchable.length > 0) {
    try {
      const bal = await probeFirecrawlBalance();
      summary.firecrawl.balance_remaining = bal.remaining;
    } catch {
      /* best-effort; balance stays at the pre-dispatch reading */
    }
  }
  // Surface spend + balance + breaker every run so the burn is observable in
  // runtime logs (the incident drained silently — never again).
  console.log(
    `[listings-intake][firecrawl] balance=${summary.firecrawl.balance_remaining ?? "?"} ` +
    `credits_this_run=${creditsThisRun} spent_recent_hour=${summary.firecrawl.spent_recent_hour} ` +
    `cap=${summary.firecrawl.hourly_cap} breaker_tripped=${summary.firecrawl.breaker_tripped} ` +
    `balance_halted=${summary.firecrawl.balance_halted} dispatched=${verifyHalted ? 0 : dispatchable.length}`,
  );

  // ── Phase 3: classify completed results (sequential — accurate count
  // aggregation regardless of non-deterministic completion order). ──
  const tClassifyStart = Date.now();
  const toWrite: Array<{
    candidate: IntakeCandidate;
    zip: string;
    promote: boolean;
    firecrawlUrl: string | null;
    portfolioDetected: boolean;
    matchedPortfolioKeywords: string[];
    underwrittenMao: number | null;
    underwrittenMaoTrack: BuyerTrack | null;
  }> = [];
  const bumpBlocked = (reason: AutoPromoteBlockReason | "auto_promote_disabled" | "auto_promote_dry_run") => {
    summary.auto_promote.reasons_blocked[reason] = (summary.auto_promote.reasons_blocked[reason] ?? 0) + 1;
  };

  // ZIP-store median pre-load REMOVED (keystone 2026-06-12): intake no
  // longer computes a median-based Underwritten_MAO (see the stripped
  // writer block below). The median's surviving intake role is the
  // priceable-market gate, which reads seededZips directly.
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
          portfolio: fc.matchedPortfolioKeywords,
        },
        portfolioSellerDetected: fc.portfolioSellerDetected,
        contexts: fc.debugContexts ?? [],
        page_excerpt: fc.pageExcerpt ?? null,
      });
    }
    if (decision.outcome === "reject") {
      bump(decision.reason);
      // Surface infra-class failures into per_zip_errors for triage.
      if (decision.reason === "firecrawl_not_configured") summary.firecrawl.credentialed = false;
      if (decision.reason === "firecrawl_payment_required" || fc.paymentRequired) {
        summary.firecrawl.payment_required = true;
        summary.firecrawl.payment_required_count++;
      }
      // INFRA-class reject (402/429/error/not-configured): the verify could
      // NOT determine the listing's status, so this ZIP did not complete its
      // work. Mark it blocked → it stays DUE for retry. (A normal
      // firecrawl_url_unresolved / firecrawl_inactive IS a real terminal
      // outcome and does NOT block.)
      if (
        decision.reason === "firecrawl_not_configured" ||
        decision.reason === "firecrawl_payment_required" ||
        decision.reason === "firecrawl_rate_limited" ||
        decision.reason === "firecrawl_error"
      ) {
        zipVerifyBlocked.add(zip);
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

    // ── Underwritten_MAO writer STRIPPED (keystone rewrite 2026-06-12,
    // adjudication recXJrM7EYK3pEFmF item 8 / Q3 site #3) ──
    // This block used to compute a median-based Underwritten_MAO at intake
    // time and persist it — which made a ZIP average the send-authorizing
    // ceiling for a specific property. A ZIP average prices no single
    // house. The property-up pipeline (ARV − matched buyer margin − rehab
    // − fee) is the only writer of the new Underwritten_Property_MAO, and
    // it runs downstream after Appraiser ARV + buyer match land — intake
    // persists NOTHING into either ceiling field. Median's surviving
    // intake role is the priceable-market gate, which already ran above.
    const underwrittenMao: number | null = null;
    const underwrittenMaoTrack: BuyerTrack | null = null;

    // Intrinsic auto-promote eligibility, then layer the feature flags.
    const ap = shouldAutoPromote({ accepted, agentPhone: c.agentPhone, state: c.state, listPrice: c.listPrice, underwrittenMao });
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
        portfolioDetected: fc.portfolioSellerDetected,
      });
    } else {
      toWrite.push({
        candidate: c, zip, promote, firecrawlUrl: fc.url,
        portfolioDetected: fc.portfolioSellerDetected,
        matchedPortfolioKeywords: fc.matchedPortfolioKeywords,
        underwrittenMao,
        underwrittenMaoTrack,
      });
    }
  }

  // ── Guard (3) write-side: mark every candidate that reached a REAL
  // verify verdict this cycle (resolved page → accept/review/legit-reject),
  // so it isn't re-searched on a partial-ZIP retry. EXCLUDE infra failures
  // (402/429/error/unresolved) — those didn't actually verify and must stay
  // re-checkable. ──
  if (!overrideUsed && !dryRun) {
    const verifiedAddrs = pool.results
      .filter(({ value: fc }) => fc.resolved && !fc.paymentRequired && !fc.rateLimited && !fc.error)
      .map(({ item }) => item.candidate.address);
    if (verifiedAddrs.length > 0) {
      try {
        await markVerifiedThisCycle(verifiedAddrs, ZIP_CYCLE_HOURS);
      } catch (err) {
        console.error("[listings-intake] verify-cache mark failed:", err);
      }
    }
  }

  // ── Phase 4: writes (live only; sequential, post-pool — no concurrent
  // Airtable writes / intra-run dup races). ──
  const anchorCacheIntake = new Map<string, number>();
  if (!dryRun) {
    for (const { candidate: c, zip, promote, firecrawlUrl, portfolioDetected, matchedPortfolioKeywords, underwrittenMao, underwrittenMaoTrack } of toWrite) {
      try {
        // Opener-write (gated): price the new record off the renovated-comp
        // ZIP seed (source-swap). New intake records carry no stored ARV, so
        // the seed — or the flat 65% fallback — is the only basis.
        let opener: { amount: number | null; basis: string; reseed: boolean } | null = null;
        if (autoseedLive) {
          const market = getMarketForListing({ state: c.state, zip: c.zip });
          const marketId = market?.id ?? "";
          let anchorPct = anchorCacheIntake.get(marketId);
          if (anchorPct == null) {
            anchorPct = await resolveAnchorPct(marketId || null);
            anchorCacheIntake.set(marketId, anchorPct);
          }
          const priced = priceOpenerWithSeed({
            listPrice: c.listPrice ?? null,
            storedArv: null,
            estRehabMid: null,
            sqft: c.squareFootage ?? null,
            arvPctMax: market?.buyer_params?.arv_pct_max ?? null,
            anchorPct,
            seed: zipSeedMap.get(zip) ?? null,
          });
          opener = { amount: priced.result.opener, basis: priced.basisLabel, reseed: priced.result.flagReseed };
        }
        await createIntakeListing(c, promote, firecrawlUrl, portfolioDetected, matchedPortfolioKeywords, underwrittenMao, underwrittenMaoTrack, opener);
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
  const registryWriteback = { written: 0, skipped: false as boolean | string, skipped_blocked: 0, errors: [] as string[] };
  if (overrideUsed) {
    registryWriteback.skipped = "manual_override";
  } else if (dryRun) {
    registryWriteback.skipped = "dry_run";
  } else {
    const nowIso = new Date().toISOString();
    for (const zip of zipsProcessedOk) {
      const recordId = zipToRecordId.get(zip);
      if (!recordId) continue;
      // CRITICAL (operator 2026-06-08): do NOT stamp Last_Ingested_At for a
      // ZIP whose verify phase was blocked (402/429/error or budget/time
      // skip). Stamping it would mark it "fresh" → the freshness cursor
      // skips it for ZIP_CYCLE_HOURS → the cron idles for 24h even with a
      // refilled wallet. Leaving it un-stamped keeps it DUE for the next run.
      if (zipVerifyBlocked.has(zip)) {
        registryWriteback.skipped_blocked = (typeof registryWriteback.skipped_blocked === "number" ? registryWriteback.skipped_blocked : 0) + 1;
        continue;
      }
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

  // ── Firecrawl 402 wallet-empty → CRITICAL Spine write (operator
  // 2026-06-08). A drained wallet must SCREAM, not silently no-op. The
  // affected ZIPs were already kept DUE above (zipVerifyBlocked); this is
  // the loud, durable signal the Pulse firecrawl_payment_required detector
  // also fires on.
  if (summary.firecrawl.payment_required) {
    try {
      await writeState({
        event_type: "decision",
        attribution_agent: "scout",
        title: "Firecrawl WALLET EMPTY (402) — intake verify is blocked",
        description:
          `listings-intake hit Firecrawl 402 Payment Required ${summary.firecrawl.payment_required_count}× this run. ` +
          `Every verify is failing for lack of credits; ${zipVerifyBlocked.size} ZIP(s) did ZERO ingest work and ` +
          `were intentionally left DUE (NOT stamped fresh) so the cron retries them the moment credits refill — ` +
          `it will NOT idle for 24h. Real account balance probe: ` +
          `${summary.firecrawl.balance_remaining == null ? "unavailable" : summary.firecrawl.balance_remaining + " credits remaining"}. ` +
          `ACTION: refill the Firecrawl wallet. accepted_this_run=${summary.accepted}.`,
      });
    } catch (err) {
      console.error("[listings-intake] Spine write (402 wallet) failed:", err);
    }
  }

  // ── Run-duration telemetry (2026-06-08). Per-ZIP wall-time = total /
  // ZIPs processed; phase split shows WHERE time goes (RentCast collect vs
  // Firecrawl verify vs classify+write). This is the measurement that
  // sizes ZIPS_PER_RUN: set ≈ floor(LAMBDA_BUDGET_MS / per_zip_avg_ms).
  const classifyMs = Date.now() - tClassifyStart;
  const totalMs = Date.now() - t0;
  const zipsProcessed = zipsProcessedOk.size;
  const timing = {
    total_ms: totalMs,
    collect_ms: collectMs,
    verify_ms: verifyMs,
    classify_write_ms: classifyMs,
    zips_processed: zipsProcessed,
    per_zip_avg_ms: zipsProcessed > 0 ? Math.round(totalMs / zipsProcessed) : null,
    lambda_budget_ms: LAMBDA_BUDGET_MS,
    max_duration_ms: 300_000,
    budget_margin_pct: Math.round((1 - LAMBDA_BUDGET_MS / 300_000) * 100),
    // True when the run consumed >80% of the lambda ceiling — the
    // duration-creep tripwire the Pulse detector also watches.
    near_timeout: totalMs > 0.8 * 300_000,
  };

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
          `listings-intake stopped mid-run within its self-limiting budget. cause=${cause}. ` +
          `firecrawl scrapes_used=${summary.firecrawl.scrapes_used} (budget ${FIRECRAWL_MAX_SCRAPES_PER_RUN}), ` +
          `credits_used=${summary.firecrawl.credits_used}, accepted=${summary.accepted}, ` +
          `zips_processed=${zipsProcessed}, per_zip_avg_ms=${timing.per_zip_avg_ms}. ` +
          `This is EXPECTED, not an error: the wall-clock budget (${LAMBDA_BUDGET_MS}ms, ${timing.budget_margin_pct}% margin under 300s) ` +
          `stopped dispatch so the run finished cleanly instead of timing out. The un-processed ZIPs stay DUE ` +
          `(freshness cursor) and are picked up by the next frequent run. If per_zip_avg_ms is rising toward the ` +
          `budget, lower RENTCAST_INTAKE_ZIPS_PER_RUN (currently ${zipCap}).`,
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
      // 402 + real balance → read by the Pulse firecrawl_payment_required
      // detector for the CRITICAL alert.
      firecrawl_payment_required: summary.firecrawl.payment_required,
      firecrawl_payment_required_count: summary.firecrawl.payment_required_count,
      firecrawl_balance_remaining: summary.firecrawl.balance_remaining,
      zips_kept_due_blocked: registryWriteback.skipped_blocked,
      // Guard (3): candidates skipped because already verified this cycle.
      verify_cache_skipped: verifyCacheSkipped,
      per_zip: summary.per_zip,
      auto_promote: summary.auto_promote,
      // Run-duration telemetry → consumed by the Pulse
      // intake_run_duration detector (creep alarm before timeout).
      timing,
    },
    ms: Date.now() - t0,
  });

  return NextResponse.json({
    ok: true,
    auth_kind: authKind,
    duration_ms: Date.now() - t0,
    timing,
    verify_cache_skipped: verifyCacheSkipped,
    zip_source: zipSource,
    zip_due: zipDue
      ? {
          selected: zipDue.selected,
          due_total: zipDue.dueTotal,
          fresh_total: zipDue.freshTotal,
          cap: zipDue.cap,
          cycle_hours: zipDue.cycleHours,
          runs_to_clear_backlog: zipDue.runsToClearBacklog,
        }
      : null,
    registry: registryWriteback,
    auto_seed: autoSeed,
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
