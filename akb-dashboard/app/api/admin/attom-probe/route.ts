// ATTOM coverage probe — operator-triggered, never automated.
// @agent: appraiser
//
// GET /api/admin/attom-probe?state=MI[&zips=48206,48202][&sample_addresses=...]
//
// Two integrity checks the brief requires BEFORE flipping any market's
// arv_source_verified to true:
//
//   1. SOLD-COMP COVERAGE per state. Probe N representative ZIPs / addresses
//      and report: how many ATTOM /salescomparables calls return real
//      recorded sales vs zero/errors. Quantifies the non-disclosure gap in
//      TX/TN against the disclosure-state baseline in MI.
//
//   2. ASSESSOR COVERAGE. Same addresses; report how many return a positive
//      annual tax + assessed value. ATTOM assessor is supposed to be
//      nationwide (tax roll is public) — this confirms.
//
// REPORT-ONLY. No writes. No persistence. Operator reads the JSON and
// decides whether to flip arv_source_verified for a market.

import { NextResponse } from "next/server";
import {
  fetchSalesComparables,
  fetchAssessor,
  fetchPropertyCharacteristics,
  buildAddress2,
  type AttomFetchOutcome,
  type SoldComp,
  type AssessorRecord,
  type PropertyCharacteristics,
} from "@/lib/attom/property";
import { audit } from "@/lib/audit-log";
import {
  authenticate,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";

export const runtime = "nodejs";
export const maxDuration = 120;

// Curated probe addresses. Operator can override via ?sample_addresses.
// Each: "street|city|state|zip". A small set keeps the credit burn low.
const DEFAULT_PROBES: Record<string, string[]> = {
  MI: [
    "1973 Sturtevant St|Detroit|MI|48206",
    "1620 W Grand Blvd|Detroit|MI|48208",
    "3211 Tyler St|Detroit|MI|48238",
  ],
  TX: [
    "5435 Callaghan Rd|San Antonio|TX|78228",
    "23 Fields Ave|San Antonio|TX|78228",
    "11114 Dreamland Dr|San Antonio|TX|78230",
  ],
  TN: [
    "3446 Cook Rd|Memphis|TN|38109",
    "346 Modder Ave|Memphis|TN|38109",
    "910 Green St|Memphis|TN|38106",
  ],
};

interface ProbeRow {
  address1: string;
  address2: string;
  state: string;
  comps: { count: number; status: number | null; error: string | null };
  assessor: { annualTaxes: number | null; assessedValue: number | null; status: number | null; error: string | null };
  characteristics: { beds: number | null; baths: number | null; sqft: number | null; yearBuilt: number | null; status: number | null };
}

function parseProbes(raw: string | null): Array<{ street: string; city: string; state: string; zip: string }> {
  if (!raw) return [];
  return raw
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line) => {
      const [street, city, state, zip] = line.split("|").map((x) => x.trim());
      return { street, city, state, zip };
    })
    .filter((p) => p.street && p.city && p.state && p.zip);
}

