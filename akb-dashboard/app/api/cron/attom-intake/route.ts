// ATTOM auto-intake cron (Ship 2 — replaces PropStream intake path).
// @agent: scout
//
// GET /api/cron/attom-intake[?dry_run=1]
//
// Daily 03:00 UTC. For each operator-configured target ZIP:
//   fetch ATTOM snapshot → normalize → intake-filter → dedup vs
//   Listings_V1 by address → (live) create new records / (dry) report.
//
// SAFETY DEFAULTS (per ship order):
//   - DRY RUN by default. Writes only when ATTOM_INTAKE_LIVE="true" AND
//     the request does not pass ?dry_run=1. First execution is dry —
//     operator reviews output before flipping ATTOM_INTAKE_LIVE.
//   - ZIP list is operator-provided via ATTOM_TARGET_ZIPS (comma-sep).
//     NOT autodiscovered. Empty → clean no-op that surfaces the blocker.
//   - New live records get Outreach_Status="" (unset) so H2 Crier picks
//     them up automatically.
//
// OPEN BLOCKERS (surfaced 2026-05-25 — cron is inert/zero-yield until
// resolved): (a) ATTOM /property/snapshot lacks active list price +
// listing date → intake filter rejects all candidates on
// list_price_missing until the ATTOM listings/MLS endpoint is wired;
// (b) ATTOM_TARGET_ZIPS not yet configured; (c) response field paths
// need validation against a live dry-run.

import { NextResponse } from "next/server";
import { getListings } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import { fetchListingsByZip } from "@/lib/crawler/sources/attom";
import {
  filterIntakeCandidates,
  normalizeAddressKey,
  type IntakeCandidate,
} from "@/lib/crawler/intake-filter";

export const runtime = "nodejs";
export const maxDuration = 300;

const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
const LISTINGS_TABLE = "tbldMjKBgPiq45Jjs";

/** Operator-provided target ZIPs (comma-separated). NOT autodiscovered. */
function readTargetZips(): string[] {
  return (process.env.ATTOM_TARGET_ZIPS ?? "")
    .split(",")
    .map((z) => z.trim())
    .filter((z) => /^\d{5}$/.test(z));
}

/** Live write of a new intake record. Outreach_Status="" so H2 Crier
 *  picks it up. Only called in live mode. */
async function createIntakeListing(c: IntakeCandidate): Promise<string> {
  if (!AIRTABLE_PAT) throw new Error("AIRTABLE_PAT not set");
  const url = `https://api.airtable.com/v0/${BASE_ID}/${LISTINGS_TABLE}`;
  const fields: Record<string, unknown> = {
    Address: c.address ?? "",
    City: c.city ?? "",
    State: c.state ?? "",
    Zip: c.zip ?? "",
    Outreach_Status: "",
    Verification_Notes: `[${new Date().toISOString()}] ATTOM auto-intake (${c.sourceId}).`,
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

  // ── Auth waterfall (mirrors data-federation-pull / rehab-vision-retry) ──
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

  // ── Dry-run resolution: dry unless explicitly live AND not forced dry ──
  const liveEnv = process.env.ATTOM_INTAKE_LIVE === "true";
  const forcedDry = url.searchParams.get("dry_run") === "1";
  const dryRun = !liveEnv || forcedDry;

  // ── ZIP gate (stall + surface if unconfigured) ──────────────────────
  const zips = readTargetZips();
  if (zips.length === 0) {
    await audit({
      agent: "scout",
      event: "attom_intake_no_zips",
      status: "uncertain",
      inputSummary: { auth_kind: authKind, dry_run: dryRun },
      outputSummary: { blocker: "ATTOM_TARGET_ZIPS not configured", duration_ms: Date.now() - t0 },
    });
    return NextResponse.json({
      ok: true,
      blocked: "no_target_zips_configured",
      detail: "Set ATTOM_TARGET_ZIPS (comma-separated SA ZIPs) to activate. NOT autodiscovered per ship order.",
      dry_run: dryRun,
      auth_kind: authKind,
      duration_ms: Date.now() - t0,
    });
  }

  // ── Existing-address dedup set ──────────────────────────────────────
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
    dry_run: dryRun,
    zips_scanned: zips.length,
    raw_candidates: 0,
    accepted: 0,
    rejected: 0,
    duplicates: 0,
    written: 0,
    would_write: [] as Array<{ sourceId: string; address: string | null; zip: string | null }>,
    reject_reason_counts: {} as Record<string, number>,
    per_zip_errors: [] as Array<{ zip: string; error: string }>,
    credentialed: true,
  };
  const now = new Date();

  for (const zip of zips) {
    const fetchResult = await fetchListingsByZip(zip);
    if (!fetchResult.credentialed) {
      summary.credentialed = false;
      summary.per_zip_errors.push({ zip, error: "ATTOM_API_KEY not set" });
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

    for (const c of accepted) {
      const key = normalizeAddressKey(c.address);
      if (key && existingKeys.has(key)) {
        summary.duplicates++;
        continue;
      }
      summary.accepted++;
      if (dryRun) {
        summary.would_write.push({ sourceId: c.sourceId, address: c.address, zip: c.zip });
      } else {
        try {
          await createIntakeListing(c);
          summary.written++;
          if (key) existingKeys.add(key); // prevent intra-run dupes
        } catch (err) {
          summary.per_zip_errors.push({
            zip,
            error: `write ${c.sourceId}: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    }
  }

  await audit({
    agent: "scout",
    event: dryRun ? "attom_intake_dry_run" : "attom_intake_live",
    status: summary.per_zip_errors.length > 0 ? "uncertain" : "confirmed_success",
    inputSummary: { auth_kind: authKind, zips: zips.length, dry_run: dryRun },
    outputSummary: {
      raw: summary.raw_candidates,
      accepted: summary.accepted,
      rejected: summary.rejected,
      duplicates: summary.duplicates,
      written: summary.written,
      credentialed: summary.credentialed,
      reject_reasons: summary.reject_reason_counts,
    },
    ms: Date.now() - t0,
  });

  return NextResponse.json({ ok: true, auth_kind: authKind, duration_ms: Date.now() - t0, ...summary });
}
