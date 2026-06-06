// Stale-deal self-triage worker — 2026-06-05.
// @agent: orchestrator
//
// GET/POST /api/cron/stale-deal-triage
//   ?apply=1   actually write (dispose / annotate). DEFAULT is dry-run —
//              a disposal moves a record to the terminal `dead` stage, so
//              the cron fires apply=1 explicitly and a bare manual GET is
//              a safe preview.
//   ?limit=N   max records to act on this invocation (default 50; the 26
//              stale deals fit in one sweep).
//   ?days=N    staleness threshold (default 14, matches Pulse's
//              stale-data-drift detector).
//
// THE PROBLEM: ~26 active-pipeline deals have had no inbound/outbound
// movement in >14 days (oldest 2119 Palo Alto, 65d). They keep Pulse's
// stale-data-drift alert lit and clog the active view. This worker is the
// durable, self-driving cleaner: on its own schedule it classifies each
// stale record into one of three states and acts — zero manual pushes.
//
//   dispose_dead    → transition to `dead` via the stage engine (the sole
//                     Pipeline_Stage writer), set Outreach_Status=Dead so
//                     it leaves the active population, annotate the record
//                     with the dispose REASON, and audit. As these drain,
//                     Pulse's stale count falls on its own — that's the
//                     proof the system cleans itself.
//   reengage_queue  → FLAG ONLY. Annotate "re-engage-eligible" + audit.
//                     Queuing is NOT sending; outreach stays hard-disabled;
//                     nothing transmits here.
//   hold            → write the blocking reason to the record for operator
//                     review. Never dispose on a guess.
//
// Conservative by construction: disposal fires only on a HARD terminal
// signal (delisted / declined reply / a fully-computed NEGATIVE landlord
// MAO). Ambiguous → HOLD. A null/uncomputable MAO never disposes.
//
// Idempotent + durable: a record already carrying the STALE-TRIAGE
// sentinel in Verification_Notes is skipped, so re-running the cron over
// the same cohort produces zero duplicate writes. Disposed records leave
// the active population (Outreach_Status=Dead) and never recur.
//
// Auth: the standard waterfall with CRON_SECRET (Authorization: Bearer +
// x-vercel-cron:1) or an OAuth access token. Mirrors
// /api/cron/pipeline-state-backfill-sweep.