async function handle(req: Request) {
  const t0 = Date.now();
  const env = readAuthEnv();
  const headers = readAuthHeaders(req);
  const auth = await authenticate(headers, env, kvProd);
  if (!auth.ok) {
    return NextResponse.json(
      { error: "unauthorized", reason: auth.reason, message: "Requires CRON_SECRET (Bearer + x-vercel-cron:1) or a valid OAuth token." },
      { status: 401 },
    );
  }
  if (auth.kind !== "cron" && auth.kind !== "oauth") {
    return NextResponse.json({ error: "unauthorized", reason: "unsupported_auth_kind" }, { status: 401 });
  }
  if (auth.kind === "oauth" && !kvConfigured()) {
    return NextResponse.json({ error: "kv_not_configured" }, { status: 500 });
  }

  const url = new URL(req.url);
  const stateFilter = (url.searchParams.get("state") ?? "").toUpperCase();
  const sampleAddressesParam = url.searchParams.get("sample_addresses");

  const explicit = parseProbes(sampleAddressesParam);
  const fromDefaults = stateFilter
    ? (DEFAULT_PROBES[stateFilter] ?? []).map((line) => {
        const [street, city, state, zip] = line.split("|");
        return { street, city, state, zip };
      })
    : Object.values(DEFAULT_PROBES).flat().map((line) => {
        const [street, city, state, zip] = line.split("|");
        return { street, city, state, zip };
      });
  const probes = explicit.length > 0 ? explicit : fromDefaults;

  if (probes.length === 0) {
    return NextResponse.json(
      { error: "no_probes", message: "Provide ?state=MI|TX|TN or ?sample_addresses=street|city|state|zip;..." },
      { status: 400 },
    );
  }

  const rows: ProbeRow[] = [];
  for (const p of probes) {
    const address2 = buildAddress2(p.city, p.state, p.zip);
    const [compsOut, assessorOut, charOut]: [
      AttomFetchOutcome<SoldComp[]>,
      AttomFetchOutcome<AssessorRecord>,
      AttomFetchOutcome<PropertyCharacteristics>,
    ] = await Promise.all([
      fetchSalesComparables({ street: p.street, city: p.city, state: p.state, zip: p.zip, minComps: 5, maxComps: 20, searchRadiusMi: 1 }),
      fetchAssessor({ address1: p.street, address2 }),
      fetchPropertyCharacteristics({ address1: p.street, address2 }),
    ]);
    rows.push({
      address1: p.street,
      address2,
      state: p.state,
      comps: {
        count: compsOut.data?.length ?? 0,
        status: compsOut.status,
        error: compsOut.error,
      },
      assessor: {
        annualTaxes: assessorOut.data?.annualTaxes ?? null,
        assessedValue: assessorOut.data?.assessedValue ?? null,
        status: assessorOut.status,
        error: assessorOut.error,
      },
      characteristics: {
        beds: charOut.data?.beds ?? null,
        baths: charOut.data?.baths ?? null,
        sqft: charOut.data?.sqft ?? null,
        yearBuilt: charOut.data?.yearBuilt ?? null,
        status: charOut.status,
      },
    });
  }

  const byState: Record<string, { probed: number; comps_ok: number; assessor_ok: number; chars_ok: number; comp_count_total: number }> = {};
  for (const r of rows) {
    const k = r.state;
    byState[k] ??= { probed: 0, comps_ok: 0, assessor_ok: 0, chars_ok: 0, comp_count_total: 0 };
    byState[k].probed++;
    if (r.comps.count > 0) { byState[k].comps_ok++; byState[k].comp_count_total += r.comps.count; }
    if ((r.assessor.annualTaxes ?? 0) > 0) byState[k].assessor_ok++;
    if (r.characteristics.beds != null || r.characteristics.sqft != null) byState[k].chars_ok++;
  }
  const summary = Object.entries(byState).map(([state, s]) => ({
    state,
    probed: s.probed,
    comp_coverage: `${s.comps_ok}/${s.probed} (${((s.comps_ok / s.probed) * 100).toFixed(0)}%)`,
    avg_comps_per_hit: s.comps_ok > 0 ? (s.comp_count_total / s.comps_ok).toFixed(1) : "n/a",
    assessor_coverage: `${s.assessor_ok}/${s.probed} (${((s.assessor_ok / s.probed) * 100).toFixed(0)}%)`,
    characteristics_coverage: `${s.chars_ok}/${s.probed} (${((s.chars_ok / s.probed) * 100).toFixed(0)}%)`,
    arv_source_verifiable: s.comps_ok === s.probed && s.probed >= 3
      ? "YES — sold-comp coverage 100% across probes; safe to flip arv_source_verified for this market."
      : `NO — sold-comp coverage ${((s.comps_ok / s.probed) * 100).toFixed(0)}% (${s.comps_ok}/${s.probed}). May need MLS feed for ARV; ATTOM assessor still works for taxes.`,
  }));

  await audit({
    agent: "appraiser",
    event: "attom_probe",
    status: "confirmed_success",
    inputSummary: { state: stateFilter || "all", probe_count: probes.length, auth_kind: auth.kind },
    outputSummary: { by_state: byState },
    ms: Date.now() - t0,
  });

  return NextResponse.json({
    ok: true,
    note: "REPORT-ONLY ATTOM coverage probe. Use the summary to decide whether to flip arv_source_verified per market.",
    state_filter: stateFilter || null,
    summary,
    rows,
    elapsed_ms: Date.now() - t0,
  });
}

export async function GET(req: Request) { return handle(req); }
export async function POST(req: Request) { return handle(req); }
