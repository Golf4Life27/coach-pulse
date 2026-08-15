// ARV SANITY AUDIT — how wrong are our ARVs, measured against the comps we
// already store on each record?
// @agent: appraiser
//
// The operator, 2026-08-14: "the system needs good math, which I have been
// begging for, for about 2 months and you keep assuring me it's sound…then we
// find more failures."
//
// That is a fair account of what happened. Every pricing failure found this
// week was caught by hand, one record at a time, because he handed over the
// record. That is not an audit — and "it's sound" was never a measurement,
// it was an absence of evidence.
//
// This route is the measurement. Every listing stores its own comps in
// ARV_Comp_Details_JSON; that field is read into the Listing type and consumed
// by NOTHING. 9360 Cheyenne carried a $154,177 ARV (=$107.81/sqft) on top of
// 44 comps whose median is ~$55 and whose top print is $95 — the evidence to
// catch it was on the record the entire time.
//
// READ-ONLY, ON PURPOSE. It writes nothing and holds nothing. Wiring the check
// into the corroboration gate is a threshold decision that needs these numbers
// first: a rail tightened blind against a pipeline full of inflated ARVs would
// take outreach volume to zero, which is the opposite of what it is for.
//
//   GET /api/admin/arv-sanity-audit             → whole Active pipeline
//   GET /api/admin/arv-sanity-audit?live=1      → only reply-bearing statuses
//   GET /api/admin/arv-sanity-audit?limit=50    → widen the ranked sample

import { NextResponse } from "next/server";
import { audit } from "@/lib/audit-log";
import { checkArvAgainstOwnComps } from "@/lib/pricing/arv-vs-own-comps";

export const runtime = "nodejs";
export const maxDuration = 300;

const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
const LISTINGS_TABLE = "tbldMjKBgPiq45Jjs";

const F_ADDR = "fldwvp72hKTfiHHjj";
const F_ZIP = "fld9PTaKkgBNtvWbB";
const F_STATE = "fldSlDQvgCyr0J8tI";
const F_SQFT = "fld5bKGJLlN7GmiE9";
const F_ARV = "fldoNZxSZqQsCLIW6";
const F_ARV_CONF = "fldDcIiUajkvi8Wz3";
const F_COMPS = "fldIrL7bFboOEr9vj";
const F_OPENER = "fldiOvLQZaLpK7lTD";
const F_STATUS = "fldGIgqwyCJg4uFyv";
const F_LIST = "fld9J3Vi9fTq3zzMU";

/** Statuses where a wrong ARV is not theoretical — a number went out, or a
 *  human is mid-conversation about one. */
const LIVE_STATUSES = new Set([
  "Texted", "Emailed", "Response Received", "Negotiating",
  "Counter Received", "Offer Accepted", "Inbound Lead",
]);

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const selName = (v: unknown): string | null =>
  typeof v === "object" && v !== null && "name" in v ? String((v as { name: unknown }).name) : str(v);

