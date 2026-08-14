// Sends per ZIP — the yield signal the crawl portfolio is ranked on.
// @agent: scout
//
// ZIP_Registry scores a ZIP on Records_Ingested_30d and Accept_Rate_30d. Both
// count records accepted INTO the table, and neither has any relationship to
// money. Proven the expensive way on 2026-08-13: 1,326 San Antonio records had
// been accepted and had produced ZERO sends — a stale PropStream import that
// failed the PO-02 freshness gate by 28x — and under the incumbent metric that
// ZIP set scored as a triumph.
//
// So the portfolio ranks on SENDS: Last_Outbound_At, the timestamp written when
// an outbound actually fires. It is the first event in the funnel where the
// machine has done its job — a real number reached a real counterparty.
//
// MEASURED at introduction, 90-day window, 378 sends across the 100-ZIP
// circuit: Atlanta 84 from 9 ZIPs, Indianapolis 56 from 10, Birmingham 56 from
// 10, Detroit 77 from 32, Cleveland 8 from 10, Youngstown 3 from 6. THIRTY-
// THREE of the 100 ZIPs had produced nothing at all.

import type { ZipYieldRow } from "./portfolio";

const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
const LISTINGS_TABLE = "tbldMjKBgPiq45Jjs";

/** Field IDs, not names — a rename in Airtable must not silently zero the
 *  yield signal and retire the whole portfolio. */
const F_ZIP = "fld9PTaKkgBNtvWbB";
const F_LAST_OUTBOUND_AT = "fldaK4lR5UNvycg11";

interface AirtableRow {
  fields: Record<string, unknown>;
}

/** ZIP → count of records whose last outbound fired inside the window.
 *
 *  Filtered server-side by date so this reads the ~hundreds of records that
 *  actually sent, never the whole 7k-row table. */
export async function listSendsByZip(windowDays: number): Promise<Map<string, number>> {
  if (!AIRTABLE_PAT) throw new Error("AIRTABLE_PAT missing — cannot read send yield");
  const days = Math.max(1, Math.floor(windowDays));
  const out = new Map<string, number>();
  const formula = `IS_AFTER({Last_Outbound_At}, DATEADD(NOW(), -${days}, 'days'))`;
  let offset: string | undefined;
  do {
    const url = new URL(`https://api.airtable.com/v0/${BASE_ID}/${LISTINGS_TABLE}`);
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("filterByFormula", formula);
    url.searchParams.append("fields[]", F_ZIP);
    url.searchParams.append("fields[]", F_LAST_OUTBOUND_AT);
    url.searchParams.set("returnFieldsByFieldId", "true");
    if (offset) url.searchParams.set("offset", offset);
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${AIRTABLE_PAT}` },
      cache: "no-store",
    });
    if (!res.ok) {
      throw new Error(`send-yield list ${res.status}: ${await res.text().catch(() => "")}`);
    }
    const body = (await res.json()) as { records?: AirtableRow[]; offset?: string };
    for (const rec of body.records ?? []) {
      const zip = typeof rec.fields[F_ZIP] === "string" ? (rec.fields[F_ZIP] as string).trim().slice(0, 5) : "";
      if (!/^\d{5}$/.test(zip)) continue;
      out.set(zip, (out.get(zip) ?? 0) + 1);
    }
    offset = body.offset;
  } while (offset);
  return out;
}

export interface BuildYieldRowsInput {
  /** One entry per ZIP currently in the registry. */
  registry: Array<{
    zip: string;
    lastIngestedAt: string | null;
    recordsIngested: number | null;
    crawlCount: number | null;
    /** The opener cannot price this market right now. */
    openerHold: boolean;
    saturated?: boolean;
    /** ZIP carries a usable ARV seed. */
    seeded: boolean;
  }>;
  sendsByZip: Map<string, number>;
  /** True when the send counter was actually read. When the read FAILED we must
   *  pass null sends rather than zeros — otherwise a transient Airtable error
   *  reads as "nothing sent anywhere" and retires the entire portfolio in one
   *  run. This flag is the difference between a bad night and a wiped circuit. */
  sendsMeasured: boolean;
}

/** Pure: join the registry to the send counter into portfolio input rows.
 *
 *  eligibleForSends is computed HERE because it is the safety property that
 *  keeps a structurally-blocked market alive: a ZIP that could not have sent
 *  (market held, saturated, unseeded) must never be retired for not sending.
 *  Every San Antonio ZIP was in exactly that position on 2026-08-13. */
export function buildYieldRows(input: BuildYieldRowsInput): ZipYieldRow[] {
  return input.registry.map((r) => ({
    zip: r.zip,
    sends: input.sendsMeasured ? (input.sendsByZip.get(r.zip) ?? 0) : null,
    recordsIngested: r.recordsIngested,
    crawlCount: r.crawlCount,
    lastIngestedAt: r.lastIngestedAt,
    eligibleForSends: !r.openerHold && !r.saturated && r.seeded,
  }));
}
