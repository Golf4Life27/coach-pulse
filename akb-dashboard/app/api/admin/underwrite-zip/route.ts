// Underwrite-zip admin station (operator 2026-06-09).
// @agent: appraiser
//
// GET /api/admin/underwrite-zip
//   ?zips=48227 (required, comma list of 5-digit ZIPs)
//   ?apply=1&confirm=UNDERWRITE-ZIP-YYYY-MM-DD  → write Underwritten_MAO
//   default: DRY-RUN — report per-lead track-aware MAO + opener-vs-MAO
//
// Underwrites each scoped listing off the seeded ZIP-store buyer-median for
// its cohort-default track (distressed as-is → landlord). Landlord track:
// Investor_MAO = Buyer_Median (as-is purchase price, NO flip-rehab subtraction);
// Your_MAO = Investor_MAO − wholesale fee. Pure helpers live in
// lib/track-aware-underwrite.ts so the outreach guard and this station never
// drift. NO Firecrawl / RentCast / Vision spend — math only, against the
// seeded ZIP median.
//
// Reports the MAO distribution + how many 65%-of-list openers land at-or-
// under MAO (clean), get capped, or get skipped. This is the proof needed
// before a controlled batch can plan a send.

import { NextResponse } from "next/server";
import { getListings, updateListingRecord } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import {
  computeListingMao,
  loadUnderwriteContextForListings,
} from "@/lib/track-aware-underwrite";
import { openerMaoGuard } from "@/lib/outreach-economics";

export const runtime = "nodejs";
export const maxDuration = 60;

function todayToken(now: Date = new Date()): string {
  return `UNDERWRITE-ZIP-${now.toISOString().slice(0, 10)}`;
}

function round250(n: number): number {
  return Math.ceil(n / 250) * 250;
}

