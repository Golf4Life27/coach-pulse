// H2 first-touch outreach loop — Vercel migration of Make scenario
// `H2. Quo_Outreach_V1` (id 4724197). @agent: crier
//
// GET|POST /api/cron/h2-outreach
//   ?dry_run=false   — actually send (default TRUE: identify + report only)
//   ?limit=N         — cap records processed this run (default 50, max 200)
//   ?record_id=rec…  — process ONLY this record (smoke test); bypasses the
//                      eligibility filter but still checks eligibility inline
//   ?send_delay_ms=N — inter-send throttle override (default 60000)
//
// SAFETY — three independent brakes, all must clear before an SMS fires:
//   1. dry_run defaults TRUE. A send needs an explicit ?dry_run=false.
//   2. H2_OUTREACH_LIVE env must equal "true". Even ?dry_run=false is
//      forced back to dry mode when the env switch is off — the master
//      kill switch the operator flips only after the smoke test passes.
//   3. The eligibility filter + Outreach_Status idempotency: a record that
//      was already texted is excluded, so re-runs don't re-text.
//
// Routing logic lives in lib/h2-outreach.ts (pure, fully unit-tested). This
// route only does I/O: auth → read listings → plan → (live) send + write.
//
// DEVIATIONS from the INV-H2-VERCEL spec (all deliberate):
//   - Prior-contact match is NORMALIZED phone, not raw string — see
//     lib/h2-outreach.ts header. Raw match is Make's known undercount bug.
//   - Reuses the existing QUO_PHONE_ID env (lib/quo.ts), not the spec's new
//     QUO_PHONE_NUMBER_ID — same value (PNLosBI6fh), one source of truth.
//   - Daily vercel.json cron (15:30 UTC = 10:30am Central, inside TX working
//     hours) at limit=25 / send_delay_ms=10000 — the once-per-day Hobby cap.
//     Live sends still gated by H2_OUTREACH_LIVE; the cron no-ops until set.
//   - Idempotency: a KV run-mutex (no two overlapping runs) + a per-record KV
//     claim acquired BEFORE Quo dispatch close the cross-invocation race that
//     double-fired a batch on 2026-05-27 (Spine recWwIMc7V15p968k). The
//     Airtable Outreach_Status gate alone was insufficient — it has write-
//     propagation lag; KV is strongly-consistent.
//   - Existing app/api/outreach-fire fires the same selector manually; both
//     gate on empty Outreach_Status so no record double-texts, but they are
//     two senders. Consolidation flagged for the operator.

import { NextResponse } from "next/server";
import { getListings, getListing, updateListingRecord } from "@/lib/airtable";
import { sendMessageWithId, getMessageStatus } from "@/lib/quo";
import { audit } from "@/lib/audit-log";
import { checkFirstOutreachHydration, checkOfferOverList } from "@/lib/outreach-economics";
import { priceOpenerWithSeed } from "@/lib/opener-pricing";
import { getZipArvSeed, type ZipArvSeed } from "@/lib/zip-arv-seed-store";
import { minOfferFloor } from "@/lib/per-market-pricer";
import { getMarketForListing, openerArvPctMax } from "@/lib/markets/registry";
import { resolveAnchorPct } from "@/lib/markets/anchor";
import { readSendCapConfig, resolveCoverage, applySendCap } from "@/lib/outreach/send-cap";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import type { Listing } from "@/lib/types";
import {
  isH2Eligible,
  selectOutreachReady,
  outreachReadyReason,
  buildPriorContactIndex,
  planQueue,
  buildSentNote,
  buildStallNote,
  buildQuarantineNote,
  buildDeliveryQuarantineNote,
  type H2Plan,
} from "@/lib/h2-outreach";
import {
  evaluateSendWindow,
  type WorkingHoursMeta,
} from "@/lib/h2-working-hours";
import { SOURCE_VERSION_V2 } from "@/lib/source-version";
import { listSeededZips, FALLBACK_SEEDED_ZIPS } from "@/lib/buyer-median-store";
import {
  evaluateSupplyFloor,
  emitSupplyFloorAudit,
  type SupplyFloorVerdict,
} from "@/lib/h2-outreach/supply-floor";

export const runtime = "nodejs";
export const maxDuration = 300;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_SEND_DELAY_MS = 60_000;
// Stop starting NEW work this late into the 300s lambda so in-flight writes
// finish cleanly instead of being killed. Remaining records roll to next run.
const WALL_CLOCK_BUDGET_MS = 270_000;

// Idempotency locks (KV — strongly-consistent, unlike the Airtable status gate
// which has write-propagation lag). See Spine recWwIMc7V15p968k.
const RUN_LOCK_KEY = "h2:run:lock";
const RUN_LOCK_TTL_S = 300; // == maxDuration ceiling; frees a killed run's lock
const DISPATCH_CLAIM_TTL_S = 86_400; // per-record send claim; outlives status propagation
const dispatchClaimKey = (recordId: string) => `h2:dispatch:${recordId}`;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Positive Confirmation polling (operator 2026-06-10): same posture as
// outreach-batch — only mark Texted on a terminal-success status from Quo.
const POLL_ATTEMPTS = Number(process.env.H2_CRON_POLL_ATTEMPTS ?? "6");
const POLL_DELAY_MS = Number(process.env.H2_CRON_POLL_DELAY_MS ?? "5000");

