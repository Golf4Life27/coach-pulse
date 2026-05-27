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
import { sendMessageWithId } from "@/lib/quo";
import { audit } from "@/lib/audit-log";
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
  selectH2Eligible,
  buildPriorContactIndex,
  planQueue,
  buildSentNote,
  buildStallNote,
  buildQuarantineNote,
  type H2Plan,
} from "@/lib/h2-outreach";
import {
  evaluateWorkingHours,
  parseWorkingHoursConfig,
  type WorkingHoursMeta,
} from "@/lib/h2-working-hours";
import { SOURCE_VERSION_V2 } from "@/lib/source-version";

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

interface ProcessedRow {
  record_id: string;
  address: string;
  agent_name: string | null;
  agent_phone: string | null;
  route: H2Plan["route"] | "outside_hours";
  message: string | null;
  sms_fired: boolean;
  sms_message_id: string | null;
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
  if (authKind === "cron" && process.env.MAVERICK_CRON_ENABLED !== "true") {
    return NextResponse.json({ error: "cron_disabled" }, { status: 503 });
  }

  // ── Params + the dry-run / live gate ─────────────────────────────
  const liveEnv = process.env.H2_OUTREACH_LIVE === "true";
  const dryRunParam = url.searchParams.get("dry_run") === "false" ? false : true;
  const dryRun = !liveEnv || dryRunParam; // a send needs liveEnv AND ?dry_run=false

  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(MAX_LIMIT, Math.floor(limitRaw))
    : DEFAULT_LIMIT;
  const recordId = url.searchParams.get("record_id");
  const sendDelayRaw = Number(url.searchParams.get("send_delay_ms"));
  const sendDelayMs = Number.isFinite(sendDelayRaw) && sendDelayRaw >= 0
    ? Math.floor(sendDelayRaw)
    : DEFAULT_SEND_DELAY_MS;

  // Working-hours gate config (INV-H2-WORKING-HOURS). Defaults 8am–8pm,
  // all 7 days, enabled — env-tunable without code changes.
  const whConfig = parseWorkingHoursConfig({
    enabled: process.env.H2_WORKING_HOURS_ENABLED,
    start: process.env.H2_WORKING_HOURS_START,
    end: process.env.H2_WORKING_HOURS_END,
    days: process.env.H2_WORKING_HOURS_DAYS,
  });

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
          airtable_updated: false,
          error: `ineligible: ${reason}`,
        }],
        summary: { first_touch_sent: 0, prior_contact_stalled: 0, bad_phone_quarantined: 0, outside_hours: 0, skipped: 1, errors: 0 },
        auth_kind: authKind,
        duration_ms: Date.now() - t0,
      });
    }
    queue = [target];
  } else {
    queue = selectH2Eligible(allListings).slice(0, limit);
  }

  const eligibleCount = recordId ? queue.length : selectH2Eligible(allListings).length;
  const priorIndex = buildPriorContactIndex(allListings);
  const plans = planQueue(queue, priorIndex);
  const byId = new Map(queue.map((l) => [l.id, l] as const));

  const startedAt = new Date(t0).toISOString();
  const processed: ProcessedRow[] = [];
  const summary = {
    first_touch_sent: 0,
    prior_contact_stalled: 0,
    bad_phone_quarantined: 0,
    outside_hours: 0,
    skipped: 0,
    idempotent_skipped: 0,
    errors: 0,
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

  for (const p of plans) {
    const row: ProcessedRow = {
      record_id: p.recordId,
      address: p.address,
      agent_name: p.agentName,
      agent_phone: p.route === "first_touch" ? p.toE164 : p.agentPhoneRaw,
      route: p.route,
      message: p.message,
      sms_fired: false,
      sms_message_id: null,
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
    if (p.route === "first_touch" && whConfig.enabled) {
      const wh = evaluateWorkingHours(listing?.state ?? null, whConfig);
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
          const result = await sendMessageWithId(p.toE164!, p.message!);
          row.sms_fired = true;
          row.sms_message_id = result.id;
          await updateListingRecord(p.recordId, {
            Outreach_Status: "Texted",
            Verification_Notes: buildSentNote(existingNotes, iso, result.id, p.message!),
          });
          row.airtable_updated = true;
          summary.first_touch_sent++;
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
    outputSummary: { eligible_count: eligibleCount, processed: processed.length, ...summary },
    ms: Date.now() - t0,
  });

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
