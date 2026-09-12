// DISPO PACKAGE API — the operator's copy kit for one deal. @agent: scribe
//
// GET /api/dispo/package/[recordId] — AUTHENTICATED (dashboard cookie OR the
// OAuth/cron/dev-bearer waterfall, same shape as /api/maverick/card). It is a
// read, but it hands back every photo URL plus ready-to-paste copy for a deal
// that may not be public yet, so it does not get the /api/public/deal
// treatment.
//
// It builds publicDealProjection, NOT publicDealView: the operator needs the
// package BEFORE Dispo_Public is flipped (you write the post, then you go
// live). The projection is still the buyer-safe allowlist, so nothing private
// can reach the copy — the gate that is skipped is the visibility switch, not
// the leak guard. `dispoPublic` rides along in the response so the page can say
// out loud whether the /d/ link the copy points at is actually live yet.

import { NextResponse } from "next/server";
import { getListing } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import { composeDispoPackage } from "@/lib/dispo/package";
import { publicDealProjection } from "@/lib/dispo/public-deal";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import { resolveBaseUrl } from "@/lib/maverick/decision-card";

export const runtime = "nodejs";
export const maxDuration = 30;

const RECORD_ID_RE = /^rec[A-Za-z0-9]{14}$/;

/** Last resort when neither DASHBOARD_BASE_URL nor a Vercel host is set —
 *  same fallback lib/reply-alert.ts uses, so a link is never half-built. */
const FALLBACK_BASE_URL = "https://coach-pulse-ten.vercel.app";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ recordId: string }> },
) {
  const t0 = Date.now();

  // ── Auth waterfall (+ dashboard cookie) ──
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
    console.error("[dispo/package] lookup failed:", String(err).slice(0, 200));
    return NextResponse.json({ error: "lookup_failed" }, { status: 502 });
  }
  if (!listing) {
    return NextResponse.json({ error: "not_found", recordId }, { status: 404 });
  }

  const view = publicDealProjection(listing);
  const nowIso = new Date().toISOString();
  const pkg = composeDispoPackage(view, {
    baseUrl: resolveBaseUrl() ?? FALLBACK_BASE_URL,
    nowIso,
  });

  await audit({
    agent: "scribe",
    event: "dispo_package_viewed",
    status: "confirmed_success",
    recordId,
    inputSummary: { auth_kind: authKind, address: listing.address },
    outputSummary: {
      dispo_public: listing.dispoPublic === true,
      photos: pkg.photos.length,
      has_price: view.assignmentPrice != null,
    },
    ms: Date.now() - t0,
  }).catch(() => {});

  return NextResponse.json(
    {
      ok: true,
      ...pkg,
      dispoPublic: listing.dispoPublic === true,
      contractExecutedAt: listing.contractExecutedAt ?? null,
      generatedAt: nowIso,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
