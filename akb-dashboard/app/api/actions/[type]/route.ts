import { updateListingRecord, updateDealRecord } from "@/lib/airtable";
import { ALL_DD_ITEMS } from "@/lib/actionQueue";

export const runtime = "nodejs";
export const maxDuration = 30;

// Field IDs (mirrors lib/airtable.ts mapping). Centralised here so the
// action handlers PATCH the right Airtable columns.
const FIELD = {
  outreachStatus: "fldGIgqwyCJg4uFyv",
  ddChecklist: "fldZVZT98A6cEmJB3",
  actionCardState: "fldiNKFpIBUYgg7el",
  actionHoldUntil: "fldkYeP8onCHil0pd",
  dealClosingStatus: "fldTvNokAK5AEqz9z",
  dealStatus: "fldned9bMeMSKWruL",
} as const;

interface ActionBody {
  recordId: string;
  until?: string; // YYYY-MM-DD, used by `hold`
}

type Handler = (body: ActionBody) => Promise<void>;

const HANDLERS: Record<string, Handler> = {
  // Listing-side actions
  async mark_dead({ recordId }) {
    await updateListingRecord(recordId, {
      [FIELD.outreachStatus]: "Dead",
      [FIELD.actionCardState]: "Cleared",
    });
  },
  async mark_dd_complete({ recordId }) {
    await updateListingRecord(recordId, {
      [FIELD.ddChecklist]: [...ALL_DD_ITEMS],
      [FIELD.actionCardState]: "Cleared",
    });
  },
  async hold({ recordId, until }) {
    if (!until || !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
      throw new Error("Invalid 'until' (expected YYYY-MM-DD)");
    }
    await updateListingRecord(recordId, {
      [FIELD.actionCardState]: "Held",
      [FIELD.actionHoldUntil]: until,
    });
  },
  async clear({ recordId }) {
    await updateListingRecord(recordId, {
      [FIELD.actionCardState]: "Cleared",
    });
  },

  // Deal-side actions
  async sign_contract({ recordId }) {
    await updateDealRecord(recordId, {
      [FIELD.dealClosingStatus]: "Contract Signed",
    });
  },
  async walk_away({ recordId }) {
    await updateDealRecord(recordId, {
      [FIELD.dealStatus]: "Failed",
    });
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
