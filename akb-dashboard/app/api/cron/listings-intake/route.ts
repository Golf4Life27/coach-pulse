// Listings auto-intake cron (Ship 2 — RentCast source).
// @agent: scout
//
// GET /api/cron/listings-intake[?dry_run=1]
//
// Daily 03:00 UTC. For each operator-configured target ZIP:
//   RentCast /listings/sale → normalize → intake-filter → dedup vs
//   Listings_V1 by address → (live) create / (dry) report.
//
// Source-neutral route name (RentCast today; pluggable later). ATTOM
// adapter is retained for INV-023 Underwriter deep-math, not intake.
//
// Safety rails (per ship order):
//   - DRY RUN by default; writes only when CRAWLER_INTAKE_LIVE="true"
//     AND not ?dry_run=1. First execution is dry — operator reviews.
//   - CRAWLER_TARGET_ZIPS (comma-sep) operator-provided; NOT
//     autodiscovered. Empty → clean no-op surfacing the blocker.
//   - RentCast quota gate (rentcastQuotaAllows): hard per-run cap +
//     soft weekly-remaining estimate. Over budget → stall + Spine-write.
//   - MAVERICK_CRON_ENABLED gate, dedup-by-address, Outreach_Status=""
//     on live write so H2 Crier picks it up.

import { NextResponse } from "next/server";
import { getListings } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import { writeState } from "@/lib/maverick/write-state";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import { fetchListingsByZip } from "@/lib/crawler/sources/rentcast";
import {
  filterIntakeCandidates,
  normalizeAddressKey,
  type IntakeCandidate,
} from "@/lib/crawler/intake-filter";
import { rentcastQuotaAllows, computeBurnRate } from "@/lib/maverick/rentcast-burn-rate";
import { fetchExternalRentCastState } from "@/lib/maverick/sources/external-rentcast";
import { fetchVercelKvAuditState } from "@/lib/maverick/sources/vercel-kv-audit";

export const runtime = "nodejs";
export const maxDuration = 300;

const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
const LISTINGS_TABLE = "tbldMjKBgPiq45Jjs";

const PER_RUN_CAP = Number(process.env.RENTCAST_INTAKE_MAX_CALLS_PER_RUN ?? "30");

function readTargetZips(): string[] {
  return (process.env.CRAWLER_TARGET_ZIPS ?? "")
    .split(",")
    .map((z) => z.trim())
    .filter((z) => /^\d{5}$/.test(z));
}

/** Best-effort estimate of remaining RentCast quota this cycle. Optimistic
 *  (burn-rate consumed estimate counts pricing-agent events only) — used as
 *  the SOFT gate; the per-run cap is the hard one. null on any failure. */
async function estimateRentcastRemaining(): Promise<number | null> {
  try {
    const [rc, au] = await Promise.all([
      fetchExternalRentCastState(),
      fetchVercelKvAuditState(),
    ]);
    if (!rc.ok || !rc.data) return null;
    const now = new Date();
    const daysElapsedInCycle = now.getUTCDate(); // days into the month
    const burn = computeBurnRate({
      rentcast: rc.data,
      audit: au.ok ? au.data : null,
      windowHours: 24,
      daysElapsedInCycle,
    });
    return burn.estimated_calls_remaining;
  } catch {
    return null;
  }
}

