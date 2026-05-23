// INV-005 — Rehab vision retry + drift detection cron.
// @agent: appraiser
//
// GET /api/cron/rehab-vision-retry
//
// Daily 15:00 UTC slot (vercel.json). Scans Listings_V1 for active
// records whose Est_Rehab was set via the manual fallback path
// (Rehab_Source = "manual_operator"). For each, re-runs the autonomous
// vision pipeline. Three outcomes:
//
//   1. Vision still fails (no photos, vision throws, etc.) → appends a
//      retry stamp to Notes (cooldown marker) and moves on. No drift
//      surface. Operator's manual value stays authoritative.
//   2. Vision succeeds + drift ≤ DRIFT_THRESHOLD_PCT (25%) → appends a
//      retry stamp with "vision_agrees" outcome. No banner surfaced.
//   3. Vision succeeds + drift > threshold → appends a Notes line with
//      DRIFT_NOTES_MARKER. AppraiserRehabPanel reads the marker and
//      renders a Type 2C banner with [Accept vision update] /
//      [Keep manual] buttons. **Never silently overwrites** the manual
//      Est_Rehab — operator resolution is required.
//
// Constitution Rule 3: data hydration (the vision retry itself) is
// Type 1 autonomous; the drift surface is Type 2C (operator judgment
// required to reconcile two valid signals).
//
// Hobby plan cron cap: once-daily. Existing slots 8/9/10/11/12/13/14
// UTC; 15:00 picked as next free.
//
// Skips manual_partner (partner-inspection-sourced rehab is treated as
// more authoritative than vision; not subject to vision retry).

import { NextResponse } from "next/server";
import { getListings, updateListingRecord, getListing } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import { writeState } from "@/lib/maverick/write-state";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import { collectPhotos } from "@/lib/photo-sources";
import { callRehabVision } from "@/lib/rehab-calibration";
import {
  classifyBbcTierFromCondition,
  computeRehabRange,
} from "@/lib/appraiser/rehab-calibration";
import {
  shouldRetryVision,
  computeDrift,
  buildDriftNotesLine,
  buildRetryStampLine,
} from "@/lib/maverick/rehab-vision-retry";

export const runtime = "nodejs";
export const maxDuration = 300;

interface RetrySummary {
  scanned: number;
  retried: number;
  skipped_not_manual: number;
  skipped_not_active: number;
  skipped_in_cooldown: number;
  vision_failed: number;
  vision_agrees: number;
  drift_detected: number;
  errors: Array<{ recordId: string; address: string; error: string }>;
  drift_records: Array<{
    recordId: string;
    address: string;
    manualMid: number;
    visionMid: number;
    driftPct: number;
  }>;
}

