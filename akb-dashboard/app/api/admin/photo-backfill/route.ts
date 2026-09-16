// ADMIN PHOTO BACKFILL — one-record photo collection for deals dispo'ed
// before photo collection existed on that path (2026-09-16).
//
// Nothing today runs photo collection at dispo time except
// app/api/cron/dispo-trigger/route.ts, and that lane is gated dark
// (DISPO_BLAST_LIVE) and also fires the buyer email blast — not something
// an operator wants to trigger just to backfill a public page's photos.
// This route does the ONE thing: collectPhotos + write Deal_Photo_URLs,
// for a single record, on demand.
//
// Example: record recbHNKmFSiGXrfus (1005 2nd St, Birmingham) has a
// Verification_URL but an empty Deal_Photo_URLs — its public deal page
// and dispo packet have no photos until this runs with apply=1.
//
// GET /api/admin/photo-backfill?record_id=rec...        (preview, no write)
// GET /api/admin/photo-backfill?record_id=rec...&apply=1 (writes if empty)
// GET /api/admin/photo-backfill?record_id=rec...&apply=1&force=1 (overwrite)
//
// Auth waterfall matches app/api/cron/dispo-trigger/route.ts exactly.

import { NextResponse } from "next/server";
import { getListing, updateListingRecord } from "@/lib/airtable";
import { collectPhotos } from "@/lib/photo-sources";
import { photoUrlsJson } from "@/lib/dispo/blast-email";
import { audit } from "@/lib/audit-log";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";

export const runtime = "nodejs";
export const maxDuration = 120;

function isPopulated(v: string | null | undefined): boolean {
  if (!v) return false;
  const s = v.trim();
  if (s === "" || s === "[]") return false;
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return true; // non-empty, non-JSON string — treat as populated (fail safe)
  }
}

export async function GET(req: Request) {
  const t0 = Date.now();

  // ── Auth waterfall — mirrors app/api/cron/dispo-trigger/route.ts.
  const cookieHeader = req.headers.get("cookie");
  if (!hasDashboardSession(cookieHeader)) {
    const env = readAuthEnv();
    const headers = readAuthHeaders(req);
    const authRequired = kvConfigured() || env.cronSecret !== null || env.bearerDevToken !== null;
    if (authRequired) {
      const auth = await authenticate(headers, env, kvProd);
      if (!auth.ok) return NextResponse.json({ error: "unauthorized", reason: auth.reason }, { status: 401 });
    }
  }

  const url = new URL(req.url);
  const recordId = url.searchParams.get("record_id");
  const applyRequested = url.searchParams.get("apply") === "1";
  const force = url.searchParams.get("force") === "1";

  if (!recordId || !recordId.startsWith("rec")) {
    return NextResponse.json({ ok: false, error: "record_id required (must start with 'rec')" }, { status: 400 });
  }

  try {
    const listing = await getListing(recordId);
    if (!listing) {
      return NextResponse.json({ ok: false, error: "listing not found", recordId }, { status: 404 });
    }

    const fullAddress = [listing.address, listing.city, listing.state, listing.zip].filter(Boolean).join(", ");
    const alreadyPopulated = isPopulated(listing.dealPhotoUrls);

    const photos = await collectPhotos({
      verificationUrl: listing.verificationUrl,
      fullAddress,
      address: listing.address,
      city: listing.city ?? null,
      state: listing.state ?? null,
      zip: listing.zip ?? null,
      maxTotal: 12,
    });

    let applied = false;
    let skipped: string | null = null;
    if (applyRequested) {
      if (photos.length === 0) {
        skipped = "no_photos";
      } else if (alreadyPopulated && !force) {
        skipped = "already_populated";
      } else {
        await updateListingRecord(recordId, { Deal_Photo_URLs: photoUrlsJson(photos) });
        applied = true;
      }
    }

    await audit({
      agent: "scout",
      event: "photo_backfill",
      status: applied ? "confirmed_success" : "uncertain",
      recordId,
      inputSummary: { address: listing.address, verificationUrl: listing.verificationUrl, apply: applyRequested, force, alreadyPopulated },
      outputSummary: { photo_count: photos.length, sources: Array.from(new Set(photos.map((p) => p.source))), applied, skipped },
      ms: Date.now() - t0,
    });

    return NextResponse.json({
      ok: true,
      recordId,
      address: listing.address,
      verificationUrl: listing.verificationUrl,
      photo_count: photos.length,
      sources: Array.from(new Set(photos.map((p) => p.source))),
      photos: photos.map((p) => p.url),
      applied,
      skipped,
      ms: Date.now() - t0,
    });
  } catch (err) {
    const error = String(err);
    console.error(`[photo-backfill] ${recordId}:`, err);
    await audit({
      agent: "scout",
      event: "photo_backfill",
      status: "confirmed_failure",
      recordId,
      error,
      ms: Date.now() - t0,
    }).catch(() => {});
    return NextResponse.json({ ok: false, error, recordId }, { status: 500 });
  }
}
