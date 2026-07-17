// H2 bump lane cron (#33) — day-3/day-7 re-touch of silent v2 first-touch
// threads. @agent: crier
//
// GET|POST /api/cron/bump-followup
//   ?dry_run=false   — actually send (default TRUE: plan + report only)
//   ?limit=N         — cap records considered this run (default 10, max 50)
//   ?send_delay_ms=N — inter-send throttle override (default 30000)
//   ?force_run=1     — cron-auth may bypass ONLY the global MAVERICK_CRON_ENABLED
//                      gate (same posture as h2-outreach); every send-safety
//                      flag below is still enforced.
//
// SAFETY — the SAME independent brakes as the first-touch path, because a bump
// is the same kind of SMS:
//   1. H2_OUTREACH_HARD_DISABLE master kill (bumps are opener-path sends).
//   2. H2_BUMP_DISABLE — scoped kill for THIS lane only (default enabled, so
//      no env surgery is needed to launch; the operator can dark the bumps
//      without touching first touch).
//   3. Live needs H2_OUTREACH_LIVE=true AND ?dry_run=false AND
//      STOP_OPT_OUT_LIVE=true — identical to first touch.
//   4. Send cap (covered ZIPs / per-run / per-zip) — same fail-closed meter.
//   5. Quiet hours: non-disableable 8–20 property-local floor.
//   6. KV run mutex + per-record-attempt dispatch claims (no double-bump
//      inside Airtable's status-propagation window).
//   7. Positive confirmation: Follow_Up_Count/stamps written ONLY on a
//      confirmed-delivered status; carrier-terminal failures auto-quarantine.
//   8. The >85%-of-list rail re-checked against the CURRENT list price — a
//      big price cut since first touch re-routes the thread to a human.
//
// STICKY NUMBER: parsed from the `[H2 sent …]` delivery stamp (the number the
// agent actually received). No stamp → no bump. Never recomputed, never read
// from a drifted field (INVARIANTS §3; P3 field-drift evidence).

import { NextResponse } from "next/server";
import { getListings, getListing, updateListingRecord } from "@/lib/airtable";
import { sendMessageWithId, getMessageStatus, getMessagesForParticipant } from "@/lib/quo";
import { audit } from "@/lib/audit-log";
import { checkOfferOverList } from "@/lib/outreach-economics";
import { readSendCapConfig, resolveCoverage, applySendCap } from "@/lib/outreach/send-cap";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import type { Listing } from "@/lib/types";
import { normalizePhone } from "@/lib/phone-normalize";
import { buildDeliveryQuarantineNote } from "@/lib/h2-outreach";
import {
  bumpVerdict,
  selectBumpDue,
  liveThreadPhoneIndex,
  extractStickyOffer,
  buildBumpMessage,
  buildBumpSentNote,
  threadInboundTruth,
  buildBumpAbortedNote,
} from "@/lib/h2-outreach/bump-lane";
import { evaluateSendWindow, type WorkingHoursMeta } from "@/lib/h2-working-hours";
import { listSeededZips } from "@/lib/buyer-median-store";
import { listArvSeededZips } from "@/lib/zip-arv-seed-store";

export const runtime = "nodejs";
export const maxDuration = 300;

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const DEFAULT_SEND_DELAY_MS = 30_000;
const WALL_CLOCK_BUDGET_MS = 270_000;

const RUN_LOCK_KEY = "h2:bump:run:lock";
const RUN_LOCK_TTL_S = 300;
const DISPATCH_CLAIM_TTL_S = 86_400;
const dispatchClaimKey = (recordId: string, attempt: number) =>
  `h2:bump:${recordId}:${attempt}`;

const POLL_ATTEMPTS = Number(process.env.H2_CRON_POLL_ATTEMPTS ?? "6");
const POLL_DELAY_MS = Number(process.env.H2_CRON_POLL_DELAY_MS ?? "5000");

/** Thread-truth lookback: 90 days — the whole life of a v2 thread (matches
 *  lib/quo's 300-message page ceiling). One Quo GET per planned live bump. */
const THREAD_TRUTH_LOOKBACK_MIN = 90 * 24 * 60;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface BumpPlan {
  recordId: string;
  address: string;
  zip: string | null;
  state: string | null;
  agentName: string | null;
  toE164: string;
  attempt: number;
  stickyOffer: number;
  message: string;
}

interface ProcessedRow {
  record_id: string;
  address: string;
  attempt: number;
  sticky_offer: number;
  route: "bump" | "outside_hours";
  message: string;
  sms_fired: boolean;
  sms_message_id: string | null;
  confirmed_status: string | null;
  delivered: boolean;
  airtable_updated: boolean;
  error: string | null;
  working_hours_meta: WorkingHoursMeta | null;
}

