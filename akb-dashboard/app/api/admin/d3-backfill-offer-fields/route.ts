// D3 — One-shot backfill for Stored_Offer_Price + List_Price_At_Send on
// existing Texted records.
//
// GET /api/admin/d3-backfill-offer-fields?apply=1[&limit=N]
//
// Dry-run by default. Writes go through updateListingRecord →
// patchAndVerify so the drift detector + audit log cover every change.
//
// Per Alex 5/13 decision: existing 800 Texted records won't have
// captured Stored_Offer_Price / List_Price_At_Send at H2 send time
// (the fields didn't exist yet). Forward records get the real
// captured value at send. Existing records get the closest available
// proxy:
//   Stored_Offer_Price = (current List_Price) × 0.65
//     "current_list_price × 0.65 is the closest available proxy. Better
//     than null." Per 65% Rule (Spine recmmidVrMyrLzjZp).
//   List_Price_At_Send = Prev_List_Price (if set) || current List_Price
//     If a price drop has happened post-outreach, Prev_List_Price WAS
//     the price at outreach (assumes ≤1 drop). Otherwise current
//     List_Price stands in for an unchanged value.
//
// Backfill is audit-flagged data_source: "backfill_proxy" so future
// analysis can distinguish proxy-data from H2-captured-data per Alex's
// explicit request. Records that already have non-null values for
// either field are SKIPPED (forward-captured H2 data wins; we don't
// stomp).

import { NextResponse } from "next/server";
import { getListings, updateListingRecord } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";

export const runtime = "nodejs";
export const maxDuration = 90;

interface BackfillOutcome {
  recordId: string;
  fields_written: string[];
  stored_offer_price: number | null;
  list_price_at_send: number | null;
  list_price_at_send_source: "prev_list_price" | "current_list_price" | "none";
  drift_count: number;
  error: string | null;
  skipped_reason: string | null;
}

export async function GET(req: Request) {
  const t0 = Date.now();
  const url = new URL(req.url);
  const apply = url.searchParams.get("apply") === "1";
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Math.max(1, parseInt(limitParam, 10) || 0) : null;

  const allListings = await getListings();
  const texted = allListings.filter(
    (l) => (l.outreachStatus ?? "").toLowerCase() === "texted",
  );
  const subset = limit != null ? texted.slice(0, limit) : texted;

  const outcomes: BackfillOutcome[] = [];
  let written = 0;
  let skipped_already_populated = 0;
  let skipped_no_list_price = 0;
  let write_errors = 0;

  for (const l of subset) {
    const currentList = l.listPrice ?? null;
    const prev = l.prevListPrice ?? null;
    const existingStored = l.storedOfferPrice ?? null;
    const existingAtSend = l.listPriceAtSend ?? null;

    // Don't stomp real H2-captured values. If either field is already
    // populated, skip the whole record — partial overwrites are a recipe
    // for inconsistent state.
    if (existingStored != null || existingAtSend != null) {
      outcomes.push({
        recordId: l.id,
        fields_written: [],
        stored_offer_price: null,
        list_price_at_send: null,
        list_price_at_send_source: "none",
        drift_count: 0,
        error: null,
        skipped_reason: `already populated (stored=${existingStored}, at_send=${existingAtSend})`,
      });
      skipped_already_populated++;
      continue;
    }

    if (!(typeof currentList === "number" && currentList > 0)) {
      outcomes.push({
        recordId: l.id,
        fields_written: [],
        stored_offer_price: null,
        list_price_at_send: null,
        list_price_at_send_source: "none",
        drift_count: 0,
        error: null,
        skipped_reason: `no usable List_Price (${currentList})`,
      });
      skipped_no_list_price++;
      continue;
    }

    const storedOffer = Math.round(currentList * 0.65);
    const atSendValue = typeof prev === "number" && prev > 0 ? prev : currentList;
    const atSendSource: "prev_list_price" | "current_list_price" =
      typeof prev === "number" && prev > 0 ? "prev_list_price" : "current_list_price";

    if (!apply) {
      outcomes.push({
        recordId: l.id,
        fields_written: ["Stored_Offer_Price", "List_Price_At_Send"],
        stored_offer_price: storedOffer,
        list_price_at_send: atSendValue,
        list_price_at_send_source: atSendSource,
        drift_count: 0,
        error: null,
        skipped_reason: null,
      });
      continue;
    }

    try {
      const drift = await updateListingRecord(l.id, {
        Stored_Offer_Price: storedOffer,
        List_Price_At_Send: atSendValue,
      });
      // Per-record audit so future analysis can identify proxy-data
      // by data_source=backfill_proxy.
      await audit({
        agent: "sentry",
        event: "offer_fields_backfilled",
        status: "confirmed_success",
        recordId: l.id,
        inputSummary: {
          current_list_price: currentList,
          prev_list_price: prev,
        },
        outputSummary: {
          data_source: "backfill_proxy",
          stored_offer_price: storedOffer,
          list_price_at_send: atSendValue,
          list_price_at_send_source: atSendSource,
          drift_count: drift.length,
        },
        decision: "proxied",
      });
      outcomes.push({
        recordId: l.id,
        fields_written: ["Stored_Offer_Price", "List_Price_At_Send"],
        stored_offer_price: storedOffer,
        list_price_at_send: atSendValue,
        list_price_at_send_source: atSendSource,
        drift_count: drift.length,
        error: null,
        skipped_reason: null,
      });
      written++;
    } catch (err) {
      outcomes.push({
        recordId: l.id,
        fields_written: [],
        stored_offer_price: null,
        list_price_at_send: null,
        list_price_at_send_source: "none",
        drift_count: 0,
        error: String(err),
        skipped_reason: null,
      });
      write_errors++;
    }
  }

  await audit({
    agent: "sentry",
    event: "backfill_run",
    status:
      apply && write_errors > 0
        ? "confirmed_failure"
        : apply
          ? "confirmed_success"
          : "confirmed_success",
    inputSummary: {
      apply,
      limit,
      total_texted: texted.length,
      examined: subset.length,
    },
    outputSummary: {
      written,
      skipped_already_populated,
      skipped_no_list_price,
      write_errors,
      data_source: "backfill_proxy",
    },
    decision: apply ? "writes_applied" : "dry_run",
    ms: Date.now() - t0,
  });

  return NextResponse.json({
    mode: apply ? "apply" : "dry_run",
    elapsed_ms: Date.now() - t0,
    texted_total_in_airtable: texted.length,
    examined: subset.length,
    summary: {
      written: apply ? written : `(would write) ${outcomes.filter((o) => o.fields_written.length > 0).length}`,
      skipped_already_populated,
      skipped_no_list_price,
      write_errors: apply ? write_errors : 0,
    },
    // Cap sample at 50 — most callers want the summary, not 800 rows.
    outcomes_sample: outcomes.slice(0, 50),
  });
}
