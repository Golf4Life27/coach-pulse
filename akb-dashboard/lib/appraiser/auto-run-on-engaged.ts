// 2026-06-10 ruling — Auto-run Appraiser on Texted → Response Received.
//
// The manual "Run ARV" / "Run rehab" buttons in the AppraiserArvPanel /
// AppraiserRehabPanel were a credit gate from when every scraped record
// was a candidate. The reply is the gate now: by the time the seller
// responds, the credit spend is justified, and the negotiation window is
// measured in minutes — Alex should not need to click two buttons before
// he can think about the offer.
//
// This helper fires the per-record Appraiser routes the instant
// scan-replies records the transition. Auth flows through the standard
// waterfall (CRON_SECRET on the scan-replies invocation forwards to the
// sub-routes — same trick admin/appraiser-backfill uses, see route.ts
// header for the 2026-06-04 reconciliation history).
//
// Two-track posture:
//   ARV   — awaited inline (10-20s). Operator needs the number fresh
//           when the reply alert lands.
//   Rehab — awaited too, when the caller's remaining lambda budget can
//           fit it (vision runs 1-3 min; the rehab route itself has
//           maxDuration=300 as of the Freeland P0 fix). NO fire-and-
//           forget: a detached fetch can be aborted when the calling
//           lambda freezes on return, which silently produces no rehab
//           estimate — exactly the failure mode the Positive
//           Confirmation Principle forbids. If the budget can't fit a
//           rehab run, we SKIP it and say so in the result; the
//           AppraiserRehabPanel's "Run rehab" button is the prepared
//           one-click fallback per the ruling.
//
// Idempotent: the appraiser routes are safe to re-call; their write paths
// only stamp ARV_Validated_At / Rehab_Estimated_At on a fresh successful
// compute. A re-run on an already-priced record just refreshes those
// timestamps (same surface a Refresh click produces).

import { getListing } from "@/lib/airtable";
import { underwriteV21Record } from "@/lib/v21-underwrite-record";

const CRON_SECRET = process.env.CRON_SECRET;

// Worst-case wall time we reserve before attempting an awaited rehab run
// (photo scrape + vision + Airtable write). If the caller's remaining
// budget is below this, rehab is skipped with an explicit reason.
export const REHAB_BUDGET_MS = 180_000;

export interface EngagedAutoRunResult {
  recordId: string;
  arvOk: boolean;
  arvHttpStatus: number | null;
  arvElapsedMs: number;
  arvError: string | null;
  /** "ok" | "failed" | "skipped_budget" | "skipped_by_caller" */
  rehab: "ok" | "failed" | "skipped_budget" | "skipped_by_caller";
  rehabHttpStatus: number | null;
  rehabElapsedMs: number;
  rehabError: string | null;
  // ── Reply-triggered RE-PRICE (Maverick 2026-06-14) ────────────────
  // The landlord V2.1 MAO recompute on a seller reply, off fresh inputs.
  // Fires ONLY for records ALREADY underwritten (Your_MAO_V21 present) —
  // the initial underwrite is the V21-fresh cron's job, not this trigger.
  //   ok                        → recomputed + written
  //   hold                      → recompute produced no number (HOLD)
  //   skipped_not_underwritten  → no existing V21 (cron underwrites first)
  //   skipped_not_landlord      → priceable/active gate or flipper lane
  //   skipped_by_caller         → skipReprice set
  //   failed                    → threw / write error
  reprice:
    | "ok"
    | "hold"
    | "skipped_not_underwritten"
    | "skipped_not_landlord"
    | "skipped_by_caller"
    | "failed";
  repriceYourMao: number | null;
  repriceElapsedMs: number;
  repriceError: string | null;
  // ── Buyer-ceiling / ARV buy-box (P1.2, 2026-07-13) ────────────────
  // The 4th offer-readiness item: the dual-track buyer MAO ceiling.
  //   "ok" | "failed" | "skipped_by_caller"
  buyerIntel: "ok" | "failed" | "skipped_by_caller";
  buyerIntelHttpStatus: number | null;
  buyerIntelElapsedMs: number;
  buyerIntelError: string | null;
}

export interface EngagedAutoRunInput {
  recordId: string;
  origin: string;
  /** Forward an explicit cookie (operator-driven path); otherwise the
   *  CRON_SECRET bearer carries the auth. */
  cookie?: string | null;
  /** Skip the rehab run entirely (callers that already know there are
   *  no photos, or ARV-only sweeps). */
  skipRehab?: boolean;
  /** Skip the landlord V2.1 re-price step. */
  skipReprice?: boolean;
  /** Skip the buyer-ceiling / ARV buy-box (dual-track) compute. */
  skipBuyerIntel?: boolean;
  /** Epoch ms after which the CALLER's lambda budget is exhausted.
   *  Rehab is only attempted when at least REHAB_BUDGET_MS remains.
   *  Omit to always attempt (callers with their own budget loop). */
  deadlineAtMs?: number;
}

async function callRoute(
  url: string,
  headers: Record<string, string>,
): Promise<{ ok: boolean; status: number | null; elapsedMs: number; error: string | null }> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers, cache: "no-store" });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        status: res.status,
        elapsedMs: Date.now() - t0,
        error: body ? body.slice(0, 240) : `http_${res.status}`,
      };
    }
    return { ok: true, status: res.status, elapsedMs: Date.now() - t0, error: null };
  } catch (err) {
    return {
      ok: false,
      status: null,
      elapsedMs: Date.now() - t0,
      error: err instanceof Error ? err.message.slice(0, 240) : String(err).slice(0, 240),
    };
  }
}