async function handle(req: Request): Promise<Response> {
  const t0 = Date.now();
  const url = new URL(req.url);

  // ── Auth waterfall (+ dashboard cookie) — mirrors h2-outreach ──────
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
  const forceRun = url.searchParams.get("force_run") === "1";
  if (authKind === "cron" && process.env.MAVERICK_CRON_ENABLED !== "true" && !forceRun) {
    return NextResponse.json({ error: "cron_disabled" }, { status: 503 });
  }

  // ── Master kill (shared with first touch) + scoped lane kill ──────
  if (process.env.H2_OUTREACH_HARD_DISABLE !== "false") {
    await audit({
      agent: "crier",
      event: "h2_bump_hard_disabled",
      status: "confirmed_failure",
      inputSummary: { auth_kind: authKind, params: Object.fromEntries(url.searchParams) },
      outputSummary: { reason: "master_hard_disable_engaged" },
    });
    return NextResponse.json(
      { error: "h2_outreach_hard_disabled", reason: "Master H2 kill engaged — bump lane rides the same switch." },
      { status: 503 },
    );
  }
  if (process.env.H2_BUMP_DISABLE === "true") {
    return NextResponse.json(
      { error: "h2_bump_disabled", reason: "Bump lane disabled via H2_BUMP_DISABLE (first touch unaffected)." },
      { status: 503 },
    );
  }

  // ── Params + dry/live gate — identical posture to first touch ─────
  const liveEnv = process.env.H2_OUTREACH_LIVE === "true";
  const dryRunParam = url.searchParams.get("dry_run") === "false" ? false : true;
  const optOutEnforcementLive = process.env.STOP_OPT_OUT_LIVE === "true";
  const dryRun = !liveEnv || dryRunParam || !optOutEnforcementLive;

  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(MAX_LIMIT, Math.floor(limitRaw))
    : DEFAULT_LIMIT;
  const sendDelayRaw = Number(url.searchParams.get("send_delay_ms"));
  const sendDelayMs = Number.isFinite(sendDelayRaw) && sendDelayRaw >= 0
    ? Math.floor(sendDelayRaw)
    : DEFAULT_SEND_DELAY_MS;

  let allListings: Listing[];
  try {
    allListings = await getListings();
  } catch (err) {
    return NextResponse.json(
      { error: "listings_fetch_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  const now = new Date();
  const due = selectBumpDue(allListings, now);
  const liveThreads = liveThreadPhoneIndex(allListings);

  // ── Plan: per-agent dedup, live-thread guard, sticky-stamp gate ────
  const skipped: Array<{ record_id: string; address: string; reason: string }> = [];
  const seenThisRun = new Set<string>();
  const plans: BumpPlan[] = [];
  for (const l of due) {
    if (plans.length >= limit) break;
    const v = bumpVerdict(l, now);
    if (!v.due || v.attempt == null) continue; // selectBumpDue already filtered; defensive
    const phone = normalizePhone(l.agentPhone)!;
    if (liveThreads.has(phone)) {
      skipped.push({ record_id: l.id, address: l.address, reason: "agent_in_live_thread" });
      continue;
    }
    if (seenThisRun.has(phone)) {
      skipped.push({ record_id: l.id, address: l.address, reason: "agent_already_bumped_this_run" });
      continue;
    }
    const sticky = extractStickyOffer(l.notes);
    if (!sticky) {
      // No delivery stamp → we do not know what number the agent received.
      // Fail closed — a drifted field is never a fallback (INVARIANTS §3).
      skipped.push({ record_id: l.id, address: l.address, reason: "no_sticky_stamp" });
      continue;
    }
    seenThisRun.add(phone);
    plans.push({
      recordId: l.id,
      address: l.address,
      zip: l.zip ?? null,
      state: l.state ?? null,
      agentName: l.agentName,
      toE164: phone,
      attempt: v.attempt,
      stickyOffer: sticky.offer,
      message: buildBumpMessage(l.agentName, l.address, sticky.offer, v.attempt),
    });
  }

  // ── Send cap — same fail-closed meter + auto coverage as first touch ─
  const rawCapCfg = readSendCapConfig();
  const capCfg =
    rawCapCfg.coverageMode === "auto"
      ? resolveCoverage(rawCapCfg, [
          ...(await listArvSeededZips()),
          ...(await listSeededZips()),
        ])
      : rawCapCfg;
  const sendCap = applySendCap(plans, (p) => p.zip, capCfg);
  const dispatchPlans = dryRun ? plans : sendCap.allowed;
  const sendCapSummary = {
    enforced: !dryRun,
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
  const summary = {
    bumped: 0,
    outside_hours: 0,
    idempotent_skipped: 0,
    errors: 0,
    unconfirmed: 0,
    delivery_quarantined: 0,
    stale_state_skipped: 0,
    thread_truth_aborted: 0,
  };

  const lockEnabled = !dryRun && kvConfigured();
  let runLockHeld = false;
  if (lockEnabled) {
    runLockHeld = await kvProd.setNx(RUN_LOCK_KEY, startedAt, RUN_LOCK_TTL_S);
    if (!runLockHeld) {
      return NextResponse.json({
        mode: "live",
        skipped: "another_run_in_progress",
        started_at: startedAt,
        due_total: due.length,
        auth_kind: authKind,
        duration_ms: Date.now() - t0,
      });
    }
  }

  const byId = new Map(allListings.map((l) => [l.id, l] as const));

  for (const p of dispatchPlans) {
    const row: ProcessedRow = {
      record_id: p.recordId,
      address: p.address,
      attempt: p.attempt,
      sticky_offer: p.stickyOffer,
      route: "bump",
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

    // Quiet hours — non-disableable 8–20 property-local floor, dry AND live.
    const wh = evaluateSendWindow(p.state);
    row.working_hours_meta = wh.meta;
    if (!wh.inside) {
      row.route = "outside_hours";
      summary.outside_hours++;
      processed.push(row);
      continue;
    }

    if (dryRun) {
      processed.push(row);
      continue;
    }

    if (Date.now() - t0 > WALL_CLOCK_BUDGET_MS) {
      row.error = "skipped: wall-clock budget reached";
      processed.push(row);
      continue;
    }

    const claimKey = dispatchClaimKey(p.recordId, p.attempt);
    let claimAcquired = false;
    try {
      if (lockEnabled) {
        claimAcquired = await kvProd.setNx(claimKey, iso, DISPATCH_CLAIM_TTL_S);
        if (!claimAcquired) {
          row.error = "idempotent_skip: bump already claimed";
          summary.idempotent_skipped++;
          processed.push(row);
          continue;
        }
      }

      // ── Pre-send re-check on a FRESH read: the thread must still be
      // exactly the silent Texted thread we planned against. A reply, a
      // status flip, or a raced bump since planning re-routes to skip.
      const fresh = await getListing(p.recordId);
      if (
        !fresh ||
        (fresh.outreachStatus ?? "").trim() !== "Texted" ||
        (fresh.lastInboundAt && fresh.lastInboundAt.trim() !== "") ||
        (fresh.followUpCount ?? 0) !== p.attempt - 1 ||
        fresh.doNotText === true
      ) {
        row.error = "stale_state: record changed since planning";
        summary.stale_state_skipped++;
        if (claimAcquired) await kvProd.del(claimKey).catch(() => {});
        processed.push(row);
        continue;
      }

      // ── THREAD TRUTH (2026-07-17, the 7714 E Canfield miss): our record
      // can be blind — a capture gap left two agent counters uningested, the
      // record read "silent", and this lane bumped into a live conversation
      // until the agent asked "Are you not getting my texts?". So ask Quo
      // DIRECTLY: ANY incoming message in this thread disqualifies a
      // robo-bump, no matter what Airtable says. On a hit, heal the record
      // from thread truth (the deep sync ingests the message properly).
      // Fail CLOSED on a Quo error — a skipped bump costs nothing; a bump
      // over a human reply costs the relationship.
      const existingNotes = fresh.notes ?? byId.get(p.recordId)?.notes ?? null;
      let truth: ReturnType<typeof threadInboundTruth>;
      try {
        const threadMsgs = await getMessagesForParticipant(p.toE164, THREAD_TRUTH_LOOKBACK_MIN);
        truth = threadInboundTruth(threadMsgs);
      } catch (err) {
        row.error = `quo_thread_truth_unavailable: ${String(err).slice(0, 120)}`;
        summary.errors++;
        if (claimAcquired) await kvProd.del(claimKey).catch(() => {});
        processed.push(row);
        continue;
      }
      if (truth.hasInbound) {
        row.error = "thread_has_inbound: bump aborted, record healed from Quo thread truth";
        summary.thread_truth_aborted++;
        try {
          await updateListingRecord(p.recordId, {
            Outreach_Status: "Response Received",
            Last_Inbound_At: truth.lastInboundAt ?? iso,
            Verification_Notes: buildBumpAbortedNote(existingNotes, iso, truth.lastInboundAt, truth.lastInboundBody),
          });
          row.airtable_updated = true;
        } catch (err) {
          row.error += ` (heal write failed: ${String(err).slice(0, 100)})`;
        }
        await audit({
          agent: "crier",
          event: "h2_bump_thread_truth_abort",
          status: "confirmed_success",
          recordId: p.recordId,
          inputSummary: { phone_masked: `…${p.toE164.slice(-4)}`, attempt: p.attempt },
          outputSummary: {
            inbound_at: truth.lastInboundAt,
            inbound_excerpt: truth.lastInboundBody?.slice(0, 140) ?? null,
            healed: row.airtable_updated,
          },
        });
        if (claimAcquired) await kvProd.del(claimKey).catch(() => {});
        processed.push(row);
        continue;
      }

      // ── >85%-of-list rail vs the CURRENT list price. A list cut deep
      // enough to trip it means the sticky number is now over-rich for the
      // market — a human decision, not a robo-bump.
      const economics = checkOfferOverList(p.message, fresh.listPrice ?? null);
      if (!economics.ok) {
        // Claim is KEPT (mirrors h2-outreach): the block re-evaluates after
        // the claim TTL, not on every run — no daily audit spam.
        row.error = `economics_block: ${economics.blockedBecause}`;
        summary.errors++;
        await audit({
          agent: "crier",
          event: "h2_bump_economics_blocked",
          status: "confirmed_failure",
          recordId: p.recordId,
          inputSummary: { offer: economics.offerAmount, list: economics.listPrice, ratio: economics.ratio },
          outputSummary: { reason: economics.blockedBecause },
        });
        processed.push(row);
        continue;
      }

      // ── SEND + positive confirmation (same posture as first touch) ──
      const result = await sendMessageWithId(p.toE164, p.message);
      row.sms_fired = true;
      row.sms_message_id = result.id;

      let delivered = false;
      let terminalFailure = false;
      let confirmedStatus: string | null = result.status ?? null;
      if (result.id) {
        for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
          await sleep(POLL_DELAY_MS);
          try {
            const st = await getMessageStatus(result.id);
            confirmedStatus = st.status;
            if (st.isTerminal) {
              delivered = st.isSuccess;
              terminalFailure = !st.isSuccess;
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

      if (delivered) {
        // Status stays "Texted" — the thread is still awaiting its FIRST
        // reply; the bump position lives in Follow_Up_Count + the stamp.
        await updateListingRecord(p.recordId, {
          Last_Outbound_At: iso,
          Follow_Up_Count: p.attempt,
          Verification_Notes: buildBumpSentNote(existingNotes, iso, p.attempt, result.id, p.message),
        });
        row.delivered = true;
        row.airtable_updated = true;
        summary.bumped++;
      } else if (terminalFailure) {
        await updateListingRecord(p.recordId, {
          Outreach_Status: "Dead",
          Verification_Notes: buildDeliveryQuarantineNote(existingNotes, iso, p.toE164, confirmedStatus),
        });
        row.airtable_updated = true;
        summary.delivery_quarantined++;
        await audit({
          agent: "crier",
          event: "h2_bump_delivery_quarantine",
          status: "confirmed_failure",
          recordId: p.recordId,
          externalId: result.id ?? undefined,
          inputSummary: { phone: p.toE164, confirmedStatus },
          outputSummary: { quarantined: true, reason: `carrier ${confirmedStatus ?? "undelivered"}` },
        });
        if (claimAcquired) await kvProd.del(claimKey).catch(() => {});
      } else {
        summary.unconfirmed++; // claim kept — a re-bump is worse than a stale count
      }
      if (sendDelayMs > 0) await sleep(sendDelayMs);
    } catch (err) {
      row.error = err instanceof Error ? err.message : String(err);
      summary.errors++;
      if (claimAcquired && !row.sms_fired) {
        await kvProd.del(claimKey).catch(() => {});
      }
    }
    processed.push(row);
  }

  await audit({
    agent: "crier",
    event: dryRun ? "h2_bump_dry_run" : "h2_bump_live",
    status: summary.errors > 0 ? "uncertain" : "confirmed_success",
    inputSummary: { auth_kind: authKind, dry_run: dryRun, limit, live_env: liveEnv },
    outputSummary: {
      due_total: due.length,
      planned: plans.length,
      processed: processed.length,
      ...summary,
      send_cap: sendCapSummary,
    },
    ms: Date.now() - t0,
  });

  if (runLockHeld) await kvProd.del(RUN_LOCK_KEY).catch(() => {});

  return NextResponse.json({
    mode: dryRun ? "dry_run" : "live",
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    due_total: due.length,
    planned: plans.length,
    plan_skipped: skipped,
    processed,
    summary,
    send_cap: sendCapSummary,
    opt_out_enforcement_live: optOutEnforcementLive,
    auth_kind: authKind,
    duration_ms: Date.now() - t0,
  });
}

export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}
