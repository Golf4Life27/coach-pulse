// Phase 4B.1 — Appraiser rehab endpoint (record-scoped, persistent).
// @agent: appraiser
//
// GET /api/agents/appraiser/rehab/[recordId]
//   ?skip_write=1   compute only, don't write Airtable
//   ?skip_photos=1  bypass Vision; useful when running against records
//                   that haven't had photos scraped yet (returns 422)
//
// The standalone Rehab Calibration endpoint per Phase 4B.1 brief.
// Mirrors /api/agents/appraiser/arv/[recordId]'s shape: record-scoped,
// authoritative, writes to Airtable.
//
// Pipeline:
//   1. Read listing (address + sqft + state + verification_url)
//   2. collectPhotos — scrape listing photos + Street View fallback
//   3. callRehabVision — Anthropic vision call returns Condition +
//      raw rehab band + line items + red flags + confidence
//   4. classifyBbcTierFromCondition — map vision Condition (Good/
//      Average/Fair/Poor/Disrepair) to BBC tier (Cosmetic/Light/
//      Medium/Heavy/Gut)
//   5. computeRehabRange — apply BBC anchor × market multiplier ×
//      sqft → calibrated rehab_low/mid/high
//   6. Write Est_Rehab + Est_Rehab_Mid + Rehab_Confidence_Score +
//      Rehab_Line_Items_JSON + Rehab_Red_Flags + Rehab_Estimated_At
//   7. Return { rehab, calibration, line_items, red_flags, audit }
//
// Pricing Agent's existing 4B leg is unchanged; both coexist this
// sprint per Alex's "eventually retire K's write-back logic so Vercel
// owns all writes" framing.

