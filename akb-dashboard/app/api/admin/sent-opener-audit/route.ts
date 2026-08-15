// SENT-OPENER AUDIT — what did we actually text people, versus what the
// evidence says we should have?
// @agent: appraiser
//
// THE OPERATOR, 2026-08-15: "you need to pretend we have ZERO inventory. How
// in the hell are we going to pretend anything in my system is worth a glance?
// Some have overpriced ARVs some have horribly underpriced ARVs with stupid
// outreaches to people like Kirk."
//
// He is right, and this route exists because the previous audits could not
// answer him. /api/admin/arv-sanity-audit compares a stored ARV against the
// record's own comps — useful, but it measures the FIELD. This measures the
// DAMAGE: for every record that already sent a number to a human, it re-derives
// the opener from the record's own sold comps and compares it to the figure the
// seller actually received.
//
// Why that distinction matters: Rough_Opener_Amount is the only number in the
// system that a real person has SEEN. 1708 Cardinal texted $63,000 against
// comps supporting ~$121,000, and the seller replied "165k no more ridiculous
// offers please." That record is not a data-quality statistic — it is a
// relationship with a motivated seller, mispriced by 48%, still recoverable.
// There may be dozens like it. There may also be records we bid ABOVE value,
// where the exposure runs the other way.
//
// CLASSIFICATION (own-comps basis only — no comps, no verdict, never a guess):
//   sent_too_low   — we could have offered materially MORE. Recoverable money:
//                    the seller replied, the relationship survived, and a
//                    re-engage at the derived number is a real conversation.
//   sent_too_high  — the number exceeded what the evidence supports. If the
//                    seller says yes we are committed above value. Exposure.
//   sent_defensible— within tolerance of the own-comps derivation.
//   unpriceable    — own comps cannot support a number (too few, AVM-shaped,
//                    excluded-only). NOT "fine" — unknown, and it says so.
//
// READ-ONLY. Writes nothing, sends nothing, changes no record.
//
//   GET /api/admin/sent-opener-audit            → every record with a sent opener
//   GET /api/admin/sent-opener-audit?live=1     → only reply-bearing threads
//   GET /api/admin/sent-opener-audit?state=MI

import { NextResponse } from "next/server";
import { audit } from "@/lib/audit-log";
import { ownCompsArv } from "@/lib/pricing/own-comps-arv";
import { effectiveWholesaleFee } from "@/lib/pre-contract-math";
import { getMarketForListing, openerArvPctMax } from "@/lib/markets/registry";

export const runtime = "nodejs";
export const maxDuration = 300;

const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
const LISTINGS_TABLE = "tbldMjKBgPiq45Jjs";

const F_ADDR = "fldwvp72hKTfiHHjj";
const F_CITY = "fldjbiNuHXzPzVWFk";
const F_ZIP = "fld9PTaKkgBNtvWbB";
const F_STATE = "fldSlDQvgCyr0J8tI";
const F_SQFT = "fld5bKGJLlN7GmiE9";
const F_ARV = "fldoNZxSZqQsCLIW6";
const F_COMPS = "fldIrL7bFboOEr9vj";
const F_REHAB = "fldyDCVwvn9jfdiES";
const F_REHAB_MID = "fldmup8SvMky9eyag";
const F_OPENER = "fldiOvLQZaLpK7lTD";
const F_BASIS = "fldCjwSV2vLeui8Mf";
const F_STATUS = "fldGIgqwyCJg4uFyv";
const F_LIST = "fld9J3Vi9fTq3zzMU";

/** Threads where a human replied — a mispriced number here is a live
 *  relationship, not a statistic. */
const LIVE_STATUSES = new Set([
  "Response Received", "Negotiating", "Counter Received", "Offer Accepted", "Inbound Lead",
]);

/** Within this fraction of the derived opener, the sent number stands. */
const TOLERANCE = 0.15;

