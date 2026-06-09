// Phase A γ-path — Buyer_Median manual set/read for a deal.
// @agent: appraiser/maverick
//
// GET  /api/deal/[recordId]/buyer-median
//   → the current Buyer_Median on the listing's Property_Intel record
//     ({ found, value, source, fetchedAt, sampleSize }).
// POST /api/deal/[recordId]/buyer-median
//   body { value, source, exportDate, sampleSize? }
//   → validates via lib/buyer-median-input (HARD RULE: only
//     source="investorbase_manual" + an export date are accepted; an
//     unsourced number is refused 422), then upserts the listing's
//     Property_Intel row. This is what unblocks the underwrite gate's
//     PC-26 for a deal (the gate reads Property_Intel.Buyer_Median_Value).
//
// Provenance: writes Buyer_Median_Source="investorbase_manual" +
// Buyer_Median_FetchedAt=<export date> so the value is permanently
// stamped with where it came from and which export. typecast on the
// upsert mints the "investorbase_manual" select option on first write.
//
// Auth: dashboard cookie / CRON_SECRET / OAuth waterfall.

import { NextResponse } from "next/server";
import { getListing } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import {
  findPropertyIntelRecordByListing,
  upsertPropertyIntel,
} from "@/lib/federation/property-intel-store";
import { validateBuyerMedianInput, defaultBuyerTrack } from "@/lib/buyer-median-input";
import { getZipBuyerMedian } from "@/lib/buyer-median-store";

export const runtime = "nodejs";
export const maxDuration = 30;

async function gate(req: Request): Promise<{ ok: true; authKind: string } | { ok: false; res: NextResponse }> {
  const cookieHeader = req.headers.get("cookie");
  if (hasDashboardSession(cookieHeader)) return { ok: true, authKind: "dashboard_session" };
  const env = readAuthEnv();
  const headers = readAuthHeaders(req);
  const authRequired = kvConfigured() || env.cronSecret !== null || env.bearerDevToken !== null;
  if (!authRequired) return { ok: true, authKind: "none" };
  const auth = await authenticate(headers, env, kvProd);
  if (!auth.ok) {
    return { ok: false, res: NextResponse.json({ error: "unauthorized", reason: auth.reason }, { status: 401 }) };
  }
  return { ok: true, authKind: auth.kind };
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export async function GET(req: Request, { params }: { params: Promise<{ recordId: string }> }) {
  const g = await gate(req);
  if (!g.ok) return g.res;
  const { recordId } = await params;

  try {
    // ZIP-level store is the SOURCE OF TRUTH: a deal reads its ZIP's median
    // for its track (distressed as-is → landlord) instead of a hand-entered
    // per-deal value. Per-deal Property_Intel is only a legacy fallback.
    const listing = await getListing(recordId).catch(() => null);
    if (listing?.zip) {
      const redFlagsText = Array.isArray(listing.redFlags) ? listing.redFlags.join(" ") : (listing.redFlags ?? "");
      const track = defaultBuyerTrack({
        condition: `${redFlagsText} ${listing.distressBucket ?? ""}`,
        distressed: (listing.distressScore ?? 0) > 0,
      });
      const zipMedian = await getZipBuyerMedian(listing.zip, track).catch(() => null);
      if (zipMedian) {
        return NextResponse.json({
          found: true,
          origin: "zip_store",
          zip: zipMedian.zip,
          value: zipMedian.value,
          source: zipMedian.source,
          track: zipMedian.track,
          fetchedAt: zipMedian.fetchedAt,
          sampleSize: zipMedian.compCount,
        });
      }
    }

    const pi = await findPropertyIntelRecordByListing(recordId);
    if (!pi) {
      return NextResponse.json({ found: false, value: null, source: null, track: null, fetchedAt: null, sampleSize: null });
    }
    const f = pi.fields;
    return NextResponse.json({
      found: true,
      origin: "property_intel_legacy",
      propertyIntelId: pi.recordId,
      value: num(f["Buyer_Median_Value"]),
      source: (f["Buyer_Median_Source"] as string) ?? null,
      track: (f["Buyer_Median_Track"] as string) ?? null,
      fetchedAt: (f["Buyer_Median_FetchedAt"] as string) ?? null,
      sampleSize: num(f["Buyer_Median_SampleSize"]),
    });
  } catch (err) {
    return NextResponse.json(
      { error: "property_intel_read_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ recordId: string }> }) {
  const g = await gate(req);
  if (!g.ok) return g.res;
  const { recordId } = await params;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  // Fetch the listing first — its cohort sets the DEFAULT track when the
  // caller didn't pass one (distressed as-is → landlord), and we need the
  // subject address for the upsert.
  let subjectAddress: string;
  let cohortDefaultTrack: "flipper" | "landlord";
  try {
    const listing = await getListing(recordId);
    if (!listing) return NextResponse.json({ error: "listing_not_found", recordId }, { status: 404 });
    subjectAddress = listing.address ?? "";
    const redFlagsText = Array.isArray(listing.redFlags) ? listing.redFlags.join(" ") : (listing.redFlags ?? "");
    cohortDefaultTrack = defaultBuyerTrack({
      condition: `${redFlagsText} ${listing.distressBucket ?? ""}`,
      distressed: (listing.distressScore ?? 0) > 0,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "listing_read_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  // Default the track from the cohort when the caller omitted it (distressed
  // as-is → landlord). An explicit track in the body always wins.
  if (body.track == null || body.track === "") body.track = cohortDefaultTrack;

  // HARD RULE chokepoint — unsourced/unstamped or BLENDED values never get
  // past here (track is now required and a blended number is refused).
  const validation = validateBuyerMedianInput(body);
  if (!validation.ok) {
    await audit({
      agent: "appraiser",
      event: "buyer_median_set_refused",
      status: "confirmed_failure",
      recordId,
      inputSummary: { reason: validation.error },
    });
    return NextResponse.json({ error: "validation_failed", reason: validation.error }, { status: 422 });
  }
  const { value, source, track, exportDate, sampleSize } = validation.data;

  try {
    const fields: Record<string, unknown> = {
      Buyer_Median_Value: value,
      Buyer_Median_Source: source, // "investorbase_manual" — typecast mints the option
      Buyer_Median_Track: track, // "flipper" | "landlord" — typecast mints the option
      Buyer_Median_FetchedAt: exportDate,
    };
    if (sampleSize != null) fields["Buyer_Median_SampleSize"] = sampleSize;

    const { recordId: piId, created } = await upsertPropertyIntel(recordId, subjectAddress, fields);

    await audit({
      agent: "appraiser",
      event: "buyer_median_set",
      status: "confirmed_success",
      recordId,
      inputSummary: { source, track, export_date: exportDate, sample_size: sampleSize, subject_address: subjectAddress },
      outputSummary: { value, track, property_intel_id: piId, created },
      decision: "buyer_median_hydrated",
    });

    return NextResponse.json({
      ok: true,
      propertyIntelId: piId,
      created,
      value,
      source,
      track,
      fetchedAt: exportDate,
      sampleSize,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "property_intel_write_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
