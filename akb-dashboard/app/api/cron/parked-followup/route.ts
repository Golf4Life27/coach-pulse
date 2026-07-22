// Parked-on-silence follow-up loop (Maverick 2026-06-14 rebuild-stale-
// deal-handling). @agent: orchestrator
//
// THE ONLY SCHEDULE TOUCHING AGING NON-RESPONSIVE DEALS. Replaces the old
// stale-deal-triage cron (removed in commit 418bdfe) under the core economic
// rule: non-responses must be free.
//
// What this fires on each daily tick:
//   1. Pull every Texted ∪ Parked record (the "aging non-responsive" cohort).
//   2. Run the existing d3-scrub + d3-cadence classifier (no parallel build,
//      no new decision logic — just a fresh schedule constant: [30, 30]
//      gap-based, auto-dead at 30d after the final send).
//   3. For each send_follow_up_attempt_1 / _2 verdict:
//        a. Single cheap Firecrawl probe right before the text (the "liveness
//           rides with the follow-up" half of the spec — no standalone
//           liveness cron). If inactive → dispose, never spend the SMS.
//        b. Quiet-hours floor (8–20 property-local; non-disableable).
//        c. Send via lib/quo.sendMessage.
//        d. Flip Outreach_Status to Parked (explicit cold-loop label),
//           stamp Last_Outbound_At + Last_Outreach_Date, increment
//           Follow_Up_Count, annotate.
//   4. For each auto_dead_followup_timeout verdict: dispose (Pipeline_Stage
//      → dead via the stage engine, Outreach_Status → Dead).
//   5. Everything else (wait_in_cadence, holds, no_actions): report-only.
//
// COST per parked lead per month: ~$0.02 (one SMS + one Firecrawl probe per
// follow-up tick, max 2 attempts). NO paid data API in this loop — the
// initial underwrite is V21-fresh's job; the reply re-price is the reply
// trigger's. This loop is silence-only.
//
// SCOPED SEND LIFT: H2_OUTREACH_HARD_DISABLE stays ON for outreach-fire
// and h2-outreach (the cold-opener paths). This route uses a SEPARATE,
// independently-certified flag FOLLOWUP_SEND_ENABLED (default off).
//
// Why two flags instead of reusing the hard-disable: the follow-up loop is
// the only autonomous SMS path that fires while the main switch is off.
// Sharing the flag would couple two launches that must sequence separately
// — flipping the opener firehose on must NOT simultaneously blast 30/60-day
// nudges at the unreviewed parked backlog. Each path gets its own opt-in.
// Main hard-disable governs openers; this flag governs follow-ups.
//
// GET /api/cron/parked-followup
//   ?apply=1       actually send + write (default: dry-run report)
//   ?limit=N       cap records ACTED ON per tick (default 20)
//   ?include_texted=0  parked-only sweep (skip Texted records still in
//                  the original outreach window). Default: include both.