export async function GET(req: Request) {
  const t0 = Date.now();

  // Auth waterfall (mirrors INV-006 reconciler).
  const cookieHeader = req.headers.get("cookie");
  const isDashboard = hasDashboardSession(cookieHeader);
  let authKind: "dashboard_session" | "oauth" | "cron" | "bearer_dev" | "none" =
    "none";
  if (isDashboard) {
    authKind = "dashboard_session";
  } else {
    const env = readAuthEnv();
    const headers = readAuthHeaders(req);
    const authRequired =
      kvConfigured() || env.cronSecret !== null || env.bearerDevToken !== null;
    if (authRequired) {
      const auth = await authenticate(headers, env, kvProd);
      if (!auth.ok) {
        return NextResponse.json(
          { error: "unauthorized", reason: auth.reason },
          { status: 401 },
        );
      }
      authKind = auth.kind;
    }
  }
  if (authKind === "cron" && process.env.MAVERICK_CRON_ENABLED !== "true") {
    return NextResponse.json({ error: "cron_disabled" }, { status: 503 });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "anthropic_not_configured" },
      { status: 503 },
    );
  }

  const summary: RetrySummary = {
    scanned: 0,
    retried: 0,
    skipped_not_manual: 0,
    skipped_not_active: 0,
    skipped_in_cooldown: 0,
    vision_failed: 0,
    vision_agrees: 0,
    drift_detected: 0,
    errors: [],
    drift_records: [],
  };

  let listings;
  try {
    listings = await getListings();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await audit({
      agent: "appraiser",
      event: "rehab_vision_retry_fetch_failed",
      status: "confirmed_failure",
      inputSummary: { auth_kind: authKind },
      outputSummary: { duration_ms: Date.now() - t0 },
      error: msg,
    });
    return NextResponse.json(
      { error: "listings_fetch_failed", message: msg },
      { status: 502 },
    );
  }

  summary.scanned = listings.length;
  const now = new Date();

  for (const l of listings) {
    const decision = shouldRetryVision(
      {
        rehabSource: l.rehabSource ?? null,
        liveStatus: l.liveStatus ?? null,
        notes: l.notes ?? null,
      },
      now,
    );

    if (decision.action === "skip") {
      switch (decision.reason) {
        case "not_manual":
          summary.skipped_not_manual++;
          break;
        case "not_active":
          summary.skipped_not_active++;
          break;
        case "in_cooldown":
          summary.skipped_in_cooldown++;
          break;
      }
      continue;
    }

    // Re-fetch the listing to ensure we have the freshest manual mid
    // before computing drift (caches in lib/airtable can lag a tick).
    const fresh = await getListing(l.id);
    if (!fresh) {
      summary.errors.push({
        recordId: l.id,
        address: l.address,
        error: "listing_disappeared",
      });
      continue;
    }
    const manualMid = fresh.estRehabMid ?? fresh.estRehab ?? null;
    if (manualMid == null || manualMid <= 0) {
      // Race: rehab cleared between scan + fetch. Skip silently.
      continue;
    }
    if (
      !fresh.address ||
      !fresh.city ||
      !fresh.state ||
      !fresh.zip ||
      fresh.buildingSqFt == null ||
      fresh.buildingSqFt <= 0
    ) {
      // Same data-completeness gates the GET sibling enforces. Skip;
      // the missing fields aren't going to fill themselves between
      // crons, and a per-record stamp would burn ANTHROPIC quota for
      // a guaranteed-fail.
      continue;
    }

    summary.retried++;

    let outcome: "vision_failed" | "vision_agrees" | "drift_detected";
    let outcomeDetail: string;
    let driftNoteLine: string | null = null;

    try {
      const fullAddress = [fresh.address, fresh.city, fresh.state, fresh.zip]
        .filter(Boolean)
        .join(", ");
      const photos = await collectPhotos({
        verificationUrl: fresh.verificationUrl,
        fullAddress,
      });
      if (photos.length === 0) {
        outcome = "vision_failed";
        outcomeDetail = "no_photos_available";
        summary.vision_failed++;
      } else {
        const vision = await callRehabVision(
          {
            photos_urls: photos.map((p) => p.url),
            sqft: fresh.buildingSqFt,
            zip: fresh.zip,
            address: fresh.address,
            beds: fresh.bedrooms,
            baths: fresh.bathrooms,
          },
          process.env.ANTHROPIC_API_KEY!,
        );
        const bbcTier = classifyBbcTierFromCondition(vision.condition_overall);
        const range = computeRehabRange({
          sqft: fresh.buildingSqFt,
          bbcTier,
          state: fresh.state,
        });
        const visionMid = range.rehab_mid ?? 0;
        const drift = computeDrift(manualMid, visionMid);
        if (drift.exceedsThreshold) {
          outcome = "drift_detected";
          outcomeDetail = `vision=$${Math.round(visionMid)} manual=$${Math.round(manualMid)} drift=${drift.driftPct.toFixed(1)}%`;
          driftNoteLine = buildDriftNotesLine(now, manualMid, visionMid, drift);
          summary.drift_detected++;
          summary.drift_records.push({
            recordId: l.id,
            address: l.address,
            manualMid,
            visionMid,
            driftPct: drift.driftPct,
          });
        } else {
          outcome = "vision_agrees";
          outcomeDetail = `vision=$${Math.round(visionMid)} drift=${drift.driftPct.toFixed(1)}%`;
          summary.vision_agrees++;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      outcome = "vision_failed";
      outcomeDetail = `exception: ${msg.slice(0, 200)}`;
      summary.vision_failed++;
    }

    // Append Notes: retry stamp always, drift line conditionally. The
    // manual Est_Rehab fields are NEVER touched here — Rule 3.
    const retryStamp = buildRetryStampLine(now, outcome, outcomeDetail);
    const noteLines = driftNoteLine
      ? `${retryStamp}\n${driftNoteLine}`
      : retryStamp;
    const nextNotes = fresh.notes ? `${fresh.notes}\n${noteLines}` : noteLines;

    try {
      await updateListingRecord(l.id, { Verification_Notes: nextNotes });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      summary.errors.push({ recordId: l.id, address: l.address, error: msg });
      continue;
    }

    await audit({
      agent: "appraiser",
      event: `rehab_vision_retry_${outcome}`,
      status: "confirmed_success",
      inputSummary: {
        record_id: l.id,
        address: l.address,
        auth_kind: authKind,
        manual_mid: manualMid,
      },
      outputSummary: { outcome, detail: outcomeDetail },
      recordId: l.id,
    });

    if (outcome === "drift_detected") {
      try {
        await writeState({
          event_type: "build_event",
          attribution_agent: "appraiser",
          title: `Rehab drift detected: ${l.address} (${l.id}) — manual vs vision diverged`,
          description:
            `INV-005 nightly retry detected vision-vs-manual drift. ` +
            `Operator entered $${Math.round(manualMid).toLocaleString("en-US")}; ` +
            `vision now estimates differently (${outcomeDetail}). ` +
            `Type 2C surface — operator must accept vision or keep manual. ` +
            `Drift marker written to Notes; AppraiserRehabPanel renders banner.`,
          related_listing: l.id,
        });
      } catch (err) {
        console.error(
          `[rehab-vision-retry] Spine write failed for ${l.id}:`,
          err,
        );
      }
    }
  }

  return NextResponse.json({
    ok: true,
    auth_kind: authKind,
    duration_ms: Date.now() - t0,
    ...summary,
  });
}