import { NextResponse } from "next/server";
import { getListing, updateListingRecord } from "@/lib/airtable";
import { callRehabVision } from "@/lib/rehab-calibration";
import { collectPhotos } from "@/lib/photo-sources";
import {
  classifyBbcTierFromCondition,
  computeRehabRange,
} from "@/lib/appraiser/rehab-calibration";
import { audit } from "@/lib/audit-log";
import { foldRehabRead, type RehabRead } from "@/lib/rehab-median";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ recordId: string }> },
) {
  const t0 = Date.now();
  const { recordId } = await params;
  const url = new URL(req.url);
  const skipWrite = url.searchParams.get("skip_write") === "1";
  const skipPhotos = url.searchParams.get("skip_photos") === "1";

  if (!recordId || !recordId.startsWith("rec")) {
    return NextResponse.json({ error: "invalid_record_id" }, { status: 400 });
  }

  // ── Auth — dashboard session → OAuth waterfall ──────────────────
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

  if (skipPhotos) {
    // Constitution Rule 3 + INV-005: no preemptive-skip path. The manual
    // affordance is unlocked only AFTER this route returns one of the
    // automation-failure surfaces (no_photos_available / vision_call_failed /
    // photo_collection_failed) and the operator hits the POST /manual
    // sibling endpoint via the UI.
    return NextResponse.json(
      { error: "skip_photos_unimplemented", reason: "manual rehab is fallback-only; vision must be attempted first (INV-005)" },
      { status: 422 },
    );
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "anthropic_not_configured" },
      { status: 503 },
    );
  }

  // ── Load listing ────────────────────────────────────────────────
  const listing = await getListing(recordId);
  if (!listing) {
    return NextResponse.json(
      { error: "listing_not_found", recordId },
      { status: 404 },
    );
  }
  if (!listing.address || !listing.city || !listing.state || !listing.zip) {
    return NextResponse.json(
      {
        error: "missing_address_parts",
        reason: "address + city + state + zip all required for photo scrape + vision",
        recordId,
      },
      { status: 422 },
    );
  }
  if (listing.buildingSqFt == null || listing.buildingSqFt <= 0) {
    return NextResponse.json(
      {
        error: "missing_sqft",
        reason: "Building_SqFt required to compute calibrated rehab band",
        recordId,
      },
      { status: 422 },
    );
  }

  // ── INV-023 follow-on: refuse rehab vision when the photo path
  // can't deliver a reliable subject-property photo set.
  //
  // 2026-06-04 finding (operator catch): the cron sweep produced
  // rehab estimates for 4 records, of which (a) 3 had NO
  // Verification_URL — Firecrawl couldn't fire, so only Street View's
  // single exterior shot was passed to vision; (b) 1 was Live_Status=
  // "Off Market" — Redfin keeps the URL accessible but the page mixes
  // stale subject photos with comps + recommended-listings + Redfin
  // chrome, so the regex pulled 69 URLs that aren't reliably the
  // subject. Either case produces a confident-LOOKING estimate from
  // an unreliable input set; the existing low-confidence gate catches
  // it after the fact, but spending the Anthropic vision call is
  // wasteful and the bad write pollutes Airtable until cleared. So
  // we now refuse upstream:
  //
  //   - Live_Status != "Active" → 422 listing_not_actively_listed
  //     (off-market deals stay in the negotiating cluster but their
  //     scrape is unreliable; rehab estimate must wait for fresh
  //     photos / manual fallback path).
  //   - No Verification_URL AND no RentCast photos → vision would
  //     get only a Street View exterior, which the operator policy
  //     refuses to pass. Surface explicitly so the manual fallback
  //     UI is the only path forward.
  const liveStatus = (listing.liveStatus ?? "").trim().toLowerCase();
  if (liveStatus !== "active") {
    return NextResponse.json(
      {
        error: "listing_not_actively_listed",
        reason: `Live_Status="${listing.liveStatus}" — rehab vision refuses to scrape off-market / unverified URLs (subject-photo reliability gate)`,
        recordId,
      },
      { status: 422 },
    );
  }

  // ── Collect photos ──────────────────────────────────────────────
  const fullAddress = [listing.address, listing.city, listing.state, listing.zip]
    .filter(Boolean)
    .join(", ");
  let photos: Awaited<ReturnType<typeof collectPhotos>>;
  try {
    photos = await collectPhotos({
      verificationUrl: listing.verificationUrl,
      fullAddress,
      address: listing.address,
      city: listing.city,
      state: listing.state,
      zip: listing.zip,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await audit({
      agent: "appraiser",
      event: "rehab_photo_collect_failed",
      status: "confirmed_failure",
      inputSummary: { record_id: recordId, auth_kind: authKind },
      outputSummary: { duration_ms: Date.now() - t0 },
      error: msg,
      recordId,
    });
    return NextResponse.json(
      { error: "photo_collection_failed", message: msg },
      { status: 502 },
    );
  }
  if (photos.length === 0) {
    return NextResponse.json(
      {
        error: "no_photos_available",
        reason: "listing scrape + Street View fallback both empty",
        recordId,
      },
      { status: 422 },
    );
  }
  // Street-View-only is INSUFFICIENT for rehab vision — a single
  // exterior shot produces a confident-looking number that the model
  // anchors at the lowest tier (Cosmetic $15/sqft) by default. Per
  // the gate posture ("HOLD on Street-View-only / low-confidence"),
  // refuse before burning the Anthropic vision call. The manual
  // fallback path (POST /manual) is the route forward.
  if (photos.every((p) => p.source === "streetview")) {
    return NextResponse.json(
      {
        error: "street_view_only_insufficient",
        reason: "no listing photos available (RentCast empty + Firecrawl/ScraperAPI returned 0); Street View alone is not a sufficient rehab signal",
        photo_count: photos.length,
        recordId,
      },
      { status: 422 },
    );
  }

  // ── Call vision ─────────────────────────────────────────────────
  let vision;
  try {
    vision = await callRehabVision(
      {
        photos_urls: photos.map((p) => p.url),
        sqft: listing.buildingSqFt,
        zip: listing.zip,
        address: listing.address,
        beds: listing.bedrooms,
        baths: listing.bathrooms,
      },
      process.env.ANTHROPIC_API_KEY,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await audit({
      agent: "appraiser",
      event: "rehab_vision_failed",
      status: "confirmed_failure",
      inputSummary: {
        record_id: recordId,
        photo_count: photos.length,
        auth_kind: authKind,
      },
      outputSummary: { duration_ms: Date.now() - t0 },
      error: msg,
      recordId,
    });
    return NextResponse.json(
      { error: "vision_call_failed", message: msg },
      { status: 502 },
    );
  }

  // ── BBC tier classification + market-multiplier calibration ─────
  const bbcTier = classifyBbcTierFromCondition(vision.condition_overall);
  const range = computeRehabRange({
    sqft: listing.buildingSqFt,
    bbcTier,
    state: listing.state,
  });

  // ── Median-of-last-5-valid persistence (2026-06-05) ─────────────
  // Persist the MEDIAN of the last 5 VALID reads instead of overwriting
  // on every fire. A conf=0 parse-failure / low outlier is excluded as
  // invalid (not averaged in) and can no longer flip the persisted gate.
  // The rolling history rides in Rehab_Line_Items_JSON.read_history.
  const nowIso = new Date().toISOString();
  const thisRead: RehabRead = {
    ts: nowIso,
    conf: vision.confidence,
    rehab_low: range.rehab_low ?? 0,
    rehab_mid: range.rehab_mid ?? 0,
    rehab_high: range.rehab_high ?? 0,
  };
  let priorHistory: RehabRead[] = [];
  try {
    const parsed = listing.rehabLineItemsJson ? JSON.parse(listing.rehabLineItemsJson) : null;
    if (parsed && Array.isArray(parsed.read_history)) priorHistory = parsed.read_history as RehabRead[];
  } catch {
    priorHistory = [];
  }
  const folded = foldRehabRead(priorHistory, thisRead);

  // One-line observability (runtime-log surfaces the first console.log).
  // gate=PASS only when the MEDIAN conf ≥ 60 (single-read conf shown too).
  const photoSrcCounts = photos.reduce<Record<string, number>>((acc, p) => {
    acc[p.source] = (acc[p.source] ?? 0) + 1;
    return acc;
  }, {});
  console.log(
    `REHAB ${recordId} conf=${vision.confidence} med_conf=${folded.medianConf ?? "-"} ` +
    `gate=${folded.gatePass ? "PASS" : "HOLD"} valid=${folded.validCount}/${5} ` +
    `accepted=${folded.newReadAccepted} cond=${vision.condition_overall} photos=${vision.photo_count} ` +
    `src=${Object.entries(photoSrcCounts).map(([k, v]) => `${k}:${v}`).join(",")} ` +
    `this_mid=${range.rehab_mid} med_mid=${folded.medianRehabMid ?? "-"}`,
  );

  // ── Airtable write (skippable) ──────────────────────────────────
  // Only persist when we have ≥1 valid read in the window. A first fire
  // that is itself a misfire (validCount 0) writes nothing — there is no
  // trustworthy number to persist (correct HOLD).
  let airtableError: string | null = null;
  if (!skipWrite && folded.validCount > 0 && folded.medianRehabMid != null) {
    const fieldsToWrite: Record<string, unknown> = {
      Est_Rehab: folded.medianRehabMid,
      Rehab_Est_Low: folded.medianRehabLow,
      Est_Rehab_Mid: folded.medianRehabMid,
      Rehab_Est_High: folded.medianRehabHigh,
      Rehab_Confidence_Score: folded.medianConf,
      Rehab_Line_Items_JSON: JSON.stringify({
        bbc_tier: bbcTier,
        market_tier: range.market_tier,
        market_multiplier: range.market_multiplier,
        anchor_per_sqft: range.anchor_per_sqft,
        calibrated_rate_per_sqft: range.calibrated_rate_per_sqft,
        vision_condition: vision.condition_overall,
        vision_line_items: vision.line_items,
        // Rolling valid-read history (last 5) — drives the median.
        read_history: folded.history,
        median_conf: folded.medianConf,
        median_rehab_mid: folded.medianRehabMid,
      }).slice(0, 95_000),
      Rehab_Red_Flags: vision.red_flags.join(", "),
      Rehab_Estimated_At: nowIso,
      // INV-005 — provenance flag. Vision pipeline owns this write
      // path; manual fallback (POST /manual sibling) writes
      // manual_operator or manual_partner.
      Rehab_Source: "vision",
    };
    try {
      await updateListingRecord(recordId, fieldsToWrite);
    } catch (err) {
      airtableError = err instanceof Error ? err.message : String(err);
    }
  }

  // ── Audit ───────────────────────────────────────────────────────
  await audit({
    agent: "appraiser",
    event: "rehab_calibrated",
    status: airtableError ? "uncertain" : "confirmed_success",
    inputSummary: {
      record_id: recordId,
      auth_kind: authKind,
      skip_write: skipWrite,
      photo_count: photos.length,
    },
    outputSummary: {
      bbc_tier: bbcTier,
      market_tier: range.market_tier,
      market_multiplier: range.market_multiplier,
      calibrated_rate_per_sqft: range.calibrated_rate_per_sqft,
      rehab_mid: range.rehab_mid,
      rehab_low: range.rehab_low,
      rehab_high: range.rehab_high,
      vision_condition: vision.condition_overall,
      vision_confidence: vision.confidence,
      red_flag_count: vision.red_flags.length,
      airtable_write: !skipWrite && range.rehab_mid != null,
      airtable_error: airtableError,
      duration_ms: Date.now() - t0,
    },
    decision: bbcTier,
    recordId,
  });

  return NextResponse.json({
    record_id: recordId,
    address: listing.address,
    city: listing.city,
    state: listing.state,
    zip: listing.zip,
    sqft: listing.buildingSqFt,
    rehab: {
      mid: range.rehab_mid,
      low: range.rehab_low,
      high: range.rehab_high,
    },
    calibration: {
      bbc_tier: bbcTier,
      anchor_per_sqft: range.anchor_per_sqft,
      market_tier: range.market_tier,
      market_multiplier: range.market_multiplier,
      calibrated_rate_per_sqft: range.calibrated_rate_per_sqft,
    },
    vision: {
      condition: vision.condition_overall,
      confidence: vision.confidence,
      photo_count: vision.photo_count,
      model: vision.vision_model,
    },
    line_items: vision.line_items,
    red_flags: vision.red_flags,
    audit: {
      estimated_at: nowIso,
      airtable_write: !skipWrite && range.rehab_mid != null,
      airtable_error: airtableError,
      duration_ms: Date.now() - t0,
    },
  });
}