import { NextResponse } from "next/server";
import { audit } from "@/lib/audit-log";
import { getListings, updateListingRecord } from "@/lib/airtable";
import { classifyTexted } from "@/lib/d3-scrub";
import {
  classifyCadence,
  type CadenceDecision,
  type AgentInteractionMap,
  type RecentlyTouchedAgentMap,
} from "@/lib/d3-cadence";
import { normalizePhone } from "@/lib/phone-normalize";
import { sendMessage } from "@/lib/quo";
import { verifyListing } from "@/lib/crawler/sources/firecrawl";
import { classifyVerifiedListing } from "@/lib/crawler/sources/firecrawl";
import { evaluateSendWindow } from "@/lib/h2-working-hours";
import { transitionStage } from "@/lib/pipeline-state/engine";
import {
  authenticate,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import cadenceConfig from "@/lib/config/d3-cadence.json";
import type { Listing } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const DEFAULT_LIMIT = 20;
const BUDGET_MS = 270_000;
// Throttle between SMS sends (mirrors outreach-fire's pacing).
const SMS_THROTTLE_MS = 30_000;
const RECENT_TOUCHED_WINDOW_DAYS = cadenceConfig.config.recently_touched_window_days;

// The send-posture flag — scoped lift on H2_OUTREACH_HARD_DISABLE for THIS
// path only. Defaults OFF (dry-run report) — operator flips on after a
// watched first run, same posture pattern as V21-fresh.
const isFollowupSendEnabled = () => process.env.FOLLOWUP_SEND_ENABLED === "true";

// Outreach_Status values the parked-on-silence loop pulls from. Texted is
// the standard active outreach cohort that ages into silence; Parked is
// the explicit cold-loop label set by THIS cron on the first follow-up.
const PARKED_ELIGIBLE_STATUSES = new Set(["Texted", "Parked"]);

interface SendOutcome {
  recordId: string;
  address: string;
  action: string;
  status:
    | "sent"
    | "disposed_inactive"
    | "disposed_timeout"
    | "skipped_dry_run"
    | "skipped_quiet_hours"
    | "skipped_firecrawl_infra"
    | "skipped_no_phone"
    | "skipped_other"
    | "send_failed"
    | "dispose_failed"
    | "reported";
  detail?: string;
  firecrawl?: { creditsUsed: number; stillActive: boolean | null; outcome: string };
}

function toE164(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

function formatOffer(offerAmount: number): string {
  return "$" + offerAmount.toLocaleString("en-US");
}

function appendNote(existing: string | null | undefined, newNote: string): string {
  const today = new Date().toLocaleDateString("en-US", {
    month: "numeric", day: "numeric", year: "2-digit",
  });
  const stamped = `${today} — [Parked-Followup] ${newNote}`;
  return existing ? `${existing}\n\n${stamped}` : stamped;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Build the agent-interaction maps the cadence classifier needs (warm-
 *  contact gates). Same shape as /api/admin/d3-cadence builds. */
function buildAgentMaps(allListings: Listing[], now: Date): {
  agentInteractionMap: AgentInteractionMap;
  recentlyTouchedAgentMap: RecentlyTouchedAgentMap;
} {
  const agentInteractionMap: AgentInteractionMap = new Map();
  for (const l of allListings) {
    const status = (l.outreachStatus ?? "").toLowerCase();
    if (status !== "texted" && status !== "negotiating" && status !== "parked") continue;
    const normalized = normalizePhone(l.agentPhone);
    if (!normalized) continue;
    const existing = agentInteractionMap.get(normalized);
    if (existing) { existing.count++; existing.listingIds.push(l.id); }
    else agentInteractionMap.set(normalized, { count: 1, listingIds: [l.id] });
  }

  const cutoffMs = now.getTime() - RECENT_TOUCHED_WINDOW_DAYS * 24 * 60 * 60_000;
  const recentlyTouchedAgentMap: RecentlyTouchedAgentMap = new Map();
  for (const l of allListings) {
    const lod = l.lastOutreachDate;
    if (!lod) continue;
    const m = lod.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) continue;
    const ts = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (isNaN(ts) || ts < cutoffMs) continue;
    const normalized = normalizePhone(l.agentPhone);
    if (!normalized) continue;
    const status = l.outreachStatus ?? "(unset)";
    const existing = recentlyTouchedAgentMap.get(normalized);
    if (existing) {
      existing.listingIds.push(l.id);
      existing.statuses.push(status);
      if (lod > existing.mostRecentTouchedDate) existing.mostRecentTouchedDate = lod;
    } else {
      recentlyTouchedAgentMap.set(normalized, {
        listingIds: [l.id], statuses: [status], mostRecentTouchedDate: lod,
      });
    }
  }
  return { agentInteractionMap, recentlyTouchedAgentMap };
}

/** Format the address for Firecrawl in the same shape verifyListing wants. */
function formatAddressForFirecrawl(l: Listing): string | null {
  if (!l.address || !l.city || !l.state || !l.zip) return null;
  return `${l.address}, ${l.city}, ${l.state} ${l.zip}`;
}

/** Build the follow-up SMS body. Stored OfferPrice — NEVER recompute lower
 *  (offer discipline). The template files in scripts/outreach/ document
 *  the intended tone; this is the body text. */
function buildFollowUpText(
  l: Listing,
  attemptNumber: 1 | 2,
): { text: string; offerNum: number } | { text: null; reason: string } {
  const firstName = (l.agentName ?? "there").split(" ")[0] || "there";
  // Sticky offer (INV-030 / INVARIANTS §3, tightened 2026-07-22): a
  // re-engagement inherits ONLY the stored, delivery-stamped, value-anchored
  // opener — never a recomputed number and never a fraction of list. The old
  // 65%-of-list fallback here was the retired Blackmoor rail hiding in a live
  // sender: a parked deal with no stored offer would get texted 0.65×list.
  // Removed — no stored value-anchored offer → REFUSE (HOLD), never fabricate
  // a list-anchored number into a parked deal.
  const offerNum = typeof l.outreachOfferPrice === "number" && l.outreachOfferPrice > 0
    ? l.outreachOfferPrice : null;
  if (offerNum == null) {
    return { text: null, reason: "no_stored_value_anchored_offer" };
  }
  const offer = formatOffer(offerNum);
  // Pending Alex-drafted copy in scripts/outreach/follow_up_attempt_*.md —
  // until those are approved this uses a conservative bridge that matches
  // the template intent (stored offer, no lowered number, single soft ask).
  // The intent here is: a real, sendable text on day-1 of the loop, not a
  // placeholder. Operator can swap copy without code changes.
  const text =
    attemptNumber === 1
      ? `Hey ${firstName}, Alex with AKB Solutions — circling back on ${l.address}. Cash offer of ${offer} still on the table if you want to revisit. No pressure.`
      : `Hi ${firstName}, last check from me on ${l.address}. ${offer} cash, quick close — if it's not the right fit just let me know, otherwise the door's open.`;
  return { text, offerNum };
}

export async function GET(req: Request) {
  const t0 = Date.now();
  const url = new URL(req.url);
  const apply = url.searchParams.get("apply") === "1";
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : DEFAULT_LIMIT;
  const includeTexted = url.searchParams.get("include_texted") !== "0";

  // Auth waterfall.
  const env = readAuthEnv();
  const headers = readAuthHeaders(req);
  const auth = await authenticate(headers, env, kvProd);
  if (!auth.ok) {
    return NextResponse.json(
      { error: "unauthorized", reason: auth.reason, message: "CRON_SECRET or OAuth required." },
      { status: 401 },
    );
  }
  if (auth.kind === "cron" && process.env.MAVERICK_CRON_ENABLED !== "true") {
    return NextResponse.json({ error: "cron_disabled" }, { status: 503 });
  }
  if (auth.kind === "oauth" && !kvConfigured()) {
    return NextResponse.json({ error: "kv_not_configured" }, { status: 500 });
  }

  // SCOPED LIFT — apply=1 requires FOLLOWUP_SEND_ENABLED=true. Default
  // (env unset) holds the cron in dry-run report. This is the operator-
  // controlled gate that lets the cron run on cron-auth without lifting
  // the global H2_OUTREACH_HARD_DISABLE flag for any other send path.
  const sendEnabled = isFollowupSendEnabled();
  const effectiveApply = apply && sendEnabled;

  let listings: Listing[];
  try {
    listings = await getListings();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "fetch_failed", message: msg }, { status: 502 });
  }

  const cohort = listings.filter((l) => {
    const status = l.outreachStatus ?? "";
    if (!PARKED_ELIGIBLE_STATUSES.has(status)) return false;
    if (!includeTexted && status === "Texted") return false;
    if (l.doNotText) return false;
    return true;
  });

  const now = new Date();
  const { agentInteractionMap, recentlyTouchedAgentMap } = buildAgentMaps(listings, now);

  // Classify everyone first (cheap, pure).
  const decisions: Array<{ listing: Listing; decision: CadenceDecision }> = cohort.map((l) => {
    const scrub = classifyTexted(l);
    const decision = classifyCadence({
      listing: l,
      bucket: scrub.bucket,
      agentInteractionMap,
      recentlyTouchedAgentMap,
      now,
    });
    return { listing: l, decision };
  });

  // Split into the action queue (sends + disposes) and report-only.
  const SEND_ACTIONS = new Set(["send_follow_up_attempt_1", "send_follow_up_attempt_2", "send_follow_up_drift_down"]);
  const DISPOSE_ACTIONS = new Set(["auto_dead_followup_timeout", "auto_dead_status_check_timeout"]);
  const actionable = decisions.filter(
    ({ decision }) => SEND_ACTIONS.has(decision.action) || DISPOSE_ACTIONS.has(decision.action),
  );

  const outcomes: SendOutcome[] = [];
  let acted = 0;
  let sent = 0;
  let disposed = 0;
  let failed = 0;
  let firecrawlCreditsUsed = 0;
  const reportOnly = decisions.length - actionable.length;

  for (const { listing, decision } of actionable) {
    if (acted >= limit) break;
    if (Date.now() - t0 > BUDGET_MS) break;

    // ── DISPOSE PATHS (no SMS, no Firecrawl) ────────────────────────
    if (DISPOSE_ACTIONS.has(decision.action)) {
      if (!effectiveApply) {
        outcomes.push({
          recordId: listing.id,
          address: listing.address,
          action: decision.action,
          status: "reported",
          detail: `[dry-run] would dispose: ${decision.reasoning}`,
        });
        acted++;
        continue;
      }
      try {
        const tr = await transitionStage({
          recordId: listing.id,
          to: "dead",
          reason: `parked-followup ${decision.action}: ${decision.reasoning}`,
          attribution: "orchestrator",
          triggered_by: "d3",
        });
        if (!tr.ok) {
          outcomes.push({
            recordId: listing.id,
            address: listing.address,
            action: decision.action,
            status: "dispose_failed",
            detail: `stage transition ${tr.outcome}: ${tr.message}`,
          });
          failed++;
          acted++;
          continue;
        }
        await updateListingRecord(listing.id, {
          Outreach_Status: "Dead",
          Verification_Notes: appendNote(listing.notes, `Auto-disposed: ${decision.reasoning}`),
        });
        outcomes.push({
          recordId: listing.id,
          address: listing.address,
          action: decision.action,
          status: "disposed_timeout",
          detail: decision.reasoning,
        });
        disposed++;
      } catch (err) {
        outcomes.push({
          recordId: listing.id,
          address: listing.address,
          action: decision.action,
          status: "dispose_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        failed++;
      }
      acted++;
      continue;
    }

    // ── SEND PATH ────────────────────────────────────────────────────
    // SAFETY GATE 1: quiet hours floor (non-disableable, mirrors outreach-fire).
    const wh = evaluateSendWindow(listing.state ?? null);
    if (!wh.inside) {
      outcomes.push({
        recordId: listing.id,
        address: listing.address,
        action: decision.action,
        status: "skipped_quiet_hours",
        detail: `local_hour=${wh.meta.local_hour} tz=${wh.meta.timezone}`,
      });
      acted++;
      continue;
    }

    // SAFETY GATE 2: phone present (defensive — scrub usually catches).
    if (!listing.agentPhone) {
      outcomes.push({ recordId: listing.id, address: listing.address, action: decision.action, status: "skipped_no_phone" });
      acted++;
      continue;
    }

    // SAFETY GATE 3: FIRECRAWL LIVENESS (the "liveness rides with the
    // follow-up" half of the spec). Single cheap probe right before the
    // text. INFRA failures never dispose (mirrors reverify-queue's
    // safety invariant); only an explicit firecrawl_inactive verdict
    // does. Skip the send on infra failure — operator gets to see it,
    // record stays parked.
    const formattedAddr = formatAddressForFirecrawl(listing);
    const fc = formattedAddr ? await verifyListing(formattedAddr).catch(() => null) : null;
    if (fc) firecrawlCreditsUsed += fc.creditsUsed ?? 0;
    const fcVerdict = fc ? classifyVerifiedListing(fc) : null;

    if (fcVerdict && fcVerdict.outcome === "reject" && fcVerdict.reason === "firecrawl_inactive") {
      // EXPLICIT inactive verdict — dispose, skip the SMS spend.
      if (!effectiveApply) {
        outcomes.push({
          recordId: listing.id,
          address: listing.address,
          action: decision.action,
          status: "reported",
          detail: "[dry-run] firecrawl_inactive — would dispose instead of sending",
          firecrawl: { creditsUsed: fc?.creditsUsed ?? 0, stillActive: fc?.stillActive ?? null, outcome: fcVerdict.outcome },
        });
        acted++;
        continue;
      }
      try {
        const tr = await transitionStage({
          recordId: listing.id,
          to: "dead",
          reason: "parked-followup pre-send liveness: firecrawl_inactive",
          attribution: "orchestrator",
          triggered_by: "d3",
        });
        if (tr.ok) {
          await updateListingRecord(listing.id, {
            Outreach_Status: "Dead",
            Verification_Notes: appendNote(listing.notes, "Pre-send Firecrawl: listing no longer active. Disposed before SMS spend."),
          });
          outcomes.push({
            recordId: listing.id,
            address: listing.address,
            action: decision.action,
            status: "disposed_inactive",
            firecrawl: { creditsUsed: fc?.creditsUsed ?? 0, stillActive: false, outcome: fcVerdict.outcome },
          });
          disposed++;
        } else {
          outcomes.push({
            recordId: listing.id,
            address: listing.address,
            action: decision.action,
            status: "dispose_failed",
            detail: tr.message,
          });
          failed++;
        }
      } catch (err) {
        outcomes.push({
          recordId: listing.id,
          address: listing.address,
          action: decision.action,
          status: "dispose_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        failed++;
      }
      acted++;
      continue;
    }

    // FC infra failure (no creds / rate-limited / transport / unresolved
    // URL) — never demote. Skip the send so we don't text into the void.
    const isFcInfraFailure =
      fcVerdict?.outcome === "reject" &&
      fcVerdict.reason !== "firecrawl_inactive" &&
      fcVerdict.reason !== "new_construction_excluded" &&
      fcVerdict.reason !== "wholesaler_excluded" &&
      fcVerdict.reason !== "firecrawl_renovated";
    if (isFcInfraFailure || !fcVerdict) {
      outcomes.push({
        recordId: listing.id,
        address: listing.address,
        action: decision.action,
        status: "skipped_firecrawl_infra",
        detail: fcVerdict ? `firecrawl reason=${fcVerdict.reason} — infra failure, not a listing verdict; skipping send, record stays parked`
                          : "firecrawl probe could not run (no address parts or call threw) — skipping send",
        firecrawl: fc ? { creditsUsed: fc.creditsUsed ?? 0, stillActive: fc.stillActive ?? null, outcome: fcVerdict?.outcome ?? "noop" } : undefined,
      });
      acted++;
      continue;
    }

    // Build the message body.
    const attemptNumber = decision.action === "send_follow_up_attempt_1" ? 1 : 2;
    const built = buildFollowUpText(listing, attemptNumber);
    if (built.text == null) {
      outcomes.push({
        recordId: listing.id,
        address: listing.address,
        action: decision.action,
        status: "skipped_other",
        detail: `text-build refused: ${(built as { reason: string }).reason}`,
      });
      acted++;
      continue;
    }

    if (!effectiveApply) {
      outcomes.push({
        recordId: listing.id,
        address: listing.address,
        action: decision.action,
        status: "skipped_dry_run",
        detail:
          (!sendEnabled
            ? "[dry-run] FOLLOWUP_SEND_ENABLED!=true — would send: "
            : "[dry-run] apply!=1 — would send: ") + JSON.stringify(built.text),
        firecrawl: { creditsUsed: fc?.creditsUsed ?? 0, stillActive: true, outcome: "accept" },
      });
      acted++;
      continue;
    }

    // ── REAL SEND ────────────────────────────────────────────────────
    const phone = toE164(listing.agentPhone);
    try {
      await sendMessage(phone, built.text);
      const nowIso = new Date().toISOString();
      await updateListingRecord(listing.id, {
        Outreach_Status: "Parked",
        Last_Outbound_At: nowIso,
        Last_Outreach_Date: nowIso.split("T")[0],
        Follow_Up_Count: (listing.followUpCount ?? 0) + 1,
        Verification_Notes: appendNote(
          listing.notes,
          `Sent ${decision.action} to ${listing.agentName ?? "agent"} at ${phone}. Offer: ${formatOffer(built.offerNum)}. Body: ${built.text}`,
        ),
      });
      outcomes.push({
        recordId: listing.id,
        address: listing.address,
        action: decision.action,
        status: "sent",
        detail: `${formatOffer(built.offerNum)} → ${phone}`,
        firecrawl: { creditsUsed: fc?.creditsUsed ?? 0, stillActive: true, outcome: "accept" },
      });
      sent++;
      acted++;
      // Pace the next send (mirrors outreach-fire). Skip if we're past
      // budget — the budget guard at the top of the loop will catch us.
      if (acted < limit && Date.now() - t0 < BUDGET_MS - SMS_THROTTLE_MS) {
        await sleep(SMS_THROTTLE_MS);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      outcomes.push({
        recordId: listing.id,
        address: listing.address,
        action: decision.action,
        status: "send_failed",
        detail: msg,
        firecrawl: { creditsUsed: fc?.creditsUsed ?? 0, stillActive: true, outcome: "accept" },
      });
      failed++;
      acted++;
    }
  }

  const summary = {
    cohort_total: cohort.length,
    classified: decisions.length,
    actionable: actionable.length,
    acted,
    sent,
    disposed,
    failed,
    report_only: reportOnly,
    firecrawl_credits_used: firecrawlCreditsUsed,
  };

  await audit({
    agent: "orchestrator",
    event: apply ? "parked_followup_apply" : "parked_followup_dry_run",
    status: failed > 0 ? "uncertain" : "confirmed_success",
    inputSummary: {
      auth_kind: auth.kind,
      apply,
      effective_apply: effectiveApply,
      send_enabled: sendEnabled,
      limit,
      include_texted: includeTexted,
    },
    outputSummary: summary,
    ms: Date.now() - t0,
  });

  return NextResponse.json({
    mode: effectiveApply ? "apply" : (sendEnabled ? "dry_run_apply_off" : "dry_run_send_disabled"),
    note:
      effectiveApply
        ? "FOLLOWUP_SEND_ENABLED=true AND ?apply=1 — real sends + writes."
        : (sendEnabled
            ? "FOLLOWUP_SEND_ENABLED=true but ?apply=1 not set — report only."
            : "FOLLOWUP_SEND_ENABLED unset/false — report only regardless of ?apply. Scoped lift on H2_OUTREACH_HARD_DISABLE is currently OFF."),
    summary,
    outcomes,
    elapsed_ms: Date.now() - t0,
  });
}
