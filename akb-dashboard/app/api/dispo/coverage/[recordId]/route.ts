// DISPO COVERAGE API — "how covered is this deal, buyer-wise" for one
// listing. @agent: scout
//
// GET /api/dispo/coverage/[recordId] — AUTHENTICATED, same waterfall as
// /api/dispo/package/[recordId] (dashboard cookie OR the OAuth/cron/
// dev-bearer waterfall). Loads the listing and the buyers rolodex, ranks the
// shortlist, and reports the buyer-coverage verdict (operator ruling
// 2026-09-18, Spine recnmCDflZ43MEsDp) plus a name-only top-5 slice — no
// emails or phones in the response, this is a status check, not a call list.

import { NextResponse } from "next/server";
import { getListing, getBuyers } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import { buildBuyerShortlist } from "@/lib/dispo/buyer-shortlist";
import { assessBuyerCoverage } from "@/lib/dispo/buyer-coverage";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";

export const runtime = "nodejs";
export const maxDuration = 30;

const RECORD_ID_RE = /^rec[A-Za-z0-9]{14}$/;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ recordId: string }> },
) {
  const t0 = Date.now();

  // ── Auth waterfall (+ dashboard cookie) ── copied verbatim from
  // /api/dispo/package/[recordId].
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

  const { recordId } = await params;
  if (!RECORD_ID_RE.test(recordId)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  let listing;
  try {
    listing = await getListing(recordId, { fresh: true });
  } catch (err) {
    console.error("[dispo/coverage] lookup failed:", String(err).slice(0, 200));
    return NextResponse.json({ error: "lookup_failed" }, { status: 502 });
  }
  if (!listing) {
    return NextResponse.json({ error: "not_found", recordId }, { status: 404 });
  }

  let buyers;
  try {
    buyers = await getBuyers();
  } catch (err) {
    console.error("[dispo/coverage] buyers fetch failed:", String(err).slice(0, 200));
    return NextResponse.json({ error: "buyers_fetch_failed" }, { status: 502 });
  }

  const price = listing.mao ?? listing.listPrice ?? null;
  const shortlist = buildBuyerShortlist({
    subject: {
      recordId,
      address: listing.address,
      zip: listing.zip ?? null,
      state: listing.state ?? null,
      city: listing.city ?? null,
      price,
    },
    buyers,
  });
  const coverage = assessBuyerCoverage(shortlist);

  await audit({
    agent: "scout",
    event: "dispo_coverage_viewed",
    status: "confirmed_success",
    recordId,
    inputSummary: { auth_kind: authKind },
    outputSummary: { level: coverage.level, geoBuyers: coverage.geoBuyers, fundedBuyers: coverage.fundedBuyers },
    ms: Date.now() - t0,
  }).catch(() => {});

  return NextResponse.json(
    {
      ok: true,
      recordId,
      coverage,
      top: shortlist.top.slice(0, 5).map((b) => ({
        name: b.name,
        geo: b.geo,
        pofUsable: b.pofUsable,
        hasEmail: !!b.email,
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