async function createIntakeListing(c: IntakeCandidate): Promise<string> {
  if (!AIRTABLE_PAT) throw new Error("AIRTABLE_PAT not set");
  const url = `https://api.airtable.com/v0/${BASE_ID}/${LISTINGS_TABLE}`;
  const fields: Record<string, unknown> = {
    Address: c.address ?? "",
    City: c.city ?? "",
    State: c.state ?? "",
    Zip: c.zip ?? "",
    Outreach_Status: "",
    Verification_Notes: `[${new Date().toISOString()}] RentCast auto-intake (${c.sourceId}).`,
  };
  if (c.propertyType) fields["Property_Type"] = c.propertyType;
  if (c.beds != null) fields["Bedrooms"] = c.beds;
  if (c.listPrice != null) fields["List_Price"] = c.listPrice;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${AIRTABLE_PAT}`, "Content-Type": "application/json" },
    body: JSON.stringify({ records: [{ fields }], typecast: true }),
  });
  if (!res.ok) throw new Error(`intake create ${res.status}: ${await res.text().catch(() => "")}`);
  const body = (await res.json()) as { records?: Array<{ id: string }> };
  const id = body.records?.[0]?.id;
  if (!id) throw new Error("intake create returned no record id");
  return id;
}

export async function GET(req: Request) {
  const t0 = Date.now();
  const url = new URL(req.url);

  // ── Auth waterfall ──────────────────────────────────────────────
  const cookieHeader = req.headers.get("cookie");
  const isDashboard = hasDashboardSession(cookieHeader);
  let authKind: "dashboard_session" | "oauth" | "cron" | "bearer_dev" | "none" = "none";
  if (isDashboard) {
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
  if (authKind === "cron" && process.env.MAVERICK_CRON_ENABLED !== "true") {
    return NextResponse.json({ error: "cron_disabled" }, { status: 503 });
  }

  const liveEnv = process.env.CRAWLER_INTAKE_LIVE === "true";
  const forcedDry = url.searchParams.get("dry_run") === "1";
  const dryRun = !liveEnv || forcedDry;

  // ── ZIP gate ────────────────────────────────────────────────────
  const zips = readTargetZips();
  if (zips.length === 0) {
    await audit({
      agent: "scout",
      event: "listings_intake_no_zips",
      status: "uncertain",
      inputSummary: { auth_kind: authKind, dry_run: dryRun },
      outputSummary: { blocker: "CRAWLER_TARGET_ZIPS not configured", duration_ms: Date.now() - t0 },
    });
    return NextResponse.json({
      ok: true,
      blocked: "no_target_zips_configured",
      detail: "Set CRAWLER_TARGET_ZIPS (comma-separated) to activate. NOT autodiscovered per ship order.",
      dry_run: dryRun,
      auth_kind: authKind,
      duration_ms: Date.now() - t0,
    });
  }

  // ── RentCast quota gate (stall + Spine-write if would exceed) ───
  const estimatedRemaining = await estimateRentcastRemaining();
  const quota = rentcastQuotaAllows({
    estimatedRemaining,
    callsNeeded: zips.length,
    perRunCap: PER_RUN_CAP,
  });
  if (!quota.allowed) {
    await audit({
      agent: "scout",
      event: "listings_intake_quota_stall",
      status: "uncertain",
      inputSummary: { auth_kind: authKind, calls_needed: quota.callsNeeded, per_run_cap: quota.perRunCap },
      outputSummary: { reason: quota.reason, estimated_remaining: estimatedRemaining, duration_ms: Date.now() - t0 },
    });
    try {
      await writeState({
        event_type: "decision",
        attribution_agent: "scout",
        title: `Listings-intake cron STALLED on RentCast quota (${quota.reason})`,
        description:
          `listings-intake aborted before spending RentCast quota. reason=${quota.reason}, ` +
          `calls_needed=${quota.callsNeeded}, per_run_cap=${quota.perRunCap}, ` +
          `estimated_weekly_remaining=${estimatedRemaining ?? "unknown"}. No ZIPs fetched. ` +
          `Raise RENTCAST_INTAKE_MAX_CALLS_PER_RUN or wait for quota reset.`,
      });
    } catch (err) {
      console.error("[listings-intake] Spine write (quota stall) failed:", err);
    }
    return NextResponse.json({
      ok: true,
      blocked: "rentcast_quota",
      reason: quota.reason,
      calls_needed: quota.callsNeeded,
      per_run_cap: quota.perRunCap,
      estimated_remaining: estimatedRemaining,
      dry_run: dryRun,
      duration_ms: Date.now() - t0,
    });
  }

  // ── Existing-address dedup set ──────────────────────────────────
  let existingKeys: Set<string>;
  try {
    const listings = await getListings();
    existingKeys = new Set(listings.map((l) => normalizeAddressKey(l.address)));
  } catch (err) {
    return NextResponse.json(
      { error: "listings_fetch_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  const summary = {
    source: "rentcast",
    dry_run: dryRun,
    zips_scanned: zips.length,
    raw_candidates: 0,
    accepted: 0,
    rejected: 0,
    duplicates: 0,
    written: 0,
    per_zip: [] as Array<{ zip: string; raw: number; accepted: number }>,
    would_write: [] as Array<{ sourceId: string; address: string | null; zip: string | null; listPrice: number | null }>,
    reject_reason_counts: {} as Record<string, number>,
    per_zip_errors: [] as Array<{ zip: string; error: string }>,
    credentialed: true,
  };
  const now = new Date();

  for (const zip of zips) {
    const fetchResult = await fetchListingsByZip(zip);
    if (!fetchResult.credentialed) {
      summary.credentialed = false;
      summary.per_zip_errors.push({ zip, error: "RENTCAST_API_KEY not set" });
      continue;
    }
    if (fetchResult.error) {
      summary.per_zip_errors.push({ zip, error: fetchResult.error });
      continue;
    }
    summary.raw_candidates += fetchResult.candidates.length;

    const { accepted, rejected } = filterIntakeCandidates(fetchResult.candidates, now);
    summary.rejected += rejected.length;
    for (const r of rejected) {
      for (const reason of r.reasons) {
        summary.reject_reason_counts[reason] = (summary.reject_reason_counts[reason] ?? 0) + 1;
      }
    }

    let zipAccepted = 0;
    for (const c of accepted) {
      const key = normalizeAddressKey(c.address);
      if (key && existingKeys.has(key)) {
        summary.duplicates++;
        continue;
      }
      summary.accepted++;
      zipAccepted++;
      if (dryRun) {
        summary.would_write.push({ sourceId: c.sourceId, address: c.address, zip: c.zip, listPrice: c.listPrice });
      } else {
        try {
          await createIntakeListing(c);
          summary.written++;
          if (key) existingKeys.add(key);
        } catch (err) {
          summary.per_zip_errors.push({
            zip,
            error: `write ${c.sourceId}: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    }
    summary.per_zip.push({ zip, raw: fetchResult.candidates.length, accepted: zipAccepted });
  }

  await audit({
    agent: "scout",
    event: dryRun ? "listings_intake_dry_run" : "listings_intake_live",
    status: summary.per_zip_errors.length > 0 ? "uncertain" : "confirmed_success",
    inputSummary: { auth_kind: authKind, zips: zips.length, dry_run: dryRun, source: "rentcast" },
    outputSummary: {
      raw: summary.raw_candidates,
      accepted: summary.accepted,
      rejected: summary.rejected,
      duplicates: summary.duplicates,
      written: summary.written,
      reject_reasons: summary.reject_reason_counts,
      per_zip: summary.per_zip,
    },
    ms: Date.now() - t0,
  });

  return NextResponse.json({ ok: true, auth_kind: authKind, duration_ms: Date.now() - t0, ...summary });
}