export async function autoRunOnEngaged(
  input: EngagedAutoRunInput,
): Promise<EngagedAutoRunResult> {
  const { recordId, origin, cookie, skipRehab, skipReprice, skipBuyerIntel, deadlineAtMs } = input;

  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (CRON_SECRET) headers.authorization = `Bearer ${CRON_SECRET}`;

  const arv = await callRoute(
    `${origin}/api/agents/appraiser/arv/${recordId}`,
    headers,
  );

  let rehab: EngagedAutoRunResult["rehab"];
  let rehabHttpStatus: number | null = null;
  let rehabElapsedMs = 0;
  let rehabError: string | null = null;

  if (skipRehab) {
    rehab = "skipped_by_caller";
  } else if (
    deadlineAtMs != null &&
    deadlineAtMs - Date.now() < REHAB_BUDGET_MS
  ) {
    rehab = "skipped_budget";
    rehabError = "caller budget too low for an awaited vision run — use the panel's Run rehab button or the backfill route";
  } else {
    const r = await callRoute(
      `${origin}/api/agents/appraiser/rehab/${recordId}`,
      headers,
    );
    rehab = r.ok ? "ok" : "failed";
    rehabHttpStatus = r.status;
    rehabElapsedMs = r.elapsedMs;
    rehabError = r.error;
  }

  // ── Reply-triggered RE-PRICE (Maverick 2026-06-14) ──────────────────
  // The landlord lane recompute. ARV/rehab above refreshed the FLIPPER
  // lane (comps) + vision rehab; this refreshes the LANDLORD V2.1 MAO off
  // fresh rent + county taxes. Re-fetch the record so we read the rehab
  // route's fresh Est_Rehab_Mid and the current Your_MAO_V21. Only an
  // ALREADY-underwritten record re-prices — initial underwrite is the
  // V21-fresh cron's job (Maverick: "fresh paid pulls on an ALREADY-
  // underwritten record, fires ONLY on a seller reply").
  let reprice: EngagedAutoRunResult["reprice"];
  let repriceYourMao: number | null = null;
  let repriceElapsedMs = 0;
  let repriceError: string | null = null;

  if (skipReprice) {
    reprice = "skipped_by_caller";
  } else {
    const t0 = Date.now();
    try {
      const listing = await getListing(recordId);
      const hasV21 =
        listing != null &&
        typeof listing.yourMao === "number" &&
        Number.isFinite(listing.yourMao) &&
        listing.yourMao > 0;
      if (!listing || !hasV21) {
        reprice = "skipped_not_underwritten";
      } else {
        const outcome = await underwriteV21Record(listing, {
          apply: true,
          allowReprice: true,
          forceFreshRent: true,
        });
        if (outcome.decision.write === false) {
          // priceable/active gate or flipper lane — landlord re-price N/A.
          reprice = "skipped_not_landlord";
        } else if (outcome.written) {
          reprice = "ok";
          repriceYourMao = outcome.result?.yourMao ?? null;
        } else if (outcome.writeError) {
          reprice = "failed";
          repriceError = outcome.writeError;
        } else {
          // decision was write:true but compute HELD (missing rent/taxes/
          // cap/rehab or NOI≤0) → no number written.
          reprice = "hold";
        }
      }
    } catch (err) {
      reprice = "failed";
      repriceError = err instanceof Error ? err.message.slice(0, 240) : String(err).slice(0, 240);
    }
    repriceElapsedMs = Date.now() - t0;
  }

  // ── Buyer-ceiling / ARV buy-box (P1.2) — the dual-track buyer MAO. Runs
  // after ARV so the compute reads fresh comps. Best-effort like rehab: a
  // failure is reported, never thrown.
  let buyerIntel: EngagedAutoRunResult["buyerIntel"];
  let buyerIntelHttpStatus: number | null = null;
  let buyerIntelElapsedMs = 0;
  let buyerIntelError: string | null = null;
  if (skipBuyerIntel) {
    buyerIntel = "skipped_by_caller";
  } else {
    const bi = await callRoute(`${origin}/api/agents/appraiser/buyer-intelligence/${recordId}`, headers);
    buyerIntel = bi.ok ? "ok" : "failed";
    buyerIntelHttpStatus = bi.status;
    buyerIntelElapsedMs = bi.elapsedMs;
    buyerIntelError = bi.error;
  }

  return {
    recordId,
    arvOk: arv.ok,
    arvHttpStatus: arv.status,
    arvElapsedMs: arv.elapsedMs,
    arvError: arv.error,
    rehab,
    rehabHttpStatus,
    rehabElapsedMs,
    rehabError,
    reprice,
    repriceYourMao,
    repriceElapsedMs,
    repriceError,
    buyerIntel,
    buyerIntelHttpStatus,
    buyerIntelElapsedMs,
    buyerIntelError,
  };
}

/** Pure helper for callers that only have a Request — extracts the
 *  scheme + host so the internal fetch hits the same deployment, not
 *  the production alias from a preview lambda. */
export function originFromRequest(req: Request): string {
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}
