// ARV BACKTEST — grade our own predictions against sales that actually closed.
// @agent: appraiser
//
// THE OPERATOR, 2026-08-15: "I feel like this entire system has been reporting
// success, when undeserved... I need to trust what is happening in the
// background. How do all the other companies I mentioned, trust what they are
// selling to their subscribers?"
//
// The honest answer is that most of them never find out. A lead vendor sells a
// conversation and refunds a bad one; an ARV tool sells a number a human is
// expected to verify. None of them learn whether the number was right, because
// the customer buys the house and disappears.
//
// THIS SYSTEM CAN LEARN. It pulls county deed ledgers and ATTOM sold-comps
// every day, so when a property we priced later sells, that sale price lands
// in a comp array we already own. No new vendor, no new spend: the answer is
// already in the table, unread — exactly like ARV_Comp_Details_JSON was.
//
// METHOD. Index every comp entry across every record by normalized street
// line. For each record carrying a prediction, look up its OWN address in that
// index and keep only sales dated AFTER our ARV_Validated_At stamp — a sale
// recorded before the stamp could have been an INPUT to the prediction, which
// would be grading our homework against our own answer key.
//
// It grades BOTH bases on the SAME sales:
//   stored   — Real_ARV_Median, the field the pricer used before 97d6968
//   own_comps— what lib/pricing/own-comps-arv derives from the record's comps
// "The new basis is better" stops being a claim and becomes a measurement.
//
// HONEST LIMIT, stated up front because it changes how every number here must
// be read: our ARV is AFTER-REPAIR value; most sales in this pipeline are AS-IS
// distressed sales. A correct ARV SHOULD exceed the as-is sale price by roughly
// rehab plus margin, so a median ratio above 1.0 is expected and is NOT error.
// What this can honestly detect is (a) the SHAPE of the distribution, (b) absurd
// tails — 4x over or below the actual sale is broken regardless of condition,
// and (c) which of the two bases lands closer to reality on identical inputs.
// It cannot produce a clean "we are N% accurate". Anyone reporting that number
// from this data is fooling themselves.
//
// The band test is the cleaner signal: did the actual sale's $/sqft land INSIDE
// the min-max range of the comps we priced from? That compares like to like and
// is not confounded by condition — if the real sale sits outside the band our
// own evidence spanned, the evidence was wrong, full stop.
//
// READ-ONLY.
//   GET /api/admin/arv-backtest[?limit=25][&min_days=0]

import { NextResponse } from "next/server";
import { audit } from "@/lib/audit-log";
import { ownCompsArv, parseOwnComps } from "@/lib/pricing/own-comps-arv";
import { normalizeStreetLine } from "@/lib/arv-intelligence";

export const runtime = "nodejs";
export const maxDuration = 300;

const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
const LISTINGS_TABLE = "tbldMjKBgPiq45Jjs";

const F_ADDR = "fldwvp72hKTfiHHjj";
const F_SQFT = "fld5bKGJLlN7GmiE9";
const F_ARV = "fldoNZxSZqQsCLIW6";
const F_ARV_AT = "fldvHDqtftWehMJR7";
const F_COMPS = "fldIrL7bFboOEr9vj";
const F_STATE = "fldSlDQvgCyr0J8tI";
const F_STATUS = "fldGIgqwyCJg4uFyv";

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const selName = (v: unknown): string | null =>
  typeof v === "object" && v !== null && "name" in v ? String((v as { name: unknown }).name) : str(v);

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

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

interface SaleObservation {
  price: number;
  sqft: number;
  psf: number;
  saleDate: string;
  fromRecordId: string;
}