export async function GET(req: Request) {
  const t0 = Date.now();

  const cookieHeader = req.headers.get("cookie");
  let authKind = "none";
  if (hasDashboardSession(cookieHeader)) authKind = "dashboard_session";
  else {
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
  const zipScope = new Set(
    (url.searchParams.get("zips") ?? "").split(",").map((z) => z.trim()).filter((z) => /^\d{5}$/.test(z)),
  );
  if (zipScope.size === 0) {
    return NextResponse.json({ error: "zips_required", reason: "?zips=48227 (comma list) is required" }, { status: 400 });
  }
  const applyRequested = url.searchParams.get("apply") === "1";
  const confirm = url.searchParams.get("confirm");
  const apply = applyRequested && confirm === todayToken();
  const gateBlockedReason =
    !applyRequested ? "dry_run_default"
    : confirm !== todayToken() ? "confirm_token_missing_or_stale"
    : null;

  let listings;
  try {
    listings = await getListings();
  } catch (err) {
    return NextResponse.json({ error: "listings_fetch_failed", message: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
  const scoped = listings.filter((l) => zipScope.has((l.zip ?? "").trim()));
  if (scoped.length === 0) {
    return NextResponse.json({ ok: true, mode: "dry_run", scope: [...zipScope], scoped_count: 0, summary: { underwritten: 0 }, results: [], duration_ms: Date.now() - t0 });
  }

  const uwCtx = await loadUnderwriteContextForListings(scoped);

  // FAIL LOUDLY (operator 2026-06-10): if the ZIP-store load surfaced any
  // errors, abort the station — the underwrite step is the chokepoint and a
  // silent partial pass would write wrong MAOs. Apply-mode 502s; dry-run
  // returns the errors so the operator can see exactly what's wrong (the
  // AIRTABLE_PAT scope mismatch is the expected cause).
  if (uwCtx.errors.size > 0) {
    const errs = [...uwCtx.errors.entries()].map(([key, message]) => ({ key, message }));
    const detail = `Buyer_Median_ZIP store read failed for ${errs.length} key(s); refusing to underwrite. ` +
      `Likely cause: AIRTABLE_PAT scope excludes Buyer_Median_ZIP (tbleoqYRBmnJq5V0Z). Extend the PAT to include the table.`;
    return NextResponse.json(
      { ok: false, error: "zip_store_unavailable", detail, errors: errs, scope: [...zipScope], scoped_count: scoped.length, duration_ms: Date.now() - t0 },
      { status: 502 },
    );
  }

  const results: Array<{
    recordId: string;
    address: string;
    zip: string;
    listPrice: number | null;
    track: string;
    buyerMedian: number | null;
    investorMao: number | null;
    yourMao: number | null;
    formula: string;
    holdReason: string | null;
    baseOpener: number | null;
    openerDisposition: "clean" | "capped" | "skipped" | "hold_no_mao";
    cappedOpener: number | null;
    wrote: boolean;
    writeError: string | null;
  }> = [];

  let underwritten = 0;
  let clean = 0;
  let capped = 0;
  let skipped = 0;
  let holdNoMao = 0;
  const maoValues: number[] = [];

  for (const l of scoped) {
    const uw = computeListingMao(
      {
        state: l.state ?? null,
        zip: l.zip ?? null,
        redFlags: (l.redFlags as never) ?? null,
        distressBucket: l.distressBucket ?? null,
        distressScore: l.distressScore ?? null,
        estRehab: l.estRehab ?? null,
      },
      uwCtx,
    );
    if (uw.yourMao != null) {
      underwritten++;
      maoValues.push(uw.yourMao);
    }

    // 65%-of-list opener (the door-opener carried as MAO_V1 today).
    const baseOpener = typeof l.listPrice === "number" && l.listPrice > 0 ? round250(l.listPrice * 0.65) : null;
    const guard = openerMaoGuard({ baseOpener, mao: uw.yourMao, priceable: true });
    let disposition: "clean" | "capped" | "skipped" | "hold_no_mao";
    if (uw.yourMao == null) disposition = "hold_no_mao";
    else if (!guard.ok) disposition = "skipped";
    else if (guard.capped) disposition = "capped";
    else disposition = "clean";
    if (disposition === "clean") clean++;
    else if (disposition === "capped") capped++;
    else if (disposition === "skipped") skipped++;
    else holdNoMao++;

    let wrote = false;
    let writeError: string | null = null;
    if (apply && uw.yourMao != null) {
      try {
        // Persist the underwritten MAO ceiling to Underwritten_MAO (the
        // operative offer at negotiation/DD stage per Phase 20.2 v1.3 —
        // a sensible home for a track-aware landlord ceiling here).
        await updateListingRecord(l.id, { Underwritten_MAO: uw.yourMao });
        wrote = true;
      } catch (err) {
        writeError = err instanceof Error ? err.message : String(err);
      }
    }

    results.push({
      recordId: l.id,
      address: l.address,
      zip: (l.zip ?? "").trim(),
      listPrice: l.listPrice,
      track: uw.track,
      buyerMedian: uw.buyerMedian,
      investorMao: uw.investorMao,
      yourMao: uw.yourMao,
      formula: uw.formula,
      holdReason: uw.holdReason,
      baseOpener,
      openerDisposition: disposition,
      cappedOpener: guard.capped ? guard.opener : null,
      wrote,
      writeError,
    });
  }

  const distribution = (() => {
    if (maoValues.length === 0) return null;
    const sorted = [...maoValues].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
    return {
      n: sorted.length,
      min: sorted[0],
      median,
      max: sorted[sorted.length - 1],
    };
  })();

  await audit({
    agent: "appraiser",
    event: apply ? "underwrite_zip_apply" : "underwrite_zip_dry_run",
    status: "confirmed_success",
    inputSummary: { auth_kind: authKind, zips: [...zipScope], scoped: scoped.length },
    outputSummary: { underwritten, clean, capped, skipped, hold_no_mao: holdNoMao, distribution },
    ms: Date.now() - t0,
  });

  return NextResponse.json({
    ok: true,
    mode: apply ? "apply" : "dry_run",
    gate_blocked: gateBlockedReason,
    scope: [...zipScope],
    scoped_count: scoped.length,
    summary: {
      underwritten,
      hold_no_mao: holdNoMao,
      opener_clean: clean,
      opener_capped: capped,
      opener_skipped: skipped,
      distribution,
    },
    results,
    duration_ms: Date.now() - t0,
  });
}
