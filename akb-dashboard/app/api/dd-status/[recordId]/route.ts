import { NextResponse } from "next/server";
import { getListing } from "@/lib/airtable";
import { getVolleyText } from "@/lib/dd-volley";
import { parseDDAnswersFromTimeline } from "@/lib/dd-parser";
import { DD_V3_ITEMS, type DDItem, type DDStatus, type DealContext } from "@/types/jarvis";

export const runtime = "nodejs";
export const maxDuration = 30;

const STAGES_REQUIRING_VOLLEY = new Set(["Response Received", "Negotiating"]);
const STAGES_REQUIRING_FULL_DD = new Set(["Offer Accepted"]);

// Volley 1 covers Vacancy + Utility (DD items 1+2). Volley 2 covers the
// big-systems bundle (3-10). Volley 3 covers env + legal (11-12). When
// informal answers already cover a volley's items, we skip past it.
const VOLLEY_COVERAGE: Record<1 | 2 | 3, DDItem[]> = {
  1: ["Vacancy/Occupancy Status", "Utility Status Known"],
  2: [
    "Roof Age Asked",
    "HVAC Age Asked",
    "Water Heater Age Asked",
    "Electrical Age Asked",
    "Plumbing Age Asked",
    "Foundation Issues Disclosed",
    "Active Leaks Disclosed",
    "Sewer Issues Disclosed",
  ],
  3: ["Environmental Hazards Disclosed", "Permits/Violations Disclosed"],
};

function originFromReq(req: Request): string {
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}

async function fetchTimelineFromDealContext(
  origin: string,
  recordId: string,
  cookie: string | null,
): Promise<DealContext | null> {
  try {
    const headers: Record<string, string> = {};
    if (cookie) headers.cookie = cookie;
    const res = await fetch(`${origin}/api/deal-context/${recordId}`, { headers, cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as DealContext | { error: string };
    if ("error" in data) return null;
    return data;
  } catch {
    return null;
  }
}

function nextVolleyToFire(
  volleyState: DDStatus["volleyState"],
  combinedAnswered: Set<DDItem>,
): 1 | 2 | 3 | null {
  for (const idx of [1, 2, 3] as const) {
    if (volleyState[`text${idx}SentAt` as `text${1 | 2 | 3}SentAt`]) continue;
    const items = VOLLEY_COVERAGE[idx];
    const allCovered = items.every((it) => combinedAnswered.has(it));
    if (!allCovered) return idx;
  }
  return null;
}

export async function GET(
  req: Request,
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

  // Pull timeline so we can run the informal-answer parser. Deal-context is
  // 60s-cached, so when the brief calls deal-context then dd-status we hit
  // the cache here.
  const dealContext = await fetchTimelineFromDealContext(
    originFromReq(req),
    recordId,
    req.headers.get("cookie"),
  );
  const informal = dealContext
    ? parseDDAnswersFromTimeline(dealContext.timeline)
    : { answered: [] as DDItem[], evidence: {} };

  const checked = new Set((listing.ddChecklist ?? []) as string[]);
  const ddFormalAnsweredItems: DDItem[] = DD_V3_ITEMS.filter((it) => checked.has(it));
  const ddInformalAnsweredItems = informal.answered;

  // Combined answered set — formal ∪ informal.
  const combined = new Set<DDItem>([...ddFormalAnsweredItems, ...ddInformalAnsweredItems]);
  const ddCheckedItems: DDItem[] = DD_V3_ITEMS.filter((it) => combined.has(it));
  const ddMissingItems: DDItem[] = DD_V3_ITEMS.filter((it) => !combined.has(it));

  const status = listing.outreachStatus ?? "";
  const volleyState = {
    text1SentAt: listing.ddVolleyText1SentAt ?? null,
    text2SentAt: listing.ddVolleyText2SentAt ?? null,
    text3SentAt: listing.ddVolleyText3SentAt ?? null,
  };

  const requiresVolley = STAGES_REQUIRING_VOLLEY.has(status);
  const requiresFullDD = STAGES_REQUIRING_FULL_DD.has(status);

  // Volley enforcement now respects informal answers: if Vacancy + Utility
  // are already known from inbound timeline, canCounter = true even without
  // a formal volley send.
  const volleyOneItemsCovered = VOLLEY_COVERAGE[1].every((it) => combined.has(it));
  const volleyStarted =
    !!(volleyState.text1SentAt || volleyState.text2SentAt || volleyState.text3SentAt) ||
    volleyOneItemsCovered;
  const canCounter = !requiresVolley || volleyStarted;
  const canSignPA = !requiresFullDD || ddMissingItems.length === 0;

  // Recommended actions: walk through volley sequence skipping any volley
  // whose items are already informally answered, then mark complete.
  const actions: DDStatus["recommendedActions"] = [];
  if (requiresVolley || requiresFullDD) {
    const next = nextVolleyToFire(volleyState, combined);
    if (next != null) {
      const labels: Record<1 | 2 | 3, string> = {
        1: "Send DD volley text 1 (occupancy + utilities)",
        2: "Send DD volley text 2 (big systems + structural)",
        3: "Send DD volley text 3 (environmental + legal)",
      };
      actions.push({
        action: `send_volley_text_${next}` as DDStatus["recommendedActions"][number]["action"],
        label: labels[next],
        suggestedDraft: getVolleyText(next, listing.agentName),
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

  const result: DDStatus = {
    recordId,
    outreachStatus: listing.outreachStatus,
    ddCompleteCount: ddCheckedItems.length,
    ddTotal: DD_V3_ITEMS.length,
    ddCheckedItems,
    ddMissingItems,
    ddFormalAnsweredItems,
    ddInformalAnsweredItems,
    ddInformalEvidence: informal.evidence,
    canCounter,
    canSignPA,
    volleyState,
    recommendedActions: actions,
  };

  return NextResponse.json(result);
}
