// Phase 13 / N.3 — Sentinel approval queue feed.
//
// GET /api/sentinel/queue
//
// Lightweight metadata-only listing of active deals where the agent
// owes a reply (last inbound newer than last outbound). Powers the
// Sentinel approval-queue UI on /sentinel — no LLM calls here;
// per-row classify+draft fires on demand via /api/sentinel/draft/
// [recordId] when the operator clicks "Classify & draft".
//
// Filter rules:
//   - Active outreach status only (getActiveListingsForBrief view)
//   - lastInboundAt present
//   - lastInboundAt > lastOutboundAt OR lastOutboundAt is null
//     (the "we owe them a reply" gate that mirrors what
//     jarvis-brief's responseDue computes from the timeline)
//
// Sort: newest inbound first (operator triages the freshest threads).

import { NextResponse } from "next/server";
import { getActiveListingsForBrief } from "@/lib/airtable";
import { lastInboundLine } from "@/lib/notes";

export const runtime = "nodejs";
export const maxDuration = 30;

const PREVIEW_CHARS = 240;

export interface SentinelQueueItem {
  recordId: string;
  address: string;
  agent_name: string | null;
  state: string | null;
  list_price: number | null;
  outreach_status: string | null;
  last_inbound_at: string;
  hours_since_inbound: number | null;
  last_inbound_preview: string;
  /** True when the listing already has a non-null Seller_Motivation_Score
   *  (operator or prior auto-write). Surfaces in the UI so the
   *  approval queue can mark which rows have been scored. */
  has_motivation_score: boolean;
}

function hoursSince(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 3_600_000));
}

export async function GET() {
  const t0 = Date.now();
  const active = await getActiveListingsForBrief({ recentDays: 14 });

  const items: SentinelQueueItem[] = [];
  for (const l of active) {
    if (!l.lastInboundAt) continue;
    const inboundT = new Date(l.lastInboundAt).getTime();
    if (!Number.isFinite(inboundT)) continue;

    // "Owes them a reply" gate: inbound newer than outbound, OR no
    // outbound yet at all. Matches jarvis-brief's responseDue.
    if (l.lastOutboundAt) {
      const outboundT = new Date(l.lastOutboundAt).getTime();
      if (Number.isFinite(outboundT) && outboundT >= inboundT) continue;
    }

    const preview = (lastInboundLine(l.notes) ?? "").slice(0, PREVIEW_CHARS);
    items.push({
      recordId: l.id,
      address: l.address,
      agent_name: l.agentName,
      state: l.state,
      list_price: l.listPrice,
      outreach_status: l.outreachStatus,
      last_inbound_at: l.lastInboundAt,
      hours_since_inbound: hoursSince(l.lastInboundAt),
      last_inbound_preview: preview,
      has_motivation_score:
        typeof l.sellerMotivationScore === "number" && l.sellerMotivationScore > 0,
    });
  }

  // Sort newest inbound first.
  items.sort(
    (a, b) =>
      new Date(b.last_inbound_at).getTime() - new Date(a.last_inbound_at).getTime(),
  );

  return NextResponse.json({
    count: items.length,
    items,
    elapsed_ms: Date.now() - t0,
  });
}
