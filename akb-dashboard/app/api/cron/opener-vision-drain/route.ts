// Opener vision drain — clears the vision queue so it never becomes a pile.
// @agent: appraiser
//
// GET /api/cron/opener-vision-drain
//   ?limit=N   records to process (default 6, max 20)
//   ?dry_run=1 report the work-list, run no vision, write nothing
//
// THE CONTRACT (operator 2026-07-31): "when these types of properties pile up
// they need to move into an action bucket for me and you to work on, not get
// buried in hundreds of other dead properties... a bucket for me to either
// spot check images or run rehab with the system vision."
//
// So the bucket has to DRAIN ITSELF. A record lands in Vision_Queue_State=
// needs_vision when its opener held on a placeholder rehab (the 256
// Westchester defect — see lib/pricing/vision-queue.ts). This cron runs the
// SAME vision pipeline the appraiser already owns, writes the real rehab, and
// clears the flag. The next h2 pass then prices the record properly and may
// send it — with no operator involvement at all.
//
// The operator only ever sees what vision genuinely could not resolve:
// Vision_Queue_State=vision_failed (no photos, vision threw). That is the
// spot-check-the-images bucket, and it is small by construction.
//
// Deliberately NOT writing Agent_Proposals rows: these are machine work.
// h2_opener_hold is 533 deep; putting vision work in it buries the work AND
// mislabels it as a decision waiting on Alex.
//
// PACING: vision is a paid Anthropic vision call per record and photo
// collection can hit Firecrawl. limit defaults low and clamps hard — this is
// a drain, not a sweep. Re-run it until remaining hits 0.

import { NextResponse } from "next/server";
import { getListings, getListing, updateListingRecord } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import { collectPhotos } from "@/lib/photo-sources";
import { callRehabVision } from "@/lib/rehab-calibration";
import { classifyBbcTierFromCondition, computeRehabRange } from "@/lib/appraiser/rehab-calibration";
import { drainOutcome, VISION_QUEUE_FIELD } from "@/lib/pricing/vision-queue";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";

export const runtime = "nodejs";
export const maxDuration = 300;

const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 20;
// Vision runs 1–3 min. Stop STARTING work this late so in-flight writes land.
const WALL_CLOCK_BUDGET_MS = 240_000;

interface Row {
  record_id: string;
  address: string | null;
  outcome: "cleared" | "vision_failed" | "skipped";
  rehab_mid: number | null;
  detail: string;
}

export async function GET(req: Request) {
  const t0 = Date.now();

  const cookieHeader = req.headers.get("cookie");
  let authKind = "none";
  if (hasDashboardSession(cookieHeader)) {
    authKind = "dashboard_session";
  } else {
    const env = readAuthEnv();
    const headers = readAuthHeaders(req);
    const authRequired = kvConfigured() || env.cronSecret !== null || env.bearerDevToken !== null;
    if (authRequired) {
      const auth = await authenticate(headers, env, kvProd);
      if (!auth.ok) return NextResponse.json({ error: "unauthorized", reason: auth.reason }, { status: 401 });
      authKind = auth.kind;
    }
  }

  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dry_run") === "1";
  const rawLimit = Number(url.searchParams.get("limit"));
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(MAX_LIMIT, Math.floor(rawLimit)) : DEFAULT_LIMIT;

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "vision_not_configured", message: "ANTHROPIC_API_KEY missing" }, { status: 503 });
  }

  let listings;
  try {
    listings = await getListings({ includeLegacy: true });
  } catch (err) {
    return NextResponse.json(
      { error: "listings_fetch_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  const queue = listings.filter((l) => l.visionQueueState === "needs_vision");
  // The operator's bucket — reported every run so its size is never a surprise.
  const awaitingOperator = listings.filter((l) => l.visionQueueState === "vision_failed").length;

  const batch = queue.slice(0, limit);
  const rows: Row[] = [];
  const summary = { cleared: 0, vision_failed: 0, skipped: 0 };
  let truncatedForTime = false;

  if (!dryRun) {
    for (const l of batch) {
      if (Date.now() - t0 > WALL_CLOCK_BUDGET_MS) {
        truncatedForTime = true;
        break;
      }
      let rehabMid: number | null = null;
      let detail = "";
      try {
        // Re-read: the record may have been priced or killed since the list load.
        const fresh = await getListing(l.id);
        if (!fresh) {
          rows.push({ record_id: l.id, address: l.address, outcome: "skipped", rehab_mid: null, detail: "record_not_found" });
          summary.skipped++;
          continue;
        }
        const fullAddress = [fresh.address, fresh.city, fresh.state, fresh.zip].filter(Boolean).join(", ");
        const photos = await collectPhotos({ verificationUrl: fresh.verificationUrl, fullAddress });
        if (photos.length === 0) {
          detail = "no_photos_available";
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
          const range = computeRehabRange({
            sqft: fresh.buildingSqFt,
            bbcTier: classifyBbcTierFromCondition(vision.condition_overall),
            state: fresh.state,
          });
          rehabMid = range.rehab_mid ?? null;
          detail = `vision condition=${vision.condition_overall} rehab_mid=$${Math.round(rehabMid ?? 0).toLocaleString()}`;
        }
      } catch (err) {
        detail = `vision_error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200);
      }

      const outcome = drainOutcome(rehabMid);
      try {
        // On success write the rehab AND clear the flag — that single write is
        // what releases the record: the next h2 pass sees a real rehab, prices
        // off it, and may send. On failure the flag becomes the operator's
        // bucket; we do NOT invent a rehab to unblock ourselves.
        const fields: Record<string, unknown> =
          outcome === "cleared"
            ? { Est_Rehab_Mid: rehabMid, Rehab_Estimated_At: new Date().toISOString(), [VISION_QUEUE_FIELD]: "cleared" }
            : { [VISION_QUEUE_FIELD]: "vision_failed" };
        await updateListingRecord(l.id, fields);
      } catch (err) {
        detail += ` | write_failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 120);
      }
      rows.push({ record_id: l.id, address: l.address, outcome, rehab_mid: rehabMid, detail });
      summary[outcome]++;
    }
  }

  await audit({
    agent: "appraiser",
    event: "opener_vision_drain",
    status: "confirmed_success",
    decision: dryRun
      ? `dry run — ${queue.length} awaiting vision, ${awaitingOperator} awaiting operator`
      : `${summary.cleared} released to the send path, ${summary.vision_failed} need an operator eye`,
    outputSummary: { ...summary, queue_depth: queue.length, awaiting_operator: awaitingOperator },
    ms: Date.now() - t0,
  }).catch(() => {});

  return NextResponse.json({
    ok: true,
    mode: dryRun ? "dry_run" : "apply",
    auth_kind: authKind,
    took_ms: Date.now() - t0,
    queue_depth: queue.length,
    processed: rows.length,
    remaining_after_run: queue.length - summary.cleared - summary.vision_failed,
    truncated_for_time: truncatedForTime,
    summary,
    // THE operator number: everything else on this route is machine work.
    awaiting_operator: {
      count: awaitingOperator,
      note: "Vision_Queue_State=vision_failed — spot-check the images or run rehab by hand. Nothing else here needs you.",
    },
    rows,
  });
}