async function airtableAll(table: string, fields: string[], formula?: string) {
  const out: Array<{ id: string; fields: Record<string, unknown> }> = [];
  let offset: string | undefined;
  do {
    const p = new URLSearchParams();
    fields.forEach((f) => p.append("fields[]", f));
    p.set("returnFieldsByFieldId", "true");
    p.set("pageSize", "100");
    if (formula) p.set("filterByFormula", formula);
    if (offset) p.set("offset", offset);
    const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${table}?${p.toString()}`, {
      headers: { Authorization: `Bearer ${AIRTABLE_PAT}` }, cache: "no-store",
    });
    if (!res.ok) break;
    const b = (await res.json()) as { records?: typeof out; offset?: string };
    out.push(...(b.records ?? []));
    offset = b.offset;
  } while (offset);
  return out;
}

export async function GET(req: Request) {
  const t0 = Date.now();
  if (!AIRTABLE_PAT) return NextResponse.json({ error: "AIRTABLE_PAT not set" }, { status: 500 });
  const url = new URL(req.url);
  const liveOnly = url.searchParams.get("live") === "1";
  const limit = Math.min(Number(url.searchParams.get("limit")) || 25, 200);

  const rows = await airtableAll(
    LISTINGS_TABLE,
    [F_ADDR, F_ZIP, F_STATE, F_SQFT, F_ARV, F_ARV_CONF, F_COMPS, F_OPENER, F_STATUS, F_LIST],
    `AND({Live_Status}='Active', NOT({Real_ARV_Median}=''), NOT({ARV_Comp_Details_JSON}=''))`,
  );

  const summary = {
    scanned: 0,
    unchecked: 0,
    clean: 0,
    outside_band: 0,
    by_rail: {} as Record<string, number>,
    by_unchecked_reason: {} as Record<string, number>,
    /** The part that costs money: a bad ARV on a record that already sent a
     *  number or is mid-conversation. */
    outside_band_live: 0,
    outside_band_with_opener: 0,
    by_status: {} as Record<string, { scanned: number; outside: number }>,
    by_confidence: {} as Record<string, { scanned: number; outside: number }>,
  };

  const findings: Array<Record<string, unknown>> = [];

  for (const r of rows) {
    const f = r.fields;
    const status = selName(f[F_STATUS]) ?? "(unset)";
    if (liveOnly && !LIVE_STATUSES.has(status)) continue;

    const arv = n(f[F_ARV]);
    const sqft = n(f[F_SQFT]);
    const conf = selName(f[F_ARV_CONF]) ?? "(none)";
    summary.scanned++;
    summary.by_status[status] ??= { scanned: 0, outside: 0 };
    summary.by_status[status].scanned++;
    summary.by_confidence[conf] ??= { scanned: 0, outside: 0 };
    summary.by_confidence[conf].scanned++;

    const v = checkArvAgainstOwnComps({ arv, sqft, compsJson: str(f[F_COMPS]) });
    if (!v.checked) {
      summary.unchecked++;
      const key = (v.reason ?? "unknown").split(" ")[0];
      summary.by_unchecked_reason[key] = (summary.by_unchecked_reason[key] ?? 0) + 1;
      continue;
    }
    if (!v.outsideBand) { summary.clean++; continue; }

    summary.outside_band++;
    summary.by_rail[v.rail ?? "?"] = (summary.by_rail[v.rail ?? "?"] ?? 0) + 1;
    summary.by_status[status].outside++;
    summary.by_confidence[conf].outside++;

    const opener = n(f[F_OPENER]);
    if (LIVE_STATUSES.has(status)) summary.outside_band_live++;
    if (opener != null) summary.outside_band_with_opener++;

    // Dollar size of the error: stored ARV vs what this record's own comps
    // imply at their median. Used purely to RANK the report.
    const impliedArv = v.medianPsf != null && sqft != null ? v.medianPsf * sqft : null;
    const arvDelta = impliedArv != null && arv != null ? arv - impliedArv : null;

    findings.push({
      record_id: r.id,
      address: str(f[F_ADDR]),
      status,
      arv_confidence: conf,
      list_price: n(f[F_LIST]),
      opener_sent: opener,
      sqft,
      stored_arv: arv,
      stored_psf: v.subjectPsf != null ? Number(v.subjectPsf.toFixed(2)) : null,
      comp_median_psf: v.medianPsf != null ? Number(v.medianPsf.toFixed(2)) : null,
      comp_max_psf: v.maxPsf != null ? Number(v.maxPsf.toFixed(2)) : null,
      comp_count: v.compCount,
      ratio_to_median: v.ratioToMedian != null ? Number(v.ratioToMedian.toFixed(2)) : null,
      implied_arv: impliedArv != null ? Math.round(impliedArv) : null,
      arv_delta: arvDelta != null ? Math.round(arvDelta) : null,
      rail: v.rail,
      reason: v.reason,
    });
  }

  // Rank by absolute dollar error, live conversations first — that ordering is
  // the operator's work queue, not just a report.
  findings.sort((a, b) => {
    const aLive = LIVE_STATUSES.has(String(a.status)) ? 1 : 0;
    const bLive = LIVE_STATUSES.has(String(b.status)) ? 1 : 0;
    if (aLive !== bLive) return bLive - aLive;
    return Math.abs(Number(b.arv_delta ?? 0)) - Math.abs(Number(a.arv_delta ?? 0));
  });

  const payload = {
    ok: true,
    ms: Date.now() - t0,
    note:
      "READ-ONLY. Nothing was written, held, or re-priced. checked=false is UNKNOWN, not clean.",
    scope: liveOnly ? "live_statuses_only" : "all_active_with_comps",
    summary,
    worst: findings.slice(0, limit),
  };

  await audit({
    agent: "appraiser",
    event: "arv_sanity_audit",
    status: "confirmed_success",
    ms: Date.now() - t0,
    inputSummary: { scope: payload.scope, limit },
    outputSummary: {
      scanned: summary.scanned,
      outside_band: summary.outside_band,
      outside_band_live: summary.outside_band_live,
      by_rail: summary.by_rail,
    },
    decision: "measured_only_no_writes",
  });

  return NextResponse.json(payload);
}
