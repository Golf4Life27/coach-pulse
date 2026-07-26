// WRITTEN-OFFER LETTER — one-click printable offer for a listing agent.
// @agent: scribe
//
// GET /api/offer-letter/<recordId>
//   ?price=85000       explicit operator override of the offer price
//   ?emd=2500          earnest money deposit (default $1,000)
//   ?close_days=21     closing window (default 30)
//
// Returns a printable text/html letter (letter size, serif, letterhead).
// This is an OFFER LETTER, not a purchase contract — the seller's agent
// writes the contract.
//
// Doctrine (INVARIANTS §1 / §3): this route NEVER computes or invents a
// price. It reads the STICKY stored number (roughOpenerAmount ??
// outreachOfferPrice) or takes an explicit operator override; with neither
// it returns 422 and no letter. Nothing internal (ARV, rehab, spread, fee)
// ever reaches the page. The 10-day inspection period is never waived and
// the word "assignable" never appears (lib/offer-letter.test.ts asserts it).
//
// A screen-only red banner warns when the record's price basis is flagged
// (renovated language, or a SIZE-EXTRAPOLATION REVIEW note). It is hidden
// in print media, so what comes out of the printer is a clean letter.

import { NextResponse } from "next/server";
import { getListing } from "@/lib/airtable";
import { assembleOfferLetter, renderOfferLetterHtml } from "@/lib/offer-letter";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";

export const runtime = "nodejs";
export const maxDuration = 60;

function numParam(url: URL, key: string): number | null {
  const raw = url.searchParams.get(key);
  if (raw == null || raw.trim() === "") return null;
  const n = Number(raw.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ recordId: string }> },
) {
  const url = new URL(req.url);

  // ── Auth waterfall (mirror of the guarded admin routes) ──
  const cookieHeader = req.headers.get("cookie");
  if (!hasDashboardSession(cookieHeader)) {
    const env = readAuthEnv();
    const headers = readAuthHeaders(req);
    const authRequired = kvConfigured() || env.cronSecret !== null || env.bearerDevToken !== null;
    if (authRequired) {
      const auth = await authenticate(headers, env, kvProd);
      if (!auth.ok) {
        return NextResponse.json({ error: "unauthorized", reason: auth.reason }, { status: 401 });
      }
    }
  }

  const { recordId } = await params;
  if (!recordId || !/^rec[A-Za-z0-9]{5,}$/.test(recordId)) {
    return NextResponse.json({ error: "bad_record_id", recordId }, { status: 400 });
  }

  let listing: Awaited<ReturnType<typeof getListing>>;
  try {
    listing = await getListing(recordId, { fresh: true });
  } catch (err) {
    return NextResponse.json(
      { error: "listing_fetch_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
  if (!listing) {
    return NextResponse.json({ error: "not_found", recordId }, { status: 404 });
  }

  // `renovatedLanguage` is an intake flag that is not mapped on the Listing
  // type today; read it defensively so the safety banner works either way.
  const renovatedLanguage =
    (listing as unknown as { renovatedLanguage?: boolean | null }).renovatedLanguage ?? null;

  const assembled = assembleOfferLetter({
    address: listing.address,
    city: listing.city,
    state: listing.state,
    zip: listing.zip,
    roughOpenerAmount: listing.roughOpenerAmount ?? null,
    outreachOfferPrice: listing.outreachOfferPrice ?? null,
    priceOverride: numParam(url, "price"),
    emd: numParam(url, "emd"),
    closeDays: numParam(url, "close_days"),
    agentName: listing.agentName,
    renovatedLanguage,
    notes: listing.notes,
  });

  if (!assembled.ok) {
    return NextResponse.json(
      { error: assembled.error, message: assembled.message, recordId },
      { status: assembled.status },
    );
  }

  return new NextResponse(renderOfferLetterHtml(assembled.data), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
