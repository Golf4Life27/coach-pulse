import { getListings, getDeals } from "@/lib/airtable";
import { parseConversation } from "@/lib/notes";

export const runtime = "nodejs";
export const maxDuration = 30;

const DEAD_STATUSES = new Set(["Dead", "Walked", "Terminated", "No Response"]);
const REJECTED_PATHS = new Set(["Reject"]);

interface BriefingItem {
  recordId: string;
  address: string;
  city: string | null;
  state: string | null;
  agentName: string | null;
  agentPhone: string | null;
  listPrice: number | null;
  offer: number | null;
  outreachStatus: string | null;
  daysSinceTouch: number | null;
  lastActivity: string;
}

interface MorningBriefing {
  signNow: BriefingItem[];
  respondToday: BriefingItem[];
  counterDecisions: BriefingItem[];
  followUp: BriefingItem[];
  stale: BriefingItem[];
  stats: {
    totalActive: number;
    negotiating: number;
    responseReceived: number;
    offerAccepted: number;
    texted: number;
    dead: number;
  };
}

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / 86_400_000);
}

function hoursSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / 3_600_000);
}

function lastActivitySummary(notes: string | null): string {
  if (!notes) return "No activity";
  const entries = parseConversation(notes);
  if (entries.length === 0) {
    const lines = notes.split("\n").filter((l) => l.trim());
    return lines[lines.length - 1]?.slice(0, 80) ?? "No activity";
  }
  const last = entries[entries.length - 1];
  const prefix = last.type === "inbound" ? "Agent:" : last.type === "outbound" ? "You:" : "";
  return `${prefix} ${last.text.slice(0, 80)}`;
}

function roundOffer(listPrice: number): number {
  return Math.ceil((listPrice * 0.65) / 250) * 250;
}

function toBriefingItem(l: {
  id: string;
  address: string;
  city: string | null;
  state: string | null;
  agentName: string | null;
  agentPhone: string | null;
  listPrice: number | null;
  outreachStatus: string | null;
  lastOutreachDate: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  notes: string | null;
}): BriefingItem {
  const lastTouch = [l.lastInboundAt, l.lastOutboundAt, l.lastOutreachDate]
    .filter(Boolean)
    .sort()
    .pop() ?? null;

  return {
    recordId: l.id,
    address: l.address,
    city: l.city ?? null,
    state: l.state ?? null,
    agentName: l.agentName,
    agentPhone: l.agentPhone,
    listPrice: l.listPrice,
    offer: l.listPrice ? roundOffer(l.listPrice) : null,
    outreachStatus: l.outreachStatus,
    daysSinceTouch: daysSince(lastTouch),
    lastActivity: lastActivitySummary(l.notes),
  };
}

export async function GET() {
  try {
    const [listings] = await Promise.all([getListings()]);

    // Filter out dead/rejected/cleared
    const active = listings.filter(
      (l) =>
        !DEAD_STATUSES.has(l.outreachStatus ?? "") &&
        !REJECTED_PATHS.has(l.executionPath ?? "") &&
        l.actionCardState !== "Cleared"
    );

    const signNow: BriefingItem[] = [];
    const respondToday: BriefingItem[] = [];
    const counterDecisions: BriefingItem[] = [];
    const followUp: BriefingItem[] = [];
    const stale: BriefingItem[] = [];

    for (const l of active) {
      const item = toBriefingItem(l);
      const notesLower = (l.notes ?? "").toLowerCase();

      // SIGN NOW: Offer Accepted or contract-ready language
      if (
        l.outreachStatus === "Offer Accepted" ||
        notesLower.includes("contract ready") ||
        notesLower.includes("purchase agreement") ||
        notesLower.includes("pa sent") ||
        notesLower.includes("send the contract")
      ) {
        signNow.push(item);
        continue;
      }

      // RESPOND TODAY: Response Received status (agent replied, needs attention)
      // Uses status as primary signal since lastInboundAt may not be populated yet
      if (l.outreachStatus === "Response Received") {
        respondToday.push(item);
        continue;
      }

      // Also catch: inbound timestamp in last 48h with no outbound after (for Negotiating records)
      const inboundHours = hoursSince(l.lastInboundAt);
      const outboundHours = hoursSince(l.lastOutboundAt);
      if (
        l.outreachStatus === "Negotiating" &&
        inboundHours !== null &&
        inboundHours <= 48 &&
        (outboundHours === null || outboundHours > inboundHours)
      ) {
        respondToday.push(item);
        continue;
      }

      // COUNTER DECISIONS: Negotiating with counter language and no outbound in 48h+
      if (
        l.outreachStatus === "Negotiating" &&
        (notesLower.includes("counter") ||
          notesLower.includes("come up") ||
          notesLower.includes("best offer") ||
          notesLower.includes("what about") ||
          notesLower.includes("would you do")) &&
        (outboundHours === null || outboundHours >= 48)
      ) {
        counterDecisions.push(item);
        continue;
      }

      // FOLLOW UP: Texted 5+ days ago with no inbound reply
      // Use lastOutboundAt if available, fall back to lastOutreachDate for records
      // where outreach was sent but timestamp field hasn't been populated
      if (l.outreachStatus === "Texted") {
        const outboundDate = l.lastOutboundAt ?? l.lastOutreachDate;
        const outboundDays = daysSince(outboundDate);
        if (
          outboundDays !== null &&
          outboundDays >= 5 &&
          (l.lastInboundAt === null ||
            (outboundDate && new Date(l.lastInboundAt).getTime() < new Date(outboundDate).getTime()))
        ) {
          followUp.push(item);
          continue;
        }
      }

      // STALE: Negotiating or Response Received with 7+ days no activity
      if (
        (l.outreachStatus === "Negotiating" || l.outreachStatus === "Response Received") &&
        item.daysSinceTouch !== null &&
        item.daysSinceTouch >= 7
      ) {
        stale.push(item);
        continue;
      }
    }

    // Sort each group by stalest first
    const sortByStalest = (a: BriefingItem, b: BriefingItem) =>
      (b.daysSinceTouch ?? 0) - (a.daysSinceTouch ?? 0);

    signNow.sort(sortByStalest);
    respondToday.sort(sortByStalest);
    counterDecisions.sort(sortByStalest);
    followUp.sort(sortByStalest);
    stale.sort(sortByStalest);

    const stats = {
      totalActive: active.length,
      negotiating: active.filter((l) => l.outreachStatus === "Negotiating").length,
      responseReceived: active.filter((l) => l.outreachStatus === "Response Received").length,
      offerAccepted: active.filter((l) => l.outreachStatus === "Offer Accepted").length,
      texted: active.filter((l) => l.outreachStatus === "Texted").length,
      dead: listings.filter((l) => DEAD_STATUSES.has(l.outreachStatus ?? "")).length,
    };

    return Response.json({
      signNow,
      respondToday,
      counterDecisions,
      followUp,
      stale,
      stats,
    } as MorningBriefing);
  } catch (err) {
    console.error("[morning-briefing] error:", err);
    return Response.json(
      { error: "Failed to build briefing", detail: String(err) },
      { status: 500 }
    );
  }
}
