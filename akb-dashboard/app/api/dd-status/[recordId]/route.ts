import { NextResponse } from "next/server";
import { getListing } from "@/lib/airtable";
import { getVolleyText } from "@/lib/dd-volley";
import { DD_V3_ITEMS, type DDItem, type DDStatus } from "@/types/jarvis";

export const runtime = "nodejs";
export const maxDuration = 30;

const STAGES_REQUIRING_VOLLEY = new Set(["Response Received", "Negotiating"]);
const STAGES_REQUIRING_FULL_DD = new Set(["Offer Accepted"]);

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ recordId: string }> },
) {
  const { recordId } = await params;
  if (!recordId || !recordId.startsWith("rec")) {
    return NextResponse.json({ error: "Invalid record id", recordId }, { status: 400 });
  }

  const listing = await getListing(recordId);
  if (!listing) {
    return NextResponse.json({ error: "Listing not found", recordId }, { status: 404 });
  }

  const checked = new Set((listing.ddChecklist ?? []) as string[]);
  const ddCheckedItems: DDItem[] = DD_V3_ITEMS.filter((it) => checked.has(it));
  const ddMissingItems: DDItem[] = DD_V3_ITEMS.filter((it) => !checked.has(it));

  const status = listing.outreachStatus ?? "";
  const volleyState = {
    text1SentAt: listing.ddVolleyText1SentAt ?? null,
    text2SentAt: listing.ddVolleyText2SentAt ?? null,
    text3SentAt: listing.ddVolleyText3SentAt ?? null,
  };

  const volleyStarted = !!(volleyState.text1SentAt || volleyState.text2SentAt || volleyState.text3SentAt);
  const requiresVolley = STAGES_REQUIRING_VOLLEY.has(status);
  const requiresFullDD = STAGES_REQUIRING_FULL_DD.has(status);

  const canCounter = !requiresVolley || volleyStarted;
  const canSignPA = !requiresFullDD || ddMissingItems.length === 0;

  // Recommended actions: walk through volley sequence, then mark complete.
  const actions: DDStatus["recommendedActions"] = [];
  const firstName = listing.agentName?.split(/\s+/)[0] ?? "there";
  if (requiresVolley || requiresFullDD) {
    if (!volleyState.text1SentAt) {
      actions.push({
        action: "send_volley_text_1",
        label: "Send DD volley text 1 (occupancy + utilities)",
        suggestedDraft: getVolleyText(1, listing.agentName),
      });
    } else if (!volleyState.text2SentAt) {
      actions.push({
        action: "send_volley_text_2",
        label: "Send DD volley text 2 (big systems + structural)",
        suggestedDraft: getVolleyText(2, listing.agentName),
      });
    } else if (!volleyState.text3SentAt) {
      actions.push({
        action: "send_volley_text_3",
        label: "Send DD volley text 3 (environmental + legal)",
        suggestedDraft: getVolleyText(3, listing.agentName),
      });
    } else if (ddMissingItems.length > 0) {
      actions.push({
        action: "mark_complete",
        label: `Mark ${ddMissingItems.length} remaining DD item(s) complete`,
      });
    }
  }
  // Always offer override.
  actions.push({ action: "override", label: "Override DD requirement (audit-logged)" });

  // Suppress unused-var TS warning on firstName when no volley needed.
  void firstName;

  const result: DDStatus = {
    recordId,
    outreachStatus: listing.outreachStatus,
    ddCompleteCount: ddCheckedItems.length,
    ddTotal: DD_V3_ITEMS.length,
    ddCheckedItems,
    ddMissingItems,
    canCounter,
    canSignPA,
    volleyState,
    recommendedActions: actions,
  };

  return NextResponse.json(result);
}