interface ProcessedRow {
  record_id: string;
  address: string;
  agent_name: string | null;
  agent_phone: string | null;
  route: H2Plan["route"] | "outside_hours";
  message: string | null;
  sms_fired: boolean;
  sms_message_id: string | null;
  /** Final Quo message status observed after polling (delivered | sent |
   *  failed | undelivered | unknown). Null when no id came back. */
  confirmed_status: string | null;
  /** True only when polling observed a terminal SUCCESS (delivered or sent).
   *  Unconfirmed sends do NOT mark Texted — reconcile cron repairs from Quo. */
  delivered: boolean;
  airtable_updated: boolean;
  error: string | null;
  working_hours_meta: WorkingHoursMeta | null;
}

/** Human-readable reason a record_id target fails the eligibility filter. */
function ineligibleReason(l: Listing): string | null {
  if (!(l.outreachStatus == null || l.outreachStatus.trim() === ""))
    return `Outreach_Status already set ('${l.outreachStatus}')`;
  if (l.liveStatus !== "Active") return `Live_Status is '${l.liveStatus}', not Active`;
  if (l.executionPath !== "Auto Proceed") return `Execution_Path is '${l.executionPath}', not Auto Proceed`;
  if (l.doNotText === true) return "Do_Not_Text is set";
  if (!(l.agentPhone && l.agentPhone.trim() !== "")) return "Agent_Phone is empty";
  if (l.sourceVersion !== SOURCE_VERSION_V2)
    return `Source_Version is '${l.sourceVersion}', not ${SOURCE_VERSION_V2}`;
  return null;
}

