// PropStream MLS-sold → ZIP ARV seed ingest. @agent: appraiser
//
// POST /api/admin/propstream-seed
//   body: the raw PropStream property-export CSV (text/csv or text/plain)
//   (default)   DRY RUN — computes every seed and reports, writes NOTHING
//   ?apply=1    upsert the seeds into ZIP_ARV_Seed
//   ?market=X   stamp a market slug on every seed (e.g. san_antonio_tx)
//   ?state=XX   only ingest rows in this state
//
// Why a CSV body rather than a vendor API: PropStream has no general
// developer API (checked 2026-08-08 — the only API-shaped feature is a
// one-way BatchDialer push). The sanctioned path is the dashboard export,
// so the operator pulls the file and posts it. No credentials are stored,
// no dashboard is driven, nothing is scraped.
//
// See lib/pricing/propstream-seed for the two decisions that make this
// safe: the price column is MLS Amount where status is SOLD (never the
// modelled "Last Sale Amount"), and only Good/Excellent comps may set an
// after-repair value.

import { NextResponse } from "next/server";
import { audit } from "@/lib/audit-log";
import { buildSeedsFromPropstream, type PropstreamRow } from "@/lib/pricing/propstream-seed";
import { upsertZipArvSeed } from "@/lib/zip-arv-seed-store";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvProd, kvConfigured } from "@/lib/maverick/oauth/kv";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Minimal RFC4180-ish CSV reader — PropStream quotes fields containing
 *  commas (addresses, agent names), so a split(",") corrupts the row. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    if (c === "\r") continue;
    field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.replace(/^﻿/, "").trim());
  return rows.slice(1)
    .filter((r) => r.some((c) => c.trim() !== ""))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));
}

function num(s: string | undefined): number | null {
  if (!s) return null;
  const cleaned = s.replace(/[^0-9.]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export async function POST(req: Request): Promise<Response> {
  const t0 = Date.now();
  const url = new URL(req.url);

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

  const apply = url.searchParams.get("apply") === "1";
  const market = url.searchParams.get("market");
  const stateFilter = (url.searchParams.get("state") || "").trim().toUpperCase() || null;

  const text = await req.text();
  if (!text || text.trim().length === 0) {
    return NextResponse.json(
      { error: "empty_body", reason: "POST the PropStream export CSV as the request body." },
      { status: 400 },
    );
  }

  let raw: Record<string, string>[];
  try {
    raw = parseCsv(text);
  } catch (err) {
    return NextResponse.json(
      { error: "csv_parse_failed", reason: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
  if (raw.length === 0) {
    return NextResponse.json({ error: "no_rows", reason: "CSV parsed to zero data rows." }, { status: 400 });
  }
  const required = ["Zip", "MLS Status", "MLS Amount", "Building Sqft", "Total Condition"];
  const missing = required.filter((c) => !(c in raw[0]));
  if (missing.length > 0) {
    return NextResponse.json(
      {
        error: "missing_columns",
        reason: `Export is missing ${missing.join(", ")}. This route needs the MLS columns — re-export with MLS fields included.`,
        columns_seen: Object.keys(raw[0]).slice(0, 20),
      },
      { status: 400 },
    );
  }

  const rows: PropstreamRow[] = raw
    .filter((r) => !stateFilter || (r["State"] || "").trim().toUpperCase() === stateFilter)
    .map((r) => ({
      zip: r["Zip"] ?? null,
      city: r["City"] ?? null,
      state: r["State"] ?? null,
      mlsStatus: r["MLS Status"] ?? null,
      mlsAmount: num(r["MLS Amount"]),
      buildingSqft: num(r["Building Sqft"]),
      totalCondition: r["Total Condition"] ?? null,
    }));

  const fetchedAt = new Date().toISOString();
  const built = buildSeedsFromPropstream({ rows, market, fetchedAt });

  let written = 0;
  let createdCount = 0;
  const writeErrors: Array<{ zip: string; error: string }> = [];
  if (apply) {
    for (const s of built.seeds) {
      try {
        const res = await upsertZipArvSeed(s);
        written++;
        if (res.created) createdCount++;
      } catch (err) {
        writeErrors.push({ zip: s.zip, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  await audit({
    agent: "appraiser",
    event: "propstream_seed_ingest",
    status: writeErrors.length > 0 ? "uncertain" : "confirmed_success",
    inputSummary: { auth_kind: authKind, apply, market, state: stateFilter, csv_rows: raw.length },
    outputSummary: { ...built.totals, written, created: createdCount, write_errors: writeErrors.length },
    ms: Date.now() - t0,
  }).catch(() => {});

  return NextResponse.json({
    ok: true,
    mode: apply ? "apply" : "dry_run",
    market,
    state: stateFilter,
    totals: built.totals,
    written,
    created: createdCount,
    write_errors: writeErrors,
    // Priceable first, then the holds with their reasons — the holds are the
    // part worth reading, since each one names why a ZIP cannot be priced.
    seeds: built.reports
      .slice()
      .sort((a, b) => Number(a.dontPrice) - Number(b.dontPrice) || b.arvCompCount - a.arvCompCount),
    auth_kind: authKind,
    duration_ms: Date.now() - t0,
  });
}
