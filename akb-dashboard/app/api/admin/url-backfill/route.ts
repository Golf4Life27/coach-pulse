// Firecrawl URL backfill for URL-less active records (2026-06-05).
// @agent: scout
//
// GET /api/admin/url-backfill[?apply=1&limit=N&after=recX&pace_ms=M]
//
// Resolves a Verification_URL for the ~396 Live_Status=Active records
// that have none, via Firecrawl address search (lib/crawler/sources/
// firecrawl.verifyListing) + a STRICT address↔URL confirmation
// (lib/crawler/url-backfill.strictAddressUrlMatch) + a still-on-market
// check. A record is only written when BOTH confirm:
//   - resolved URL's slug contains the street number AND a
//     distinguishing street-name token (strict, not a loose matcher), and
//   - Firecrawl reports the listing still active (stillActive).
// Anything that can't be confirmed comes back EMPTY — never fabricated.
//
// Dry-run by default (report what WOULD be written). ?apply=1 persists
// Verification_URL + Verification_Source="firecrawl_url_backfill" +
// Last_Verified. Paced + wall-clock-bounded + ?after cursor so it pages
// through the full set across multiple invocations (one Firecrawl call
// per record ≈ several seconds; 300s lambda fits ~20-30 records/run).
//
// Auth posture: same as the rest of /api/admin/* (Vercel deployment
// layer). Mutations gated behind ?apply=1.

import { NextResponse } from "next/server";
import { getUrlLessActiveCandidates, updateListingRecord } from "@/lib/airtable";
import { verifyListing } from "@/lib/crawler/sources/firecrawl";
import { strictAddressUrlMatch, formatSubjectAddress } from "@/lib/crawler/url-backfill";
import { audit } from "@/lib/audit-log";
import { noteWorkRun, noteZeroRun } from "@/lib/admin/retire-me-signal";

export const runtime = "nodejs";
export const maxDuration = 300;

// Leave room for the trailing audit + JSON after the last record.
const PER_RECORD_BUDGET_MS = 20_000;
const SAFETY_BUFFER_MS = 8_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface RecordOutcome {
  recordId: string;
  address: string;
  resolved: boolean;
  url: string | null;
  stillActive: boolean;
  strict_match: boolean;
  strict_reason: string;
  confirmed: boolean;
  written: boolean;
  write_error: string | null;
  firecrawl_error: string | null;
}