async function handle(req: Request): Promise<Response> {
  const t0 = Date.now();
  const url = new URL(req.url);

  // ── Auth waterfall (+ dashboard cookie) ──────────────────────────
  const cookieHeader = req.headers.get("cookie");
  let authKind: "dashboard_session" | "oauth" | "cron" | "bearer_dev" | "none" = "none";
  if (hasDashboardSession(cookieHeader)) {
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
  // On-demand override (operator 2026-06-23): a workflow_dispatch that
  // authenticates as "cron" (CRON_SECRET) may run this route via ?force_run=1
  // WITHOUT enabling the global MAVERICK_CRON_ENABLED switch — so an H2 batch can
  // be fired on demand while the RentCast burn-crons (appraiser-backfill et al.)
  // stay gated off. Bypasses ONLY this global cron gate; EVERY send-safety flag
  // below (hard-disable, H2_OUTREACH_LIVE, STOP_OPT_OUT_LIVE, H2_COVERED_ZIPS,
  // dry_run) is still enforced — it can never send unless the operator set them.
  const forceRun = url.searchParams.get("force_run") === "1";
  if (authKind === "cron" && process.env.MAVERICK_CRON_ENABLED !== "true" && !forceRun) {
    return NextResponse.json({ error: "cron_disabled" }, { status: 503 });
  }

  // ── HARD KILL (2026-06-05) ────────────────────────────────────────
  // Unauthorized sends fired at 15:30:27-15:31:27Z via api.openphone.com
  // from this route (cron `30 15 * * *` matched exactly). Route is now
  // CODE-LEVEL DISABLED regardless of env. Cron removed from vercel.json.
  // To re-enable, the operator must remove this block intentionally AND
  // fix the phantom safety gates (>85%-of-list block + outreach-safety-
  // check reading null fields) — see operator brief.
  if (process.env.H2_OUTREACH_HARD_DISABLE !== "false") {
    await audit({
      agent: "crier",
      event: "h2_outreach_hard_disabled",
      status: "confirmed_failure",
      inputSummary: { auth_kind: authKind, params: Object.fromEntries(url.searchParams) },
      outputSummary: { reason: "hard_disable_after_unauthorized_send_2026_06_05" },
    });
    return NextResponse.json(
      {
        error: "h2_outreach_hard_disabled",
        reason:
          "Route disabled in code after unauthorized send at 2026-06-05T15:30:27Z. Phantom safety gates must be fixed before re-enabling.",
      },
      { status: 503 },
    );
  }

  // ── Params + the dry-run / live gate ─────────────────────────────
  const liveEnv = process.env.H2_OUTREACH_LIVE === "true";
  const dryRunParam = url.searchParams.get("dry_run") === "false" ? false : true;
  // M8 Gate 3 coupling (operator 2026-06-18): a LIVE send additionally requires
  // STOP/opt-out enforcement to be active — the LAST compliance gate. H2 cannot
  // fire a single text unless STOP_OPT_OUT_LIVE is live, so an opted-out number
  // is always honored first. Forces dry (the preview still runs), never 503, so
  // telemetry is unaffected; fail-closed on the actual send.
  const optOutEnforcementLive = process.env.STOP_OPT_OUT_LIVE === "true";
  const dryRun = !liveEnv || dryRunParam || !optOutEnforcementLive; // send needs liveEnv AND ?dry_run=false AND opt-out enforcement live

  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(MAX_LIMIT, Math.floor(limitRaw))
    : DEFAULT_LIMIT;
  const recordId = url.searchParams.get("record_id");
  const sendDelayRaw = Number(url.searchParams.get("send_delay_ms"));
  const sendDelayMs = Number.isFinite(sendDelayRaw) && sendDelayRaw >= 0
    ? Math.floor(sendDelayRaw)
    : DEFAULT_SEND_DELAY_MS;

  // Quiet-hours gate is the non-disableable evaluateSendWindow (hard 8–20
  // property-local floor; H2_WORKING_HOURS_* env can only NARROW it). Read
  // per-record below, just before each send.

  // ── Read listings (full set — prior-contact index needs all rows) ─
  let allListings: Listing[];
  try {
    allListings = await getListings();
  } catch (err) {
    return NextResponse.json(
      { error: "listings_fetch_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  // ── Build the queue ──────────────────────────────────────────────
  let queue: Listing[];
  if (recordId) {
    let target = allListings.find((l) => l.id === recordId) ?? null;
    if (!target) {
      // Not in the cached list (e.g. just created for a smoke test) — fetch direct.
      try {
        target = await getListing(recordId);
      } catch {
        target = null;
      }
    }
    if (!target) {
      return NextResponse.json({ error: "record_not_found", record_id: recordId }, { status: 404 });
    }
    const reason = ineligibleReason(target);
    if (reason) {
      return NextResponse.json({
        mode: dryRun ? "dry_run" : "live",
        record_id: recordId,
        eligible_count: 0,
        processed: [{
          record_id: target.id,
          address: target.address,
          agent_name: target.agentName,
          agent_phone: target.agentPhone,
          route: "skipped",
          message: null,
          sms_fired: false,
          sms_message_id: null,
          confirmed_status: null,
          delivered: false,
          airtable_updated: false,
          error: `ineligible: ${reason}`,
          working_hours_meta: null,
        }],
        summary: { first_touch_sent: 0, prior_contact_stalled: 0, bad_phone_quarantined: 0, outside_hours: 0, skipped: 1, errors: 0, unconfirmed: 0, delivery_quarantined: 0 },
        auth_kind: authKind,
        duration_ms: Date.now() - t0,
      });
    }
    queue = [target];
  } else {
    // STRICT selector (operator 2026-06-10, aperture-open audit): the cron
    // uses the SAME gate the batch uses — selectOutreachReady layers
    // freshness + priceable-market on top of H2 eligibility. Replaces the
    // older selectH2Eligible which would have re-engaged the 25 legacy
    // unbacked-status records (forward-only directive) and any pre-
    // priceable-gate listings still in the cohort.
    queue = selectOutreachReady(allListings).slice(0, limit);
  }

  // eligibleCount uses the same strict selector as the queue so the dry-run
  // headline matches the real send pool.
  const eligibleCount = recordId ? queue.length : selectOutreachReady(allListings).length;

  // ── TIER A door-opener guard (keystone rewrite 2026-06-12, adjudication
  // recXJrM7EYK3pEFmF item 1) ──────────────────────────────────────────
  // The autonomous door-opener is 65% of list, UNCHANGED and UNCAPPED by
  // any median-derived ceiling — median informs (market gate, sanity rail,
  // dispo triage), never authorizes an offer number, in either direction.
  // The committed price happens later: Tier B (operator-approved
  // computeFlipperMax ceiling, mandatory inspection contingency) or Tier C
  // (property-up autonomous — requires a matched POF buyer's sourced
  // Min_Deal_Spread; expected to price zero records until data accrues).
  //
  // Gates that REMAIN on Tier A: priceable market (median's surviving
  // market-gate role), positive opener, 35% lowball floor, never-over-list,
  // plus all the downstream send rails (working hours, KV claims, DNT,
  // hydration, positive-confirmation polling) unchanged.
  //
  // The resolved ceiling is still computed per record — for TELEMETRY (the
  // probe shows lineage + informational ceiling so Maverick reviews with
  // numbers in hand), never to set or cap the sent number.
  // ── Your_MAO opener gate (operator brief 2026-06-13, spine
  // recZ6tBZRmfFOLwqo) ─────────────────────────────────────────────────
  // SUPERSEDES the 65%-of-list door-opener. opener = anchor_pct ×
  // Your_MAO. HARD GATE: null/≤0 Your_MAO routes to operator review
  // (existing dead-path), never sends. Per-market anchor (Detroit 0.90
  // at launch); the silent weekly calibration adjusts it. The resolved
  // ceiling (informational lineage) is still computed for the probe's
  // telemetry block so Maverick reviews with full numbers in hand.
  const openerGuarded: Array<{ recordId: string; address: string | null; listPrice: number | null; action: "skipped"; reason: string | null; ceiling: number | null; ceilingSource: string | null; anchorPct: number | null; opener: number | null; source: string | null }> = [];
  // One anchor read per market per tick + one ARV-seed read per ZIP — cached so
  // a 100-record cohort doesn't hit KV per record.
  const anchorCache = new Map<string, number>();
  const seedCache = new Map<string, ZipArvSeed | null>();
  const filteredQueue: typeof queue = [];
  for (const l of queue) {
    const market = getMarketForListing({ state: l.state, zip: l.zip });
    const marketId = market?.id ?? "";
    let anchorPct = anchorCache.get(marketId);
    if (anchorPct == null) {
      anchorPct = await resolveAnchorPct(marketId || null);
      anchorCache.set(marketId, anchorPct);
    }
    // SEED-AWARE OPENER (operator 2026-06-30): price via the SAME canonical
    // pricer as the opener-dry-run eyeball + the intake opener-write —
    // priceOpenerWithSeed prefers the ZIP_ARV_Seed renovated $/sqft over the
    // contaminated stored Real_ARV_Median, so cast-wide metros (ARV-seeded, no
    // buyer-median) price IDENTICALLY to the watched preview. The old path
    // (computeRoughOpenerCeiling off l.realArvMedian + the buyer-median
    // priceable gate) HELD every ARV-seeded metro market_not_priceable —
    // l.realArvMedian is null for them — starving autonomous cast-wide sends.
    // priceOpener applies the anchor, the never-over-list 90% cap, and the $250
    // rounding; the min-offer floor (below) and all send rails are unchanged.
    const zip5 = (l.zip ?? "").trim();
    if (zip5 && !seedCache.has(zip5)) {
      seedCache.set(zip5, await getZipArvSeed(zip5).catch(() => null));
    }
    const seed = zip5 ? seedCache.get(zip5) ?? null : null;
    const pw = priceOpenerWithSeed({
      listPrice: l.listPrice ?? null,
      storedArv: l.realArvMedian ?? null,
      storedArvConfidence: l.arvConfidence ?? null,
      estRehabMid: l.estRehabMid ?? null,
      estRehab: l.estRehab ?? null,
      sqft: l.buildingSqFt ?? null,
      arvPctMax: openerArvPctMax(market, l.state),
      wholesaleFee: l.wholesaleFeeTarget ?? null,
      anchorPct,
      seed,
    });
    const priced = pw.result;
    if (priced.opener == null) {
      openerGuarded.push({
        recordId: l.id,
        address: l.address ?? null,
        listPrice: l.listPrice ?? null,
        action: "skipped",
        reason: priced.basis === "hold_no_value_basis" ? "market_not_priceable" : "opener_hold",
        ceiling: priced.ceiling,
        ceilingSource: priced.basis,
        anchorPct: priced.anchorPct,
        opener: null,
        source: pw.arvSource,
      });
      continue;
    }
    // ── MIN-OFFER FLOOR (relationship-protector, operator 2026-06-30) ──
    // A positive-but-sub-pencil opener below max(PCT×list, $USD) is a
    // laughable cash number on a near-shell ($1,714 on a $15k gutted house).
    // HOLD → creative/landlord lane; never autonomously text it. The seed
    // pricer (per-market-pricer) already floors here; the direct send path
    // skipped it — closing that gap so volume can flow at scale without
    // burning agent relationships on garbage offers.
    if (
      l.listPrice != null &&
      priced.opener != null &&
      priced.opener < minOfferFloor(l.listPrice)
    ) {
      openerGuarded.push({
        recordId: l.id,
        address: l.address ?? null,
        listPrice: l.listPrice ?? null,
        action: "skipped",
        reason: "below_min_offer_floor",
        ceiling: priced.ceiling,
        ceilingSource: priced.basis,
        anchorPct: priced.anchorPct,
        opener: priced.opener,
        source: pw.arvSource,
      });
      continue;
    }
    // SUCCESS — overwrite l.mao with the seed-aware anchored opener so all
    // downstream rails (send composer, idempotency, audit) read one value.
    l.mao = priced.opener;
    filteredQueue.push(l);
  }
  queue = filteredQueue;

  // ── HOLD surface (operator 2026-06-11): a guard-SKIPPED record is a
  // decision waiting on the operator (send the deep lowball anyway / skip /
  // watch for a price cut). Until tonight it lived only in this response's
  // JSON + the audit row — a silent HOLD. Now each skip writes ONE Pending
  // Agent_Proposals row (h2_opener_hold), which surfaces on the existing
  // /queue decision dashboard. Idempotent per record: an already-Pending
  // hold for the same record is not re-created on the next daily tick.
  // Best-effort — a proposals-write failure never blocks the send loop.
  const holdProposals = { attempted: 0, created: 0, deduped: 0, error: null as string | null };
  const skippedHolds = openerGuarded.filter((g) => g.action === "skipped");
  const proposalsTable = process.env.AGENT_PROPOSALS_TABLE_ID ?? null;
  if (skippedHolds.length > 0 && proposalsTable && process.env.AIRTABLE_PAT) {
    try {
      const baseId = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
      const pendingRes = await fetch(
        `https://api.airtable.com/v0/${baseId}/${proposalsTable}?` +
          new URLSearchParams({
            filterByFormula: `AND({Status}="Pending",{Proposal_Type}="h2_opener_hold")`,
            "fields[]": "Record_ID",
          }).toString(),
        { headers: { Authorization: `Bearer ${process.env.AIRTABLE_PAT}` }, cache: "no-store" },
      );
      const pendingIds = new Set<string>();
      if (pendingRes.ok) {
        const body = (await pendingRes.json()) as { records?: Array<{ fields: Record<string, unknown> }> };
        for (const r of body.records ?? []) {
          if (typeof r.fields.Record_ID === "string") pendingIds.add(r.fields.Record_ID);
        }
      }
      const toCreate = skippedHolds.filter((g) => !pendingIds.has(g.recordId));
      holdProposals.attempted = skippedHolds.length;
      holdProposals.deduped = skippedHolds.length - toCreate.length;
      if (toCreate.length > 0) {
        const createRes = await fetch(`https://api.airtable.com/v0/${baseId}/${proposalsTable}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${process.env.AIRTABLE_PAT}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            records: toCreate.slice(0, 10).map((g, i) => ({
              fields: {
                Proposal_ID: `h2_opener_hold-${Date.now()}-${i}`,
                Proposal_Type: "h2_opener_hold",
                Priority: "NORMAL",
                Record_ID: g.recordId,
                Record_Address: g.address ?? "",
                Reasoning:
                  `H2 opener HOLD [${g.reason ?? "guard_refused"}]: rough ceiling ` +
                  `${g.ceiling == null ? "null" : "$" + g.ceiling.toLocaleString()} (${g.ceilingSource ?? "?"}) ` +
                  `× anchor ${g.anchorPct ?? "?"} vs list $${(g.listPrice ?? 0).toLocaleString()}. ` +
                  `Decide: source ARV/rehab and re-run, or skip this record. ` +
                  `Autonomous send refused — rough opener ceiling null or non-penciling (keystone 2026-06-13).`,
                Suggested_Action_Payload: JSON.stringify({ recordId: g.recordId, action: "h2_opener_hold", guard: g }),
                Status: "Pending",
              },
            })),
            typecast: true,
          }),
        });
        if (createRes.ok) holdProposals.created = Math.min(toCreate.length, 10);
        else holdProposals.error = `proposals_create_${createRes.status}`;
      }
    } catch (err) {
      holdProposals.error = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
    }
  }

  const priorIndex = buildPriorContactIndex(allListings);
  const plans = planQueue(queue, priorIndex);
  const byId = new Map(queue.map((l) => [l.id, l] as const));

  // ── M7 Part 2 send cap (operator 2026-06-18) — the safety meter on the H2
  // lift. The live census shows 109 records already at outreach_ready; lifting
  // H2_OUTREACH_HARD_DISABLE without a cap would fire ALL of them at once. Bound
  // a LIVE run to a handful of sends, covered ZIPs only (FAIL-CLOSED: empty
  // H2_COVERED_ZIPS → zero). The cap is ALWAYS computed so a watched dry-run
  // previews exactly what would fire live; it only FILTERS dispatch when live.
  // The hard-disable above stays the master kill — this runs only once lifted.
  // UNLEASH ruling (operator 2026-07-09): H2_COVERED_ZIPS=auto collapses
  // send coverage into the seeded-ZIP registry — a ZIP becomes send-covered
  // the moment the system seeds it (intake -> seed-sweep -> covered), so
  // metros expand autonomously with zero env edits. Legacy allowlist mode
  // and unset-env fail-closed behavior are unchanged.
  const rawCapCfg = readSendCapConfig();
  const capCfg =
    rawCapCfg.coverageMode === "auto"
      ? resolveCoverage(rawCapCfg, await listSeededZips())
      : rawCapCfg;
  const sendCap = applySendCap(plans, (p) => byId.get(p.recordId)?.zip ?? null, capCfg);
  const dispatchPlans = dryRun ? plans : sendCap.allowed;
  const sendCapSummary = {
    enforced: !dryRun, // live dispatch is filtered; a dry run previews all + this projection
    allowed: sendCap.allowed.length,
    capped: sendCap.capped.length,
    capped_by_reason: {
      zip_not_covered: sendCap.capped.filter((c) => c.reason === "zip_not_covered").length,
      per_zip_cap: sendCap.capped.filter((c) => c.reason === "per_zip_cap").length,
      per_run_cap: sendCap.capped.filter((c) => c.reason === "per_run_cap").length,
    },
    config: sendCap.config,
  };

  const startedAt = new Date(t0).toISOString();
  const processed: ProcessedRow[] = [];
  const summary: {
    first_touch_sent: number;
    prior_contact_stalled: number;
    bad_phone_quarantined: number;
    outside_hours: number;
    skipped: number;
    idempotent_skipped: number;
    errors: number;
    /** Sends that fired but never observed a terminal-success status in the
     *  poll window — Texted NOT stamped; reconcile cron repairs. */
    unconfirmed: number;
    /** Sends the carrier confirmed it could NOT deliver (terminal
     *  undelivered/failed) — the number was auto-quarantined (marked Dead,
     *  no retry). Distinct from bad_phone_quarantined (upfront format reject). */
    delivery_quarantined: number;
  } = {
    first_touch_sent: 0,
    prior_contact_stalled: 0,
    bad_phone_quarantined: 0,
    outside_hours: 0,
    skipped: 0,
    idempotent_skipped: 0,
    errors: 0,
    unconfirmed: 0,
    delivery_quarantined: 0,
  };

  // Run-mutex (live only) — two overlapping invocations both reading the same
  // empty-status pool is what double-fired on 2026-05-27 (Spine
  // recWwIMc7V15p968k). KV is strongly-consistent (no Airtable propagation
  // lag); the TTL frees the lock if a run is killed mid-flight. Degrades to the
  // Airtable status gate when KV is unconfigured.
  const lockEnabled = !dryRun && kvConfigured();
  let runLockHeld = false;
  if (lockEnabled) {
    runLockHeld = await kvProd.setNx(RUN_LOCK_KEY, startedAt, RUN_LOCK_TTL_S);
    if (!runLockHeld) {
      return NextResponse.json({
        mode: "live",
        skipped: "another_run_in_progress",
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        eligible_count: eligibleCount,
        auth_kind: authKind,
        duration_ms: Date.now() - t0,
      });
    }
  }

  for (const p of dispatchPlans) {
    const row: ProcessedRow = {
      record_id: p.recordId,
      address: p.address,
      agent_name: p.agentName,
      agent_phone: p.route === "first_touch" ? p.toE164 : p.agentPhoneRaw,
      route: p.route,
      message: p.message,
      sms_fired: false,
      sms_message_id: null,
      confirmed_status: null,
      delivered: false,
      airtable_updated: false,
      error: null,
      working_hours_meta: null,
    };
    const iso = new Date().toISOString();
    const listing = byId.get(p.recordId);
    const existingNotes = listing?.notes ?? null;

    // Working-hours gate — first_touch ONLY. prior_contact_stall and
    // bad_phone_quarantine don't send SMS, so their Airtable bookkeeping runs
    // 24/7. Applies in BOTH dry and live so the reported route reflects reality.
    if (p.route === "first_touch") {
      // Non-disableable hard floor (8–20 property-local). Env can only
      // NARROW the window, never widen or disable it — a quiet-hours guard
      // you can flip off is not a guard (TCPA). evaluateSendWindow folds the
      // H2_WORKING_HOURS_* env into the hard floor internally.
      const wh = evaluateSendWindow(listing?.state ?? null);
      row.working_hours_meta = wh.meta;
      if (wh.meta.tz_defaulted) {
        console.warn(
          `[h2-outreach][working-hours] no tz mapping for state '${listing?.state ?? ""}' — ` +
          `defaulting to ${wh.meta.timezone} record=${p.recordId}`,
        );
      }
      if (!wh.inside) {
        row.route = "outside_hours";
        summary.outside_hours++;
        console.log(
          `route=outside_hours record=${p.recordId} state=${wh.meta.state ?? ""} ` +
          `tz=${wh.meta.timezone} local_hour=${wh.meta.local_hour} local_wday=${wh.meta.local_weekday}`,
        );
        processed.push(row);
        continue; // no SMS, no Airtable write
      }
    }

    // Dry run: report the intended action (incl. the full SMS body) — no I/O.
    if (dryRun) {
      if (p.route === "skipped") row.error = p.skipReason;
      tally(summary, p.route);
      processed.push(row);
      continue;
    }

    // Wall-clock guard — stop starting new work; remaining roll to next run.
    if (Date.now() - t0 > WALL_CLOCK_BUDGET_MS) {
      row.error = "skipped: wall-clock budget reached";
      processed.push(row);
      continue;
    }

    const claimKey = dispatchClaimKey(p.recordId);
    let claimAcquired = false;
    try {
      if (p.route === "bad_phone_quarantine") {
        await updateListingRecord(p.recordId, {
          Outreach_Status: "Dead",
          Verification_Notes: buildQuarantineNote(existingNotes, iso, p.agentPhoneRaw),
        });
        row.airtable_updated = true;
        summary.bad_phone_quarantined++;
      } else if (p.route === "prior_contact_stall") {
        await updateListingRecord(p.recordId, {
          Outreach_Status: "Manual Review",
          Verification_Notes: buildStallNote(existingNotes, iso, p.prior!),
        });
        row.airtable_updated = true;
        summary.prior_contact_stalled++;
      } else if (p.route === "skipped") {
        row.error = p.skipReason;
        summary.skipped++;
      } else {
        // first_touch — the only path that sends SMS. Claim the record in KV
        // BEFORE dispatch: an overlapping run or a re-fire inside the Airtable
        // status-propagation window then cannot re-text the same agent (the
        // race that double-fired today — Spine recWwIMc7V15p968k).
        if (lockEnabled) {
          claimAcquired = await kvProd.setNx(claimKey, iso, DISPATCH_CLAIM_TTL_S);
        }
        if (lockEnabled && !claimAcquired) {
          row.error = "idempotent_skip: dispatch already claimed";
          summary.idempotent_skipped++;
        } else {
          // ── PRE-SEND HARD GATES (2026-06-05) ─────────────────────────
          // The 6 unauthorized sends went through because this route
          // never called the safety gates. Both gates are pure / no-I/O,
          // so wiring them here adds zero latency. Fresh-fetch the
          // listing fields the checks read (the planning load may not
          // have populated hydration timestamps).
          const fresh = await getListing(p.recordId);
          const hydration = checkFirstOutreachHydration({
            lastOutreachDate: fresh?.lastOutreachDate ?? null,
            arvValidatedAt: fresh?.arvValidatedAt ?? null,
            rehabEstimatedAt: fresh?.rehabEstimatedAt ?? null,
            // OPENER LANE (operator decision "A", 2026-07-01): reaching first_touch
            // means the seed opener already priced this record (p.mao > 0 — real
            // renovated-comp ARV + placeholder rehab, floored/capped/self-gated).
            // That's grounded enough for the ROUGH first text; the precise rehab
            // (vision) + contract MAO are honed after a reply via DD questions.
            openerPriceable: typeof p.mao === "number" && p.mao > 0,
          });
          if (!hydration.ok) {
            row.error = `hydration_block: ${hydration.blockedBecause}`;
            summary.errors++;
            await audit({
              agent: "crier",
              event: "h2_outreach_hydration_blocked",
              status: "confirmed_failure",
              recordId: p.recordId,
              inputSummary: { missing: hydration.missing },
              outputSummary: { reason: hydration.blockedBecause },
            });
            continue;
          }
          const economics = checkOfferOverList(p.message!, fresh?.listPrice ?? null);
          if (!economics.ok) {
            row.error = `economics_block: ${economics.blockedBecause}`;
            summary.errors++;
            await audit({
              agent: "crier",
              event: "h2_outreach_economics_blocked",
              status: "confirmed_failure",
              recordId: p.recordId,
              inputSummary: { offer: economics.offerAmount, list: economics.listPrice, ratio: economics.ratio },
              outputSummary: { reason: economics.blockedBecause },
            });
            continue;
          }
          // ── 1) SEND ─────────────────────────────────────────────────
          const result = await sendMessageWithId(p.toE164!, p.message!);
          row.sms_fired = true;
          row.sms_message_id = result.id;

          // ── 2) CONFIRM via message-status polling (operator 2026-06-10,
          //      aperture-open audit). A 2xx from Quo means QUEUED, not
          //      DELIVERED — per Positive Confirmation, the cron must not
          //      stamp Texted on an unverified send (the batch path already
          //      enforces this; the cron was missing it).
          let delivered = false;
          let terminalFailure = false; // Quo confirmed the message will NOT deliver
          let confirmedStatus: string | null = result.status ?? null;
          if (result.id) {
            for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
              await sleep(POLL_DELAY_MS);
              try {
                const st = await getMessageStatus(result.id);
                confirmedStatus = st.status;
                if (st.isTerminal) {
                  delivered = st.isSuccess;
                  terminalFailure = !st.isSuccess; // undelivered / failed
                  break;
                }
              } catch (err) {
                row.error = `status_poll: ${String(err).slice(0, 120)}`;
              }
            }
          } else {
            row.error = "send returned no message id — cannot confirm";
          }
          row.confirmed_status = confirmedStatus;

          // ── 3) WRITE — Texted on a CONFIRMED success; auto-QUARANTINE on a
          // CONFIRMED delivery failure; else leave unconfirmed for the reconcile
          // cron. A merely-unconfirmed send keeps its KV claim (it may have
          // actually landed — a re-text is worse than a transiently-stale status).
          if (delivered) {
            await updateListingRecord(p.recordId, {
              Outreach_Status: "Texted",
              Last_Outbound_At: iso,
              Verification_Notes: buildSentNote(existingNotes, iso, result.id, p.message!),
            });
            row.delivered = true;
            row.airtable_updated = true;
            summary.first_touch_sent++; // Texted only counted on confirmed delivery
          } else if (terminalFailure) {
            // AUTO-QUARANTINE (operator 2026-07-01): Quo confirmed the carrier
            // could not deliver (undelivered/failed) — a dead/non-SMS number
            // (landline, disconnected, hard block). Mark the record Dead so the
            // autonomy never re-fires at it, and release the KV claim (Dead drops
            // it from the queue, so no double-send risk). Protects sender
            // reputation + stops burning sends on dud numbers. First live case:
            // 1505 17th St / Angela James (+12058756959), carrier "undelivered".
            await updateListingRecord(p.recordId, {
              Outreach_Status: "Dead",
              Verification_Notes: buildDeliveryQuarantineNote(existingNotes, iso, p.toE164!, confirmedStatus),
            });
            row.airtable_updated = true;
            summary.delivery_quarantined++;
            await audit({
              agent: "crier",
              event: "h2_outreach_delivery_quarantine",
              status: "confirmed_failure",
              recordId: p.recordId,
              externalId: result.id ?? undefined,
              inputSummary: { phone: p.toE164, confirmedStatus },
              outputSummary: { quarantined: true, reason: `carrier ${confirmedStatus ?? "undelivered"}` },
            });
            if (claimAcquired) await kvProd.del(claimKey).catch(() => {}); // dead record — free the lock
          } else {
            summary.unconfirmed++; // not stamped Texted; reconcile cron repairs
          }
          if (sendDelayMs > 0) await sleep(sendDelayMs); // throttle after a send only
        }
      }
    } catch (err) {
      row.error = err instanceof Error ? err.message : String(err);
      summary.errors++;
      // Release the claim ONLY if the SEND itself failed (no SMS went out), so
      // a later run retries cleanly. If the send succeeded but the status write
      // failed, KEEP the claim — a re-text is worse than a transiently-stale
      // Outreach_Status (the reconcile cron repairs status).
      if (claimAcquired && !row.sms_fired) {
        await kvProd.del(claimKey).catch(() => {});
      }
    }
    processed.push(row);
  }

  await audit({
    agent: "crier",
    event: dryRun ? "h2_outreach_dry_run" : "h2_outreach_live",
    status: summary.errors > 0 ? "uncertain" : "confirmed_success",
    inputSummary: { auth_kind: authKind, dry_run: dryRun, limit, record_id: recordId, live_env: liveEnv },
    outputSummary: { eligible_count: eligibleCount, processed: processed.length, ...summary, send_cap: sendCapSummary },
    ms: Date.now() - t0,
  });

  // ── Supply-floor signal (2026-06-11 doctrine — spine recfcAUA0cX202utp).
  // Compute sendable_queue_depth (= eligibleCount), name the binding
  // constraint if below SUPPLY_FLOOR, emit an info-tier audit. NEVER
  // a quota — the cap holds; the operator gets a named lever to widen.
  let supplyFloor: SupplyFloorVerdict | null = null;
  try {
    let seededZipsCount = FALLBACK_SEEDED_ZIPS.size;
    try {
      seededZipsCount = (await listSeededZips()).size;
    } catch {
      /* fall back narrows to the hardcoded allowlist — same posture the
         intake cron uses (fail-narrow, never widen). */
    }
    // verify_stale headcount — records eligible in every respect except
    // the 48h freshness window. Pure pass over the already-fetched set.
    let cohortStale = 0;
    for (const l of allListings) {
      if (outreachReadyReason(l).reason === "verify_stale") cohortStale++;
    }
    const ctx = {
      sendableQueueDepth: eligibleCount,
      stalledBehindAgents: summary.prior_contact_stalled,
      intakeLive: process.env.CRAWLER_INTAKE_LIVE === "true",
      seededZipsCount,
      cohortStale,
    };
    supplyFloor = evaluateSupplyFloor(ctx);
    await emitSupplyFloorAudit(supplyFloor, ctx);
  } catch (err) {
    // Best-effort — supply-floor is a signal, never a gate. A failure
    // here must not affect the cron's primary work.
    console.error("[h2-outreach] supply-floor evaluator threw:", err);
  }

  // Release the run-mutex on normal completion; the TTL is the backstop for the
  // (record errors are caught per-record, so this path is the common exit).
  if (runLockHeld) await kvProd.del(RUN_LOCK_KEY).catch(() => {});

  return NextResponse.json({
    mode: dryRun ? "dry_run" : "live",
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    eligible_count: eligibleCount,
    processed,
    summary,
    send_cap: sendCapSummary,
    opt_out_enforcement_live: optOutEnforcementLive,
    opener_guarded: openerGuarded,
    hold_proposals: holdProposals,
    supply_floor: supplyFloor,
    auth_kind: authKind,
    duration_ms: Date.now() - t0,
  });
}

function tally(summary: { first_touch_sent: number; prior_contact_stalled: number; bad_phone_quarantined: number; skipped: number }, route: H2Plan["route"]) {
  if (route === "first_touch") summary.first_touch_sent++;
  else if (route === "prior_contact_stall") summary.prior_contact_stalled++;
  else if (route === "bad_phone_quarantine") summary.bad_phone_quarantined++;
  else summary.skipped++;
}

export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}