import { NextResponse } from "next/server";
import { audit } from "@/lib/audit-log";
import { getActiveListingsForBrief, updateListingRecord } from "@/lib/airtable";
import { findStaleListings } from "@/lib/pulse/detectors/stale-data-drift";
import { transitionStage } from "@/lib/pipeline-state/engine";
import { getRentEstimate, getAnnualPropertyTaxes, getRentCastAssessedValue } from "@/lib/rentcast";
import { isNeverResurfaceLoose } from "@/lib/never-resurface";
import {
  computeV21LandlordMao,
  defaultInvestorCapFor,
  resolveAnnualTaxes,
  buildMaoV21Marker,
  upsertMaoV21Marker,
  type V21MaoResult,
} from "@/lib/landlord-hydrate";
import {
  detectDecline,
  isStale,
  classifyStaleDeal,
  alreadyTriaged,
  buildTriageNote,
  appendTriageNote,
  STALE_DAYS_DEFAULT,
  type StaleClassifyResult,
} from "@/lib/stale-triage";
import {
  authenticate,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import type { Listing } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 120;

const DEFAULT_LIMIT = 50;
// Wide window so the active-population fetch includes long-cold
// Texted/Emailed records (the brief's default 7d window would hide the
// very records we're triaging). findStaleListings then applies the real
// >days staleness cut over the 4-field max-touch, exactly as Pulse does.
const POPULATION_RECENT_DAYS = 3650;

// Outreach_Status values that mean the agent/seller engaged at all.
// Used to derive `hasResponded` for the classifier.
const RESPONDED_STATUSES = new Set([
  "Response Received",
  "Counter Received",
  "Negotiating",
  "Offer Accepted",
]);

// MLS statuses that mean the listing is GONE (not for sale). Conservative:
// only an EXPLICIT gone-status flips mlsActive false; empty/unknown is
// treated as still-active so we never dispose on missing data.
const MLS_GONE = [
  "sold",
  "closed",
  "pending",
  "under contract",
  "off market",
  "off-market",
  "withdrawn",
  "expired",
  "cancelled",
  "canceled",
  "terminated",
];

function mlsIsActive(mlsStatus: string | null | undefined): boolean {
  if (!mlsStatus) return true; // unknown → don't dispose on missing data
  const lc = mlsStatus.toLowerCase();
  return !MLS_GONE.some((g) => lc.includes(g));
}

function liveIsActive(liveStatus: string | null | undefined): boolean {
  // Only an explicit non-"Active" value disposes; empty/unknown stays active.
  if (!liveStatus || liveStatus.trim() === "") return true;
  return liveStatus === "Active";
}

interface TriageParams {
  apply: boolean;
  limit: number;
  days: number;
}

function parseParams(req: Request): TriageParams {
  const url = new URL(req.url);
  const apply = url.searchParams.get("apply") === "1";
  const limRaw = url.searchParams.get("limit");
  const daysRaw = url.searchParams.get("days");
  const limit = limRaw && /^\d+$/.test(limRaw) ? parseInt(limRaw, 10) : DEFAULT_LIMIT;
  const days = daysRaw && /^\d+$/.test(daysRaw) ? parseInt(daysRaw, 10) : STALE_DAYS_DEFAULT;
  return { apply, limit, days };
}

interface RecordOutcome {
  recordId: string;
  address: string;
  daysSinceMovement: number | null;
  verdict: StaleClassifyResult["verdict"];
  disposeCategory: StaleClassifyResult["disposeCategory"];
  reason: string;
  action: "disposed" | "annotated_reengage" | "annotated_hold" | "skipped_already_triaged" | "preview" | "dispose_failed";
  detail?: string;
}

async function handle(req: Request, params: TriageParams) {
  const t0 = Date.now();
  const now = new Date();

  const env = readAuthEnv();
  const headers = readAuthHeaders(req);
  const auth = await authenticate(headers, env, kvProd);
  if (!auth.ok) {
    return NextResponse.json(
      {
        error: "unauthorized",
        reason: auth.reason,
        message:
          "Requires CRON_SECRET (Authorization: Bearer + x-vercel-cron:1) or a valid OAuth access token.",
      },
      { status: 401 },
    );
  }
  if (auth.kind !== "cron" && auth.kind !== "oauth") {
    return NextResponse.json(
      { error: "unauthorized", reason: "unsupported_auth_kind", message: `auth_kind=${auth.kind} not accepted` },
      { status: 401 },
    );
  }
  if (auth.kind === "oauth" && !kvConfigured()) {
    return NextResponse.json(
      { error: "kv_not_configured", message: "OAuth path requires Vercel KV." },
      { status: 500 },
    );
  }

  // 1. Active-pipeline population (wide window) → stale subset, using the
  //    SAME staleness definition Pulse's detector uses (4-field max-touch,
  //    under-contract excluded). Reusing findStaleListings keeps the
  //    worker's cohort identical to the alert it's meant to drain.
  let listings: Listing[];
  try {
    listings = await getActiveListingsForBrief({
      recentDays: POPULATION_RECENT_DAYS,
      cacheKey: `listings:stale-triage:${POPULATION_RECENT_DAYS}d`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: "population_fetch_failed", message: msg }, { status: 500 });
  }

  const stale = findStaleListings(listings, params.days, now);
  const byId = new Map(listings.map((l) => [l.id, l]));

  // ── Cohort assembly — blacklist sweep ∪ stale sweep ──────────────────
  // Blacklist matches dispose regardless of staleness (a Canon §9 fact
  // sourced from the operator-curated list). Future blacklist adds
  // self-dispose at the next cron tick without waiting for the record to
  // age into the >14d cohort. Dedupe so a record that's both blacklisted
  // AND stale is processed once.
  const staleIds = new Set(stale.map((s) => s.id));
  const blacklistedExtras = listings
    .filter((l) => isNeverResurfaceLoose(l.address) && !staleIds.has(l.id))
    .map((l) => ({ id: l.id, address: l.address, days_since_touch: -1 }));
  const work: Array<{ id: string; address: string; days_since_touch: number }> = [
    ...blacklistedExtras,
    ...stale,
  ];

  const outcomes: RecordOutcome[] = [];
  let acted = 0;

  for (const s of work) {
    if (acted >= params.limit) break;
    const listing = byId.get(s.id);
    if (!listing) continue;

    const onBlacklist = isNeverResurfaceLoose(listing.address);

    // Durability: skip records this worker has already classified, UNLESS
    // they're newly on the blacklist — a blacklist add must dispose even
    // when a prior HOLD/re-engage annotation is present.
    if (!onBlacklist && alreadyTriaged(listing.notes)) {
      outcomes.push({
        recordId: listing.id,
        address: listing.address,
        daysSinceMovement: s.days_since_touch < 0 ? null : s.days_since_touch,
        verdict: "hold",
        disposeCategory: null,
        reason: "already classified by a prior sweep (sentinel present) — skipped",
        action: "skipped_already_triaged",
      });
      continue;
    }

    // ── Extract signals ───────────────────────────────────────────────
    const isActive = liveIsActive(listing.liveStatus);
    const mlsActive = mlsIsActive(listing.mlsStatus);
    const decline = detectDecline(listing.notes);
    const hasResponded = RESPONDED_STATUSES.has(listing.outreachStatus ?? "");

    // ── V2.1 economics hydration ──────────────────────────────────────
    // Legacy Your_MAO / Investor_MAO / Real_ARV_Median are QUARANTINED;
    // we compute V2.1 fresh from SOURCED inputs (rent + county taxes +
    // sourced cap + Est_Rehab) and persist via the V21 fields/marker.
    //
    // Tax precedence (anti-regression): (1) operator/CAD-confirmed value
    // on the record WINS and is NEVER overwritten; (2) else RentCast
    // auto-fetch, gated by the TX plausibility guard (taxes/assessed
    // < 1.2% → unreliable → null → V2.1 HOLD; no fabricated dispose on
    // the $555 Bexar class). Blacklist records skip RentCast entirely.
    const addr = {
      address: listing.address ?? "",
      city: listing.city ?? "",
      state: listing.state ?? "",
      zip: listing.zip ?? "",
    };
    let monthlyRent: number | null = null;
    let rentcastTaxes: number | null = null;
    let assessedValue: number | null = null;
    if (!onBlacklist) {
      const [rentEst, rcTaxes, rcAssessed] = await Promise.all([
        getRentEstimate(addr).catch(() => null),
        getAnnualPropertyTaxes(addr).catch(() => null),
        getRentCastAssessedValue(addr).catch(() => null),
      ]);
      monthlyRent = rentEst?.rent ?? null;
      rentcastTaxes = rcTaxes;
      assessedValue = rcAssessed;
    }
    const taxResolution = resolveAnnualTaxes({
      state: listing.state,
      confirmedTaxes: listing.confirmedTaxes,
      confirmedLabel: listing.confirmedTaxesSource,
      rentcastTaxes,
      assessedValue,
    });
    const cap = defaultInvestorCapFor(listing.state, listing.zip);
    const estRehab = (listing.estRehabMid ?? listing.estRehab ?? null) as number | null;
    const v21: V21MaoResult = computeV21LandlordMao({
      monthlyRent,
      annualTaxes: taxResolution.annualTaxes,
      estRehab,
      capRate: cap,
    });
    // Only a fully-computed V2.1 MAO is a dispose-eligible signal; a HOLD
    // (missing rent/taxes/cap/rehab, or NOI≤0) → null → never disposes.
    const landlordYourMao = v21.status === "ok" ? v21.yourMao : null;

    const result = classifyStaleDeal({
      isActive,
      mlsActive,
      declined: decline.declined,
      declineMatch: decline.matched,
      hasResponded,
      landlordYourMao,
      onBlacklist,
    });

    const { daysSinceMovement } = isStale(listing, now, params.days);
    const note = buildTriageNote(result, daysSinceMovement, now);

    // V2.1 economics persistence payload — rewire the legacy fields to the
    // freshly-computed V2.1 landlord values + stamp the provenance marker
    // (the quarantine boundary). Rent is written whenever fetched (the
    // "fetchable but never persisted" gap); Investor/Your_MAO only when a
    // real V2.1 number computed. Applied on EVERY verdict so the field
    // cleanup happens regardless of dispose/hold/re-engage.
    const maoMarker = buildMaoV21Marker(
      { status: v21.status, yourMao: v21.yourMao, investorMao: v21.investorMao, cap: v21.cap, rent: monthlyRent, taxes: taxResolution.annualTaxes },
      now,
    );
    const econFields: Record<string, unknown> = {};
    if (monthlyRent != null) econFields.Estimated_Monthly_Rent = monthlyRent;
    if (v21.status === "ok") {
      // Write the CLEAN V2.1 fields — NOT Investor_MAO / Your_MAO, which are
      // read-only LEGACY FORMULA fields (writing them 422s). See the
      // economics-quarantine note in lib/airtable.ts.
      econFields.Investor_MAO_V21 = v21.investorMao;
      econFields.Your_MAO_V21 = v21.yourMao;
    } else if (taxResolution.source === "rentcast_implausible" || v21.status === "hold") {
      // Anti-regression: if a record already carries a tax-tainted V21
      // number (e.g. Callaghan's $83,100 computed against $555 taxes), and
      // the new run can't produce a clean V21 (implausible taxes / missing
      // input / etc.), NULL the stale fields so the field of record can't
      // serve a known-bad number. Confirmed-tax overrides skip this path
      // because they DO produce a clean V21.
      if (listing.yourMao != null) econFields.Your_MAO_V21 = null;
      if (listing.investorMao != null) econFields.Investor_MAO_V21 = null;
    }
    // Annual_Taxes_Confirmed is INTENTIONALLY never in econFields — the
    // cron treats it as immutable (operator/CAD-owned). Same for
    // Annual_Taxes_Source.
    const finalNotes = appendTriageNote(upsertMaoV21Marker(listing.notes, maoMarker), note);
    const econAudit = {
      monthly_rent: monthlyRent,
      annual_taxes: taxResolution.annualTaxes,
      annual_taxes_source: taxResolution.source,
      annual_taxes_label: taxResolution.confirmedLabel ?? null,
      plausibility_reason: taxResolution.plausibilityReason ?? null,
      tax_freeze_write: taxResolution.freezeWrite,
      assessed_value: assessedValue,
      investor_cap: cap,
      est_rehab: estRehab,
      v21_status: v21.status,
      v21_your_mao: v21.yourMao,
      on_blacklist: onBlacklist,
    };

    acted++;

    // ── Dry-run: report the verdict + computed economics, write nothing ─
    if (!params.apply) {
      outcomes.push({
        recordId: listing.id,
        address: listing.address,
        daysSinceMovement,
        verdict: result.verdict,
        disposeCategory: result.disposeCategory,
        reason: result.reason,
        action: "preview",
        detail: `v21_your_mao=${v21.yourMao ?? "-"} (${v21.status}; rent=${monthlyRent ?? "-"} taxes=${rentcastTaxes ?? "-"} cap=${cap ?? "-"} rehab=${estRehab ?? "-"})`,
      });
      continue;
    }

    // ── Apply ─────────────────────────────────────────────────────────
    try {
      if (result.verdict === "dispose_dead") {
        // Stage engine is the SOLE Pipeline_Stage writer. Kill edge
        // (non-terminal → dead) is always legal. Omit `current` so the
        // engine resolves the live stage itself (avoids acting on a
        // stale in-memory value).
        const tr = await transitionStage({
          recordId: listing.id,
          to: "dead",
          reason: `stale-triage dispose: ${result.reason}`,
          attribution: "orchestrator",
          triggered_by: "d3",
        });
        if (!tr.ok) {
          outcomes.push({
            recordId: listing.id,
            address: listing.address,
            daysSinceMovement,
            verdict: result.verdict,
            disposeCategory: result.disposeCategory,
            reason: result.reason,
            action: "dispose_failed",
            detail: `stage transition ${tr.outcome}: ${tr.message}`,
          });
          continue;
        }
        // Mirror to Outreach_Status=Dead (so it leaves the active
        // population → Pulse count drops) + stamp the dispose reason +
        // rewire the V2.1 economics fields/marker.
        await updateListingRecord(listing.id, {
          Outreach_Status: "Dead",
          Verification_Notes: finalNotes,
          ...econFields,
        });
        await audit({
          agent: "orchestrator",
          event: "stale_deal_triage",
          status: "confirmed_success",
          recordId: listing.id,
          inputSummary: {
            address: listing.address,
            days_stale: daysSinceMovement,
            isActive,
            mlsActive,
            declined: decline.declined,
            hasResponded,
            landlordYourMao,
            ...econAudit,
          },
          outputSummary: { verdict: result.verdict, dispose_category: result.disposeCategory },
          decision: result.reason,
        });
        outcomes.push({
          recordId: listing.id,
          address: listing.address,
          daysSinceMovement,
          verdict: result.verdict,
          disposeCategory: result.disposeCategory,
          reason: result.reason,
          action: "disposed",
        });
      } else {
        // reengage_queue / hold — annotate + rewire V2.1 economics ONLY.
        // No status change, no send. The record stays active; the operator
        // sees the flag and the clean economics.
        await updateListingRecord(listing.id, {
          Verification_Notes: finalNotes,
          ...econFields,
        });
        await audit({
          agent: "orchestrator",
          event: "stale_deal_triage",
          status: "confirmed_success",
          recordId: listing.id,
          inputSummary: { address: listing.address, days_stale: daysSinceMovement, isActive, mlsActive, hasResponded, ...econAudit },
          outputSummary: { verdict: result.verdict },
          decision: result.reason,
        });
        outcomes.push({
          recordId: listing.id,
          address: listing.address,
          daysSinceMovement,
          verdict: result.verdict,
          disposeCategory: result.disposeCategory,
          reason: result.reason,
          action: result.verdict === "reengage_queue" ? "annotated_reengage" : "annotated_hold",
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await audit({
        agent: "orchestrator",
        event: "stale_deal_triage",
        status: "confirmed_failure",
        recordId: listing.id,
        inputSummary: { address: listing.address, verdict: result.verdict },
        outputSummary: { stage: "write_threw" },
        error: msg,
      });
      outcomes.push({
        recordId: listing.id,
        address: listing.address,
        daysSinceMovement,
        verdict: result.verdict,
        disposeCategory: result.disposeCategory,
        reason: result.reason,
        action: "dispose_failed",
        detail: msg,
      });
    }
  }

  const summary = {
    stale_total: stale.length,
    considered: outcomes.length,
    acted,
    disposed: outcomes.filter((o) => o.action === "disposed").length,
    reengage_flagged: outcomes.filter((o) => o.action === "annotated_reengage").length,
    held: outcomes.filter((o) => o.action === "annotated_hold").length,
    skipped_already_triaged: outcomes.filter((o) => o.action === "skipped_already_triaged").length,
    dispose_failed: outcomes.filter((o) => o.action === "dispose_failed").length,
    remaining_unprocessed: Math.max(0, stale.length - acted - outcomes.filter((o) => o.action === "skipped_already_triaged").length),
  };

  console.log(
    "[stale_deal_triage]",
    JSON.stringify({ apply: params.apply, auth_kind: auth.kind, summary, duration_ms: Date.now() - t0 }),
  );

  // One run-level audit so the sweep itself (not just per-record) is traceable.
  await audit({
    agent: "orchestrator",
    event: "stale_deal_triage_sweep",
    status: "confirmed_success",
    inputSummary: { apply: params.apply, limit: params.limit, days: params.days, auth_kind: auth.kind },
    outputSummary: summary,
  });

  return NextResponse.json({
    ok: true,
    apply: params.apply,
    auth_kind: auth.kind,
    summary,
    outcomes,
    duration_ms: Date.now() - t0,
  });
}

export async function GET(req: Request) {
  return handle(req, parseParams(req));
}

export async function POST(req: Request) {
  return handle(req, parseParams(req));
}
