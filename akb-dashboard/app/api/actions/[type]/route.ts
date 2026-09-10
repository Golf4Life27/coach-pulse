// Operator action dispatch — mark dead, hold, clear, sign a contract, etc.
//
// SECURITY: this endpoint had NO AUTHENTICATION until 2026-09-10. Anyone who
// knew (or guessed) the URL could POST here and mark deals dead, sign
// contracts, or flag a buyer blast as sent — every write in HANDLERS below,
// unauthenticated, on the open internet. It mattered because this route
// moves money (sign_contract, send_buyer_blast) and kills deals (mark_dead,
// walk_away). Found while wiring the Decision Card channel (Layer 2), which
// needed to call these SAME handlers from a token-authorized route and had
// to ask what guarded this one. Answer: nothing. Fixed by requiring the same
// dashboard-session-or-auth-waterfall gate every other write route in this
// app already uses (see app/api/cron/contract-watch/route.ts).
//
// HANDLERS + ActionBody are exported so the Decision Card redeem route
// (app/api/maverick/act/route.ts) can execute the exact same handler bodies
// instead of re-implementing them — one implementation of "what mark_dead
// does to Airtable", not two that can drift apart. They stay inline in this
// file (rather than a separate lib module) because lib/orchestrator/
// gate-integrity.test.ts source-scans app/api/**/route.ts for exactly this
// pattern (updateDealRecord + a Contract-Signed/EMD write, gated by the
// Pre-EMD import) to prove there's no ungated side door to an EMD/contract
// advance — moving the write out of this file would blind that guard.

import { updateListingRecord, updateDealRecord, getListing, getDeals } from "@/lib/airtable";
import { ALL_DD_ITEMS } from "@/lib/actionQueue";
import { runPreEmdGateForDeal } from "@/lib/orchestrator/pre-emd-gate-live";
import { emdAdvanceDecision } from "@/lib/orchestrator/pre-emd-gate";
import { NextResponse } from "next/server";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";

export const runtime = "nodejs";
export const maxDuration = 30;

/** Thrown when the INV-023 Pre-EMD gate refuses a contract-advance action.
 *  Carries the advance decision so the POST handler returns 423 + the blocked
 *  checks (instead of a generic 500). */
export class EmdGateBlockedError extends Error {
  constructor(public decision: ReturnType<typeof emdAdvanceDecision>) {
    super("pre_emd_gate_blocked");
    this.name = "EmdGateBlockedError";
  }
}

// Field IDs (mirrors lib/airtable.ts mapping). Centralised here so the
// action handlers PATCH the right Airtable columns. Listing- and deal-side
// Action_Card_State / Action_Hold_Until are separate columns on separate
// tables, so they get distinct keys.
const FIELD = {
  // Listings
  listingOutreachStatus: "fldGIgqwyCJg4uFyv",
  listingDDChecklist: "fldZVZT98A6cEmJB3",
  listingActionCardState: "fldiNKFpIBUYgg7el",
  listingActionHoldUntil: "fldkYeP8onCHil0pd",
  // Deals
  dealClosingStatus: "fldTvNokAK5AEqz9z",
  dealStatus: "fldned9bMeMSKWruL",
  dealBuyerBlastStatus: "fldWIL8UzG6y2zjY0",
  dealActionCardState: "fldi7i3WinAohQ3aS",
  dealActionHoldUntil: "fldDmZjkunw6iZujf",
} as const;

export interface ActionBody {
  recordId: string;
  table?: "listings" | "deals";
  until?: string;
  note?: string;
  reason?: string;
}

type Handler = (body: ActionBody) => Promise<void>;

