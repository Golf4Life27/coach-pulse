// PURGE capped_to_list — clear stored openers that are a fraction of list.
// @agent: ledger
//
// AUDIT 2026-08-06. Of 819 records carrying BOTH Outreach_Offer_Price and
// List_Price, 808 have an opener that is EXACTLY 0.65 x list, and all 808 have
// NO Opener_Basis. That is the retired capped_to_list producer (demoted to a
// tripwire by operator ruling recmy2Vwp1wMA1Vs8 on 2026-07-06), fossilised in
// the field. Created 2026-03 (75), 2026-04 (580), 2026-05 (152), 2026-07 (1).
//
// These are NOT inert. Recomputing 40 of them against their own stored ARV:
//   - 23 of 40 offer MORE than the ARV-derived MAO supports
//   - 11383 Ohio: stored opener $14,625 against a computed MAO of -$85
//   - 7839 Sparta: $149,175 offered against a $155,465 renovated ARV
// and the field is READ in live paths — decision-math.chooseDisplayPrice uses
// it as a price source, negotiation.ts reads it as the legacy opener slot, and
// reply-alert builds "hold at $X (MAO $Y)" recommendations from it when an
// agent counters. An April agent replying today would be answered with a
// 65%-of-list number wearing the costume of underwriting.
//
// The healthy population does not use this field at all: August records price
// through Opener_Basis="arv_buybox_seed" and leave Outreach_Offer_Price empty.
//
// SO THIS CLEARS THE FIELD — it does not delete records. The records carry the
// agent phone that seeds the prior-contact dedup index; deleting them would let
// the system re-text agents it already burned in April and re-ingest their
// addresses as fresh leads. The poison is the number, not the row.
//
// IDEMPOTENT and self-healing: it re-queries every run, so anything that
// repopulates the field in the capped_to_list shape gets cleared again.
//
// Values backed up to docs/audits/2026-08-06-capped-to-list-purge-backup.json
// before the first run.
//
// ?apply=1   actually write (DEFAULT IS DRY RUN — this deletes operator data)
// ?limit=N   max records to clear per run (default 500)

import { NextResponse } from "next/server";
import { audit } from "@/lib/audit-log";
import { patchListingsBatch } from "@/lib/airtable";
import { isCappedToListFossil } from "@/lib/capped-to-list-fossil";

export const runtime = "nodejs";
export const maxDuration = 300;

const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
const LISTINGS_TABLE = "tbldMjKBgPiq45Jjs";

const F_LIST = "fld9J3Vi9fTq3zzMU"; // List_Price
const F_OFFER = "fldBFnL0HQJWahRov"; // Outreach_Offer_Price
const F_BASIS = "fldCjwSV2vLeui8Mf"; // Opener_Basis

interface Fossil {
  recordId: string;
  listPrice: number;
  offer: number;
}

async function fetchFossils(limit: number): Promise<Fossil[]> {
  if (!AIRTABLE_PAT) return [];
  const out: Fossil[] = [];
  let offset: string | undefined;

  do {
    const params = new URLSearchParams();
    [F_LIST, F_OFFER, F_BASIS].forEach((f) => params.append("fields[]", f));
    params.set("returnFieldsByFieldId", "true");
    params.set("filterByFormula", `AND(NOT({Outreach_Offer_Price}=''), NOT({List_Price}=''))`);
    params.set("pageSize", "100");
    if (offset) params.set("offset", offset);

    const res = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/${LISTINGS_TABLE}?${params.toString()}`,
      { headers: { Authorization: `Bearer ${AIRTABLE_PAT}` }, cache: "no-store" },
    );
    if (!res.ok) break;
    const body = (await res.json()) as {
      records?: Array<{ id: string; fields?: Record<string, unknown> }>;
      offset?: string;
    };
    for (const r of body.records ?? []) {
      if (out.length >= limit) break;
      const f = r.fields ?? {};
      if (isCappedToListFossil({ listPrice: f[F_LIST], offer: f[F_OFFER], openerBasis: f[F_BASIS] })) {
        out.push({ recordId: r.id, listPrice: f[F_LIST] as number, offer: f[F_OFFER] as number });
      }
    }
    offset = out.length >= limit ? undefined : body.offset;
  } while (offset);

  return out;
}

export async function GET(req: Request) {
  const t0 = Date.now();
  const url = new URL(req.url);
  // DRY RUN BY DEFAULT. This destroys operator data; ?apply=1 is deliberate.
  const apply = url.searchParams.get("apply") === "1";
  const rawLimit = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 1000) : 500;

  const fossils = await fetchFossils(limit);

  let cleared = 0;
  const errors: string[] = [];
  if (apply) {
    for (let i = 0; i < fossils.length; i += 10) {
      const chunk = fossils.slice(i, i + 10);
      try {
        const res = await patchListingsBatch(
          chunk.map((f) => ({ recordId: f.recordId, fields: { Outreach_Offer_Price: null } })),
        );
        for (const r of res) {
          if (r.error) errors.push(`${r.recordId}: ${r.error}`);
          else cleared++;
        }
      } catch (err) {
        errors.push(
          `batch@${i}: ${err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)}`,
        );
      }
    }
  }

  const summary = {
    fossils_found: fossils.length,
    cleared,
    errors: errors.slice(0, 10),
    apply,
    sample: fossils.slice(0, 3).map((f) => ({
      recordId: f.recordId,
      list: f.listPrice,
      offer: f.offer,
      ratio: Number((f.offer / f.listPrice).toFixed(4)),
    })),
    ms: Date.now() - t0,
  };

  await audit({
    agent: "ledger",
    event: "purge_capped_to_list",
    status: errors.length > 0 ? "uncertain" : "confirmed_success",
    inputSummary: { apply, limit },
    outputSummary: summary,
    decision: apply ? `${cleared} cleared of ${fossils.length} found` : `DRY RUN — ${fossils.length} found`,
  });

  return NextResponse.json(summary);
}