export async function GET(req: Request) {
  const t0 = Date.now();
  if (!AIRTABLE_PAT) return NextResponse.json({ error: "AIRTABLE_PAT not set" }, { status: 500 });
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit")) || 25, 200);
  // Require the sale to postdate our stamp by at least this many days, so a
  // same-week comp refresh cannot masquerade as an out-of-sample outcome.
  const minDays = Number(url.searchParams.get("min_days"));
  const minGapDays = Number.isFinite(minDays) && minDays >= 0 ? minDays : 0;

  const rows = await airtableAll(LISTINGS_TABLE, [
    F_ADDR, F_SQFT, F_ARV, F_ARV_AT, F_COMPS, F_STATE, F_STATUS,
  ]);

  // ── Index every comp entry we own, by normalized street line ────────────
  const salesByStreet = new Map<string, SaleObservation[]>();
  for (const r of rows) {
    const raw = str(r.fields[F_COMPS]);
    if (!raw) continue;
    // parseOwnComps drops exclusion receipts and junk but keeps address/date.
    for (const c of parseOwnComps(raw, new Date())) {
      if (!c.address || !c.saleDate) continue;
      const key = normalizeStreetLine(c.address);
      if (!key) continue;
      const arr = salesByStreet.get(key) ?? [];
      arr.push({
        price: c.price, sqft: c.sqft, psf: c.psf,
        saleDate: c.saleDate, fromRecordId: r.id,
      });
      salesByStreet.set(key, arr);
    }
  }

  const summary = {
    records_scanned: rows.length,
    distinct_addresses_in_comp_index: salesByStreet.size,
    predictions_with_a_later_sale: 0,
    stored_arv_graded: 0,
    own_comps_arv_graded: 0,
    /** median (our ARV ÷ actual sale price). >1 is EXPECTED — see header. */
    stored_median_ratio: null as number | null,
    own_comps_median_ratio: null as number | null,
    /** |ln(ratio)| — symmetric error, so 2x over and 2x under score equally.
     *  THIS is the head-to-head: lower means closer to reality. */
    stored_median_abs_log_error: null as number | null,
    own_comps_median_abs_log_error: null as number | null,
    /** Did the real sale's $/sqft land inside the comp band we priced from?
     *  The condition-independent signal. */
    sale_psf_inside_our_comp_band: 0,
    sale_psf_outside_our_comp_band: 0,
    absurd_stored: 0,
    absurd_own_comps: 0,
  };

  const findings: Array<Record<string, unknown>> = [];
  const storedRatios: number[] = [];
  const ownRatios: number[] = [];
  const storedErr: number[] = [];
  const ownErr: number[] = [];

  for (const r of rows) {
    const addr = str(r.fields[F_ADDR]);
    const stampedAt = str(r.fields[F_ARV_AT]);
    if (!addr || !stampedAt) continue;
    const stampMs = Date.parse(stampedAt);
    if (!Number.isFinite(stampMs)) continue;

    const key = normalizeStreetLine(addr);
    if (!key) continue;
    const candidates = (salesByStreet.get(key) ?? []).filter((s) => {
      const t = Date.parse(s.saleDate);
      if (!Number.isFinite(t)) return false;
      return (t - stampMs) / 86_400_000 >= minGapDays && t > stampMs;
    });
    if (!candidates.length) continue;

    // Earliest qualifying sale after the stamp = the outcome closest to what
    // we predicted. Later re-sales reflect a different property state.
    candidates.sort((a, b) => Date.parse(a.saleDate) - Date.parse(b.saleDate));
    const sale = candidates[0];
    summary.predictions_with_a_later_sale++;

    const sqft = n(r.fields[F_SQFT]);
    const storedArv = n(r.fields[F_ARV]);
    const own = ownCompsArv({ compsJson: str(r.fields[F_COMPS]), sqft });

    const storedRatio = storedArv != null && sale.price > 0 ? storedArv / sale.price : null;
    const ownRatio = own.ok && own.arv != null && sale.price > 0 ? own.arv / sale.price : null;

    if (storedRatio != null && storedRatio > 0) {
      summary.stored_arv_graded++;
      storedRatios.push(storedRatio);
      storedErr.push(Math.abs(Math.log(storedRatio)));
      if (storedRatio >= 4 || storedRatio <= 0.25) summary.absurd_stored++;
    }
    if (ownRatio != null && ownRatio > 0) {
      summary.own_comps_arv_graded++;
      ownRatios.push(ownRatio);
      ownErr.push(Math.abs(Math.log(ownRatio)));
      if (ownRatio >= 4 || ownRatio <= 0.25) summary.absurd_own_comps++;
    }

    // Band test — condition-independent: did reality land inside the range our
    // own evidence spanned?
    let inBand: boolean | null = null;
    if (own.ok && own.usable.length) {
      const psfs = own.usable.map((c) => c.psf);
      const lo = Math.min(...psfs), hi = Math.max(...psfs);
      inBand = sale.psf >= lo && sale.psf <= hi;
      if (inBand) summary.sale_psf_inside_our_comp_band++;
      else summary.sale_psf_outside_our_comp_band++;
    }

    findings.push({
      record_id: r.id,
      address: addr,
      state: str(r.fields[F_STATE]),
      status: selName(r.fields[F_STATUS]),
      predicted_at: stampedAt,
      actual_sale_date: sale.saleDate,
      actual_sale_price: sale.price,
      actual_sale_psf: Number(sale.psf.toFixed(2)),
      observed_via_record: sale.fromRecordId,
      stored_arv: storedArv,
      stored_ratio: storedRatio != null ? Number(storedRatio.toFixed(2)) : null,
      own_comps_arv: own.ok ? own.arv : null,
      own_comps_ratio: ownRatio != null ? Number(ownRatio.toFixed(2)) : null,
      own_comp_count: own.compCount,
      sale_psf_inside_our_comp_band: inBand,
      winner:
        storedRatio != null && ownRatio != null
          ? Math.abs(Math.log(ownRatio)) < Math.abs(Math.log(storedRatio)) ? "own_comps" : "stored"
          : null,
    });
  }

  summary.stored_median_ratio = median(storedRatios);
  summary.own_comps_median_ratio = median(ownRatios);
  summary.stored_median_abs_log_error = median(storedErr);
  summary.own_comps_median_abs_log_error = median(ownErr);

  const headToHead = findings.filter((f) => f.winner != null);
  const ownWins = headToHead.filter((f) => f.winner === "own_comps").length;

  // Worst misses first — those are the ones worth reading.
  findings.sort((a, b) => {
    const ae = Math.abs(Math.log(Number(a.own_comps_ratio ?? a.stored_ratio ?? 1) || 1));
    const be = Math.abs(Math.log(Number(b.own_comps_ratio ?? b.stored_ratio ?? 1) || 1));
    return be - ae;
  });

  const payload = {
    ok: true,
    ms: Date.now() - t0,
    method:
      "For each record with an ARV stamp, find a sale of THAT address recorded in any comp " +
      "array we own, dated AFTER the stamp (out-of-sample), and grade both ARV bases against it.",
    honest_limits:
      "Our ARV is AFTER-REPAIR; most sales here are AS-IS distressed. A median ratio >1 is " +
      "EXPECTED and is not error. Trust the head-to-head (abs log error, same sales, both bases), " +
      "the absurd tails (>=4x or <=0.25x), and the band test. Do NOT quote a % accuracy from this.",
    summary,
    head_to_head: {
      graded_both_ways: headToHead.length,
      own_comps_closer: ownWins,
      stored_closer: headToHead.length - ownWins,
    },
    worst_misses: findings.slice(0, limit),
  };

  await audit({
    agent: "appraiser",
    event: "arv_backtest",
    status: "confirmed_success",
    ms: Date.now() - t0,
    inputSummary: { min_gap_days: minGapDays },
    outputSummary: {
      matched: summary.predictions_with_a_later_sale,
      stored_median_abs_log_error: summary.stored_median_abs_log_error,
      own_comps_median_abs_log_error: summary.own_comps_median_abs_log_error,
      own_comps_closer: ownWins,
      graded_both_ways: headToHead.length,
    },
    decision: "measured_only_no_writes",
  });

  return NextResponse.json(payload);
}