export const HANDLERS: Record<string, Handler> = {
  // Listing-side actions
  async mark_dead({ recordId }) {
    await updateListingRecord(recordId, {
      [FIELD.listingOutreachStatus]: "Dead",
      [FIELD.listingActionCardState]: "Cleared",
    });
  },
  async mark_dd_complete({ recordId }) {
    await updateListingRecord(recordId, {
      [FIELD.listingDDChecklist]: [...ALL_DD_ITEMS],
      [FIELD.listingActionCardState]: "Cleared",
    });
  },

  // Shared hold/clear — the `table` param picks which record we PATCH.
  // Defaults to listings for backwards compatibility with the listing cards.
  async hold({ recordId, until, table = "listings" }) {
    if (!until || !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
      throw new Error("Invalid 'until' (expected YYYY-MM-DD)");
    }
    if (table === "deals") {
      await updateDealRecord(recordId, {
        [FIELD.dealActionCardState]: "Held",
        [FIELD.dealActionHoldUntil]: until,
      });
    } else {
      await updateListingRecord(recordId, {
        [FIELD.listingActionCardState]: "Held",
        [FIELD.listingActionHoldUntil]: until,
      });
    }
  },
  async clear({ recordId, table = "listings" }) {
    if (table === "deals") {
      await updateDealRecord(recordId, {
        [FIELD.dealActionCardState]: "Cleared",
      });
    } else {
      await updateListingRecord(recordId, {
        [FIELD.listingActionCardState]: "Cleared",
      });
    }
  },

  // Deal-side actions. Each deal action also clears the Action Queue card
  // since the decision has been made (Buyer_Blast="Sent" / Closing_Status=
  // "Contract Signed" / Status="Failed" aren't all terminal in pipeline
  // terms, but the card itself no longer needs Alex's attention).
  async sign_contract({ recordId }) {
    // INV-023 HARD GATE (Milestone 4): a contract may NOT be marked signed
    // unless the Pre-EMD due-diligence gate is ADVANCE_UNLOCKED. This closes
    // the side door that let a bad deal (23 Fields) reach "Contract Signed"
    // without the DD checks. Same enforced gate as request-emd. Fail-closed:
    // deal not found / gate error → refuse, never write.
    const deals = await getDeals().catch(() => [] as Awaited<ReturnType<typeof getDeals>>);
    const deal = deals.find((d) => d.id === recordId) ?? null;
    if (!deal) {
      throw new EmdGateBlockedError({ allowed: false, httpStatus: 423, reason: "deal_not_found_fail_closed", blocked_checks: [] });
    }
    const decision = emdAdvanceDecision(await runPreEmdGateForDeal(deal));
    if (!decision.allowed) {
      throw new EmdGateBlockedError(decision);
    }
    await updateDealRecord(recordId, {
      [FIELD.dealClosingStatus]: "Contract Signed",
      [FIELD.dealActionCardState]: "Cleared",
    });
  },
  async walk_away({ recordId }) {
    await updateDealRecord(recordId, {
      [FIELD.dealStatus]: "Failed",
      [FIELD.dealActionCardState]: "Cleared",
    });
  },
  async send_buyer_blast({ recordId }) {
    await updateDealRecord(recordId, {
      [FIELD.dealBuyerBlastStatus]: "Sent",
      [FIELD.dealActionCardState]: "Cleared",
    });
  },
  async append_note({ recordId, note }) {
    if (!note) return;
    const listing = await getListing(recordId);
    const existing = listing?.notes ?? "";
    const full = existing ? `${existing}\n\n${note}` : note;
    await updateListingRecord(recordId, { fldwKGxZly6O8qyPu: full });
  },
};

export async function POST(
  req: Request,
  { params }: { params: Promise<{ type: string }> },
) {
  const { type } = await params;

  // ── Auth: dashboard session (same-origin browser) OR the standard
  // OAuth/cron/dev-bearer waterfall. Same shape as contract-watch and
  // maverick/priorities — writes are never open on this dashboard. The
  // authRequired escape hatch matches those routes: an environment with no
  // KV and no secrets configured (bare local dev/CI) has nothing to check
  // credentials against, so it stays open rather than locking developers
  // out — production always has KV configured, so this never applies there.
  const cookieHeader = req.headers.get("cookie");
  if (!hasDashboardSession(cookieHeader)) {
    const env = readAuthEnv();
    const headers = readAuthHeaders(req);
    const authRequired = kvConfigured() || env.cronSecret !== null || env.bearerDevToken !== null;
    if (authRequired) {
      const auth = await authenticate(headers, env, kvProd);
      if (!auth.ok) {
        return NextResponse.json({ error: "unauthorized", reason: auth.reason }, { status: 401 });
      }
    }
  }

  const handler = HANDLERS[type];
  if (!handler) {
    return Response.json({ error: `Unknown action: ${type}` }, { status: 404 });
  }

  let body: ActionBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body?.recordId || typeof body.recordId !== "string") {
    return Response.json({ error: "Missing recordId" }, { status: 400 });
  }

  try {
    await handler(body);
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof EmdGateBlockedError) {
      return Response.json(
        {
          ok: false,
          refused: true,
          reason: err.decision.reason,
          blocked_checks: err.decision.blocked_checks,
          detail:
            "INV-023 Pre-EMD gate is BLOCKED — a contract cannot be marked signed until every due-diligence check is green (same gate as the EMD wire).",
        },
        { status: err.decision.httpStatus },
      );
    }
    console.error(`[actions/${type}] error:`, err);
    return Response.json(
      { error: "Action failed", detail: String(err) },
      { status: 500 },
    );
  }
}
