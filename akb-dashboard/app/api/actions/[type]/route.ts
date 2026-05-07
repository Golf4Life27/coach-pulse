import { updateListingRecord, updateDealRecord, getListing } from "@/lib/airtable";
import { ALL_DD_ITEMS } from "@/lib/actionQueue";

export const runtime = "nodejs";
export const maxDuration = 30;

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

interface ActionBody {
  recordId: string;
  table?: "listings" | "deals";
  until?: string;
  note?: string;
  reason?: string;
}

type Handler = (body: ActionBody) => Promise<void>;

const HANDLERS: Record<string, Handler> = {
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
    console.error(`[actions/${type}] error:`, err);
    return Response.json(
      { error: "Action failed", detail: String(err) },
      { status: 500 },
    );
  }
}
