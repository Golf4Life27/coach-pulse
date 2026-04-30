import { NextResponse } from "next/server";
import { getListings, getDeals } from "@/lib/airtable";
import { buildActionQueue } from "@/lib/actionQueue";
import { Briefing, BriefingGap } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET() {
  try {
    // Two cached calls; everything else is computed in-memory.
    const [listings, deals] = await Promise.all([getListings(), getDeals()]);
    const queue = buildActionQueue(listings, deals);

    const countKind = (kind: "response" | "stale") =>
      queue.open.filter((c) => c.kind === kind).length +
      queue.held.filter((c) => c.kind === kind).length;

    const pendingResponses = countKind("response");
    const staleNegotiations = countKind("stale");

    const activeNegotiations = listings.filter(
      (l) => l.outreachStatus === "Negotiating",
    ).length;

    const todayISO = new Date().toISOString().slice(0, 10);
    const textsToday = listings.filter(
      (l) =>
        (l.outreachStatus === "Texted" || l.outreachStatus === "Emailed") &&
        typeof l.lastOutreachDate === "string" &&
        l.lastOutreachDate.startsWith(todayISO),
    ).length;

    // Gaps documented in the Step 4 summary:
    //  - dealDeadlines7d: no option-period expiration field on Deals.
    //  - responseRateToday: no inbound-timestamp field; can't compute today's
    //    responses-vs-texts ratio without inventing numbers.
    //  - makeErrors24h: no Make execution log surfaced into Airtable yet.
    //  - pendingResponses isn't actually "since last login" — it's the count
    //    of currently-pending Response cards. Reflected here for transparency.
    const gaps: BriefingGap[] = [
      "dealDeadlines7d",
      "responseRateToday",
      "makeErrors24h",
      "pendingResponsesSinceLogin",
    ];

    const briefing: Briefing = {
      pendingResponses,
      activeNegotiations,
      staleNegotiations,
      dealDeadlines7d: 0,
      textsToday,
      responseRateToday: null,
      makeErrors24h: 0,
      gaps,
    };

    return NextResponse.json(briefing);
  } catch (err) {
    console.error("[briefing] error:", err);
    return NextResponse.json(
      { error: "Failed to build briefing", detail: String(err) },
      { status: 500 },
    );
  }
}
