// PUBLIC DEAL PAGE API — the one intentionally unauthenticated read path in
// this app (2026-09-05). Backs app/d/[recordId] for wholesale buyers who
// have no dashboard login. See lib/dispo/public-deal.ts for the allowlist
// that keeps everything private (list price, contract/offer prices, ARV,
// rehab, fee, spread, agent, notes) out of the response — this route trusts
// that projection completely and never spreads a raw Listing itself.
//
// GET /api/public/deal/[recordId] — NO AUTH. Do not add auth here without
// updating the "/d/" public-path allowance in components/AuthGate.tsx and
// the middleware that carves out this prefix; they exist together.

import { NextResponse } from "next/server";
import { getListing } from "@/lib/airtable";
import { publicDealView } from "@/lib/dispo/public-deal";

export const runtime = "nodejs";
export const maxDuration = 15;

const RECORD_ID_RE = /^rec[A-Za-z0-9]{14}$/;

function notFound() {
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ recordId: string }> },
) {
  const { recordId } = await params;

  if (!RECORD_ID_RE.test(recordId)) {
    return notFound();
  }

  let listing;
  try {
    listing = await getListing(recordId, { fresh: true });
  } catch (err) {
    return NextResponse.json({ error: "lookup_failed", detail: String(err).slice(0, 200) }, { status: 502 });
  }

  if (!listing) return notFound();

  const view = publicDealView(listing);
  if (!view) return notFound();

  return NextResponse.json(view, {
    headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" },
  });
}
