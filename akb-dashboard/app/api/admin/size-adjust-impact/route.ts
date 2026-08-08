// SIZE-ADJUST IMPACT — how many held records does the size fix actually free?
// @agent: appraiser
//
// The operator's question, verbatim: "SO WHATS THE FIX?! This system is junk if
// we only find 12 properties a day to send offers on."
//
// The wall is 335 records holding on opener_hold_no_value_basis out of 405
// eligible. Its breakdown (by_hold_reason, 2026-08-07 18:30Z):
//   cash_no_pencil        175   <- the math ran and the number did not work
//   seed_dont_price        84
//   failed_corroboration   42   <- size_extrapolation is the observed flag
//   needs_seed             17
//   over_list_tripwire     17
//
// cash_no_pencil + failed_corroboration = 217, and both are downstream of ARV.
// 2302 S Randolph proved ARV can be systematically wrong: the seed applies one
// ZIP-median $/sqft regardless of house size, and in 46203 the measured slope
// is -$42 per 1,000 sqft. Randolph (790 sqft, smaller than all 12 comps) was
// understated by ~$26,000 of ARV, which is what pushed it into cash_no_pencil.
//
// THIS ROUTE ANSWERS "HOW MANY" BEFORE ANYTHING SHIPS. It is READ-ONLY. It
// recomputes ARV with lib/pricing/size-adjusted-psf and reports, per record,
// the old ARV, the new ARV, and whether the MAO crosses from non-viable to
// viable. No writes, no vendor calls — every comp it needs is already stored
// in the ZIP seeds.
//
// If the number comes back small, the fix is not worth shipping and we look
// elsewhere. That is the point of measuring first.

import { NextResponse } from "next/server";
import { audit } from "@/lib/audit-log";
import { compsFromReceipts, sizeAdjustedPsf } from "@/lib/pricing/size-adjusted-psf";
import { openerArvPctMax, getMarketForListing } from "@/lib/markets/registry";

export const runtime = "nodejs";
export const maxDuration = 300;

const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
const LISTINGS_TABLE = "tbldMjKBgPiq45Jjs";
const SEED_TABLE = "tblduJzD1gShaGDQQ";

const F_ADDR = "fldwvp72hKTfiHHjj";
const F_ZIP = "fld9PTaKkgBNtvWbB";
const F_STATE = "fldSlDQvgCyr0J8tI";
const F_SQFT = "fld5bKGJLlN7GmiE9";
const F_REHAB = "fldyDCVwvn9jfdiES";
const F_LIST = "fld9J3Vi9fTq3zzMU";
const S_ZIP = "fldP4jKE5O70F5q3j";
const S_RECEIPTS = "fldKfj1ue1n2E0q3x";
const S_MEDIAN = "fldiylhhxi06oj20L";
const S_CONF = "fldAyg7324APeD9yv";

const DEFAULT_FEE = 10_000;

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
  const fee = Number(url.searchParams.get("fee")) || DEFAULT_FEE;

  // Seeds → comps by ZIP.
  const seedRows = await airtableAll(SEED_TABLE, [S_ZIP, S_RECEIPTS, S_MEDIAN, S_CONF]);
  const seeds = new Map<string, { comps: ReturnType<typeof compsFromReceipts>; median: number | null }>();
  for (const r of seedRows) {
    const zip = r.fields[S_ZIP];
    if (typeof zip !== "string") continue;
    seeds.set(zip, {
      comps: compsFromReceipts(r.fields[S_RECEIPTS] as string | undefined),
      median: typeof r.fields[S_MEDIAN] === "number" ? (r.fields[S_MEDIAN] as number) : null,
    });
  }

  const listings = await airtableAll(
    LISTINGS_TABLE,
    [F_ADDR, F_ZIP, F_STATE, F_SQFT, F_REHAB, F_LIST],
    `AND({Live_Status}='Active', NOT({Building_SqFt}=''))`,
  );

  let examined = 0, noSeed = 0, unchanged = 0, adjusted = 0, freed = 0, worsened = 0;
  const bySource: Record<string, number> = {};
  const winners: Array<Record<string, unknown>> = [];

  for (const r of listings) {
    const f = r.fields;
    const zip = typeof f[F_ZIP] === "string" ? (f[F_ZIP] as string) : null;
    const sqft = typeof f[F_SQFT] === "number" ? (f[F_SQFT] as number) : null;
    const rehab = typeof f[F_REHAB] === "number" ? (f[F_REHAB] as number) : null;
    if (!zip || !sqft || !rehab) continue;
    const seed = zip ? seeds.get(zip) : undefined;
    if (!seed || seed.median == null) { noSeed++; continue; }
    examined++;

    const adj = sizeAdjustedPsf({ comps: seed.comps, subjectSqft: sqft, seedMedianPsf: seed.median });
    bySource[adj.source] = (bySource[adj.source] ?? 0) + 1;
    if (adj.source !== "size_fit" || adj.psf == null) { unchanged++; continue; }
    adjusted++;

    const state = typeof f[F_STATE] === "string" ? (f[F_STATE] as string) : null;
    const pct = openerArvPctMax(getMarketForListing({ state, zip }), state);
    if (pct == null) continue;

    const oldArv = seed.median * sqft;
    const newArv = adj.psf * sqft;
    const oldMao = pct * oldArv - rehab - fee;
    const newMao = pct * newArv - rehab - fee;

    // The number that matters: records that could not carry an offer before
    // and can now. MIN_ASSIGNMENT_FEE is $5,000, so a MAO below that is not a
    // deal even if it is positive.
    const wasViable = oldMao >= 5_000;
    const nowViable = newMao >= 5_000;
    if (!wasViable && nowViable) {
      freed++;
      if (winners.length < 25) {
        winners.push({
          address: f[F_ADDR], zip, sqft,
          seed_psf: seed.median, adjusted_psf: adj.psf,
          old_arv: Math.round(oldArv), new_arv: Math.round(newArv),
          old_mao: Math.round(oldMao), new_mao: Math.round(newMao),
          rehab, list: f[F_LIST], detail: adj.detail,
        });
      }
    } else if (wasViable && !nowViable) {
      // The fix cuts BOTH ways. A large house in a small-house ZIP was being
      // OVER-valued; correcting it removes an offer we should not have made.
      worsened++;
    }
  }

  const summary = {
    examined, no_seed: noSeed, adjusted, unchanged,
    by_source: bySource,
    FREED_records_that_can_now_carry_an_offer: freed,
    removed_records_that_were_overvalued: worsened,
    fee_assumed: fee,
    sample_freed: winners,
    ms: Date.now() - t0,
  };

  await audit({
    agent: "appraiser",
    event: "size_adjust_impact",
    status: "confirmed_success",
    inputSummary: { fee },
    outputSummary: { ...summary, sample_freed: winners.length },
    decision: `${freed} freed, ${worsened} removed, of ${adjusted} size-adjusted`,
  });

  return NextResponse.json(summary);
}