export async function GET(req: Request) {
  const t0 = Date.now();
  const url = new URL(req.url);
  const apply = url.searchParams.get("apply") === "1";
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam != null ? Math.max(1, parseInt(limitParam, 10) || 0) : null;
  const after = url.searchParams.get("after");
  const paceMsParam = url.searchParams.get("pace_ms");
  const paceMs = paceMsParam != null ? Math.max(0, parseInt(paceMsParam, 10) || 0) : 500;

  let candidates;
  try {
    candidates = await getUrlLessActiveCandidates();
  } catch (err) {
    return NextResponse.json(
      { error: "candidate_fetch_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  // Deterministic id-sorted cursor paging.
  const ordered = [...candidates].sort((a, b) => a.id.localeCompare(b.id));
  const filtered = ordered.filter((l) => (after ? l.id.localeCompare(after) > 0 : true));
  const subset = limit != null ? filtered.slice(0, limit) : filtered;

  const outcomes: RecordOutcome[] = [];
  let truncated_by_budget = false;

  for (let i = 0; i < subset.length; i++) {
    const elapsed = Date.now() - t0;
    if (maxDuration * 1000 - elapsed < PER_RECORD_BUDGET_MS + SAFETY_BUFFER_MS) {
      truncated_by_budget = true;
      break;
    }

    const l = subset[i];
    const formatted = formatSubjectAddress({
      address: l.address,
      city: l.city,
      state: l.state,
      zip: l.zip,
    });

    const o: RecordOutcome = {
      recordId: l.id,
      address: l.address ?? "",
      resolved: false,
      url: null,
      stillActive: false,
      strict_match: false,
      strict_reason: "not_run",
      confirmed: false,
      written: false,
      write_error: null,
      firecrawl_error: null,
    };

    try {
      const fc = await verifyListing(formatted);
      o.resolved = fc.resolved;
      o.url = fc.url;
      o.stillActive = fc.stillActive;
      o.firecrawl_error = fc.error;

      const match = strictAddressUrlMatch(l.address ?? "", fc.url);
      o.strict_match = match.matched;
      o.strict_reason = match.reason;

      // Confirmed = resolved a URL + strict address match + still active.
      // (verifyListing reports stillActive=false on inactive markers; we
      // only backfill genuinely-on-market subjects.)
      o.confirmed = fc.resolved && !!fc.url && match.matched && fc.stillActive;

      if (apply) {
        if (o.confirmed) {
          try {
            await updateListingRecord(l.id, {
              Verification_URL: fc.url,
              Verification_Source: "firecrawl_url_backfill",
              Last_Verified: new Date().toISOString(),
            });
            o.written = true;
          } catch (err) {
            o.write_error = String(err).slice(0, 300);
          }
        } else if (!o.firecrawl_error) {
          // Firecrawl ran but couldn't confirm a URL (unresolved / not
          // on-market / strict-match miss). Stamp an "attempted, no
          // confirm" marker so this record drops out of the backfill
          // retry pool — never writes a URL, never fabricates. A
          // transient Firecrawl error (firecrawl_error set) is NOT
          // marked, so it's retried on the next pass.
          try {
            await updateListingRecord(l.id, {
              Verification_Source: "firecrawl_url_unresolved",
              Last_Verified: new Date().toISOString(),
            });
          } catch {
            // best-effort marker; a failure here just means a retry
            // next pass (harmless).
          }
        }
      }
    } catch (err) {
      o.firecrawl_error = String(err).slice(0, 300);
    }

    outcomes.push(o);
    if (paceMs > 0 && i < subset.length - 1) await sleep(paceMs);
  }

  const confirmed = outcomes.filter((o) => o.confirmed).length;
  const written = outcomes.filter((o) => o.written).length;
  const unmatched = outcomes.filter((o) => !o.confirmed).length;
  const next_cursor = subset.length > 0 ? subset[subset.length - 1].id : null;

  // Why each unconfirmed record didn't confirm — operator triage.
  const unmatched_reasons: Record<string, number> = {};
  for (const o of outcomes) {
    if (o.confirmed) continue;
    const reason = o.firecrawl_error
      ? "firecrawl_error"
      : !o.resolved
        ? "firecrawl_url_unresolved"
        : !o.stillActive
          ? "not_on_market"
          : o.strict_reason; // strict address-match failure reason
    unmatched_reasons[reason] = (unmatched_reasons[reason] ?? 0) + 1;
  }

  // Diagnostic FIRST line (runtime-log surfaces only the first
  // console.log per request): the actual Firecrawl error string driving
  // the firecrawl_error reason, so we can tell rate-limit vs quota vs
  // hard failure without guessing.
  const firstErr = outcomes.find((o) => o.firecrawl_error)?.firecrawl_error ?? null;
  if (firstErr) console.log(`URLBACKFILL_ERR ${firstErr.slice(0, 220)}`);

  console.log(
    `URLBACKFILL mode=${apply ? "apply" : "dry"} cand=${candidates.length} examined=${outcomes.length} ` +
    `confirmed=${confirmed} written=${written} unmatched=${unmatched} ` +
    `reasons=${Object.entries(unmatched_reasons).map(([k, v]) => `${k}:${v}`).join("|") || "none"} ` +
    `next=${next_cursor ?? "-"}`,
  );

  await audit({
    agent: "scout",
    event: apply ? "url_backfill_apply" : "url_backfill_dry_run",
    status: "confirmed_success",
    inputSummary: { apply, limit, after, candidate_total: candidates.length, examined: outcomes.length },
    outputSummary: { confirmed, written, unmatched, unmatched_reasons, truncated_by_budget },
    ms: Date.now() - t0,
  });

  // 2026-06-11 — retire-me signal. When the candidate cohort hits zero
  // for ZERO_RUN_THRESHOLD consecutive ticks the cron alerts so the
  // operator knows to retire the slot (no self-modification of
  // vercel.json — roster changes stay deliberate human commits).
  if (candidates.length === 0) {
    await noteZeroRun("url-backfill", {
      cron_path: "/api/admin/url-backfill?apply=1&limit=10",
      reason: "no_url_less_active_records",
    });
  } else {
    await noteWorkRun("url-backfill");
  }

  return NextResponse.json({
    mode: apply ? "apply" : "dry_run",
    candidate_total: candidates.length,
    examined: outcomes.length,
    confirmed,
    written,
    unmatched,
    unmatched_reasons,
    truncated_by_budget,
    next_cursor,
    elapsed_ms: Date.now() - t0,
    sample: outcomes.slice(0, 50),
  });
}