/** The anchor the openers were produced under. */
const ANCHOR = 0.9;

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
  const stateFilter = (url.searchParams.get("state") ?? "").trim().toUpperCase() || null;
  const limit = Math.min(Number(url.searchParams.get("limit")) || 40, 300);

  const rows = await airtableAll(
    LISTINGS_TABLE,
    [F_ADDR, F_CITY, F_ZIP, F_STATE, F_SQFT, F_ARV, F_COMPS, F_REHAB, F_REHAB_MID, F_OPENER, F_BASIS, F_STATUS, F_LIST],
    `NOT({Rough_Opener_Amount}='')`,
  );

  const summary = {
    with_sent_opener: 0,
    unpriceable_no_comps: 0,
    sent_too_low: 0,
    sent_too_high: 0,
    sent_defensible: 0,
    /** The money line: total dollars we left on the table across recoverable
     *  under-offers on threads where a human actually replied. */
    recoverable_upside_live_usd: 0,
    /** The risk line: dollars committed above evidence on live threads. */
    exposure_live_usd: 0,
    by_status: {} as Record<string, number>,
  };

  const findings: Array<Record<string, unknown>> = [];

  for (const r of rows) {
    const f = r.fields;
    const state = str(f[F_STATE]);
    if (stateFilter && state !== stateFilter) continue;
    const status = selName(f[F_STATUS]) ?? "(unset)";
    if (liveOnly && !LIVE_STATUSES.has(status)) continue;

    const sent = n(f[F_OPENER]);
    if (sent == null || sent <= 0) continue;
    summary.with_sent_opener++;
    summary.by_status[status] = (summary.by_status[status] ?? 0) + 1;

    const sqft = n(f[F_SQFT]);
    const own = ownCompsArv({ compsJson: str(f[F_COMPS]), sqft });
    if (!own.ok || own.arv == null) {
      summary.unpriceable_no_comps++;
      findings.push({
        record_id: r.id, address: str(f[F_ADDR]), status, state,
        sent_opener: sent, verdict: "unpriceable",
        reason: own.reason,
        note: "no verdict possible — the record cannot self-price. UNKNOWN, not clean.",
      });
      continue;
    }

    const pct = openerArvPctMax(getMarketForListing({ state, zip: str(f[F_ZIP]) }), state);
    if (pct == null) {
      summary.unpriceable_no_comps++;
      findings.push({
        record_id: r.id, address: str(f[F_ADDR]), status, state,
        sent_opener: sent, verdict: "unpriceable", reason: "no_market_buybox",
      });
      continue;
    }

    const rehab = n(f[F_REHAB]) ?? n(f[F_REHAB_MID]) ?? 0.25 * own.arv;
    const fee = effectiveWholesaleFee(null);
    const ceiling = own.arv * pct - rehab - fee;
    const derived = Math.round((ANCHOR * ceiling) / 250) * 250;
    const delta = derived - sent;
    const live = LIVE_STATUSES.has(status);

    let verdict: "sent_too_low" | "sent_too_high" | "sent_defensible";
    if (derived > 0 && Math.abs(delta) / derived <= TOLERANCE) {
      verdict = "sent_defensible";
      summary.sent_defensible++;
    } else if (delta > 0) {
      verdict = "sent_too_low";
      summary.sent_too_low++;
      if (live) summary.recoverable_upside_live_usd += delta;
    } else {
      verdict = "sent_too_high";
      summary.sent_too_high++;
      if (live) summary.exposure_live_usd += Math.abs(delta);
    }

    findings.push({
      record_id: r.id,
      address: str(f[F_ADDR]),
      city: str(f[F_CITY]), state, status, live,
      list_price: n(f[F_LIST]),
      sent_opener: sent,
      stored_opener_basis: str(f[F_BASIS]),
      own_comps_arv: own.arv,
      own_comps_psf: own.psf != null ? Number(own.psf.toFixed(2)) : null,
      comp_count: own.compCount,
      stored_arv: n(f[F_ARV]),
      rehab_used: Math.round(rehab),
      derived_opener: derived,
      delta,
      delta_pct: derived > 0 ? Number(((delta / derived) * 100).toFixed(1)) : null,
      verdict,
    });
  }

  // Live threads first, then biggest absolute mispricing — that ordering is
  // the operator's call list, not a report.
  findings.sort((a, b) => {
    const al = a.live === true ? 1 : 0, bl = b.live === true ? 1 : 0;
    if (al !== bl) return bl - al;
    return Math.abs(Number(b.delta ?? 0)) - Math.abs(Number(a.delta ?? 0));
  });

  const payload = {
    ok: true,
    ms: Date.now() - t0,
    note:
      "READ-ONLY. Compares the number a HUMAN RECEIVED against the number this " +
      "record's own sold comps support. 'unpriceable' means UNKNOWN, never clean. " +
      "Records without comps must be backfilled before they can be judged at all.",
    scope: { live_only: liveOnly, state: stateFilter, tolerance_pct: TOLERANCE * 100 },
    summary,
    findings: findings.slice(0, limit),
  };

  await audit({
    agent: "appraiser",
    event: "sent_opener_audit",
    status: "confirmed_success",
    ms: Date.now() - t0,
    inputSummary: { live_only: liveOnly, state: stateFilter },
    outputSummary: {
      with_sent_opener: summary.with_sent_opener,
      sent_too_low: summary.sent_too_low,
      sent_too_high: summary.sent_too_high,
      unpriceable: summary.unpriceable_no_comps,
      recoverable_upside_live_usd: Math.round(summary.recoverable_upside_live_usd),
      exposure_live_usd: Math.round(summary.exposure_live_usd),
    },
    decision: "measured_only_no_writes",
  });

  return NextResponse.json(payload);
}
