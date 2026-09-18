// ADMIN VERIFY PROBE — exposes the REAL production Firecrawl markdown for
// one listing URL, scoped exactly the way buildResolvedResult scopes it
// (2026-09-18).
// @agent: scout
//
// WHY: the Sold/Pending bare-status-line detector was tuned yesterday
// against curl-stripped HTML, never against a real Firecrawl scan, and
// shipped anyway. Its first production pass marked 27 listings Off Market;
// a live sample showed most were still active — a comps-card "SOLD AUG 31,
// 2026" line had leaked past scopeStatusText. Nobody could see the actual
// scoped text production checks. This route is that view. REPORT-ONLY: it
// never writes Live_Status / Outreach_Status and detectBareStatusLines here
// is diagnostic-only, exactly as it is in production (see firecrawl.ts
// detectInactiveMarkers — NOT wired to bare-status-lines since the rollback).
//
// GET /api/admin/verify-probe?url=<encoded portal URL>&record_id=<optional rec...>
//
// Auth waterfall matches app/api/admin/thread-tail/route.ts exactly. ONE
// Firecrawl scrape per call (verifyListingByUrl — no discovery /search leg).

import { NextResponse } from "next/server";
import { verifyListingByUrl } from "@/lib/crawler/sources/firecrawl";
import { buildVerifyProbeDiagnostic } from "@/lib/admin/verify-probe";
import { audit } from "@/lib/audit-log";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";

export const runtime = "nodejs";
export const maxDuration = 60;

// Same portal allowlist verifyListing already trusts as listing-detail
// pages (firecrawl.ts PREFERRED_DOMAINS) — anything else is refused before
// a credit is ever spent.
const ALLOWED_PORTAL_DOMAINS = ["redfin.com", "zillow.com", "realtor.com", "homes.com", "trulia.com"];

function isAllowedPortalHost(host: string): boolean {
  const h = host.toLowerCase();
  return ALLOWED_PORTAL_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
}

export async function GET(req: Request) {
  const t0 = Date.now();

  // ── Auth waterfall — mirrors app/api/admin/thread-tail/route.ts.
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

  const reqUrl = new URL(req.url);
  const rawUrl = reqUrl.searchParams.get("url");
  const recordId = reqUrl.searchParams.get("record_id");

  if (recordId && !recordId.startsWith("rec")) {
    return NextResponse.json({ ok: false, error: "record_id must start with 'rec'" }, { status: 400 });
  }

  let target: URL;
  try {
    target = new URL(rawUrl ?? "");
  } catch {
    return NextResponse.json({ ok: false, error: "url required and must be a valid http(s) URL" }, { status: 400 });
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return NextResponse.json({ ok: false, error: "url must be http or https" }, { status: 400 });
  }
  if (!isAllowedPortalHost(target.hostname)) {
    return NextResponse.json(
      { ok: false, error: "url host is not an allowed portal domain", url_host: target.hostname },
      { status: 400 },
    );
  }

  const urlHost = target.hostname;

  try {
    // ONE Firecrawl scrape — debug for matched-phrase context, includeMarkdown
    // for the raw text this diagnostic needs (never duplicated by a second fetch).
    const fc = await verifyListingByUrl(target.toString(), null, { debug: true, includeMarkdown: true });
    const markdown = fc.rawMarkdown ?? "";
    const diagnostic = buildVerifyProbeDiagnostic(markdown);

    await audit({
      agent: "scout",
      event: "verify_probe",
      status: fc.error ? "confirmed_failure" : "confirmed_success",
      recordId: recordId ?? undefined,
      inputSummary: { url_host: urlHost, record_id: recordId ?? null },
      ms: Date.now() - t0,
    });

    return NextResponse.json({
      ok: !fc.error,
      url_host: urlHost,
      resolved: fc.resolved,
      still_active: fc.stillActive,
      matched_inactive_markers: fc.matchedInactiveMarkers,
      bare_status_lines: diagnostic.bare_status_lines,
      status_scope: diagnostic.status_scope,
      raw: diagnostic.raw,
      comps_header_found: diagnostic.comps_header_found,
      credits: fc.creditsUsed,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await audit({
      agent: "scout",
      event: "verify_probe",
      status: "confirmed_failure",
      recordId: recordId ?? undefined,
      inputSummary: { url_host: urlHost, record_id: recordId ?? null },
      error,
      ms: Date.now() - t0,
    }).catch(() => {});
    return NextResponse.json({ ok: false, error }, { status: 502 });
  }
}
