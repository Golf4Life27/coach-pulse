// LLM-context compressor for /api/jarvis-brief.
//
// Each fully-hydrated DealContext can include hundreds of timeline
// entries (Quo SMS paginated × 6 pages + Gmail threads × up to 50 +
// Notes). Sending all of that to Sonnet for 5 deals balloons the token
// count and the latency. compressForLLM() returns a smaller object
// that strips system entries, drops the verbose raw payload, and caps
// the timeline at the most recent ~10 conversational entries.
//
// Underlying DealContext is unchanged — the workspace + UI continue to
// see the full timeline.

import type { DealContext, TimelineEntry } from "@/types/jarvis";

const MAX_TIMELINE_ENTRIES = 10;
const MAX_BODY_CHARS = 220;
const MAX_LAST_INBOUND_CHARS = 320;
const MAX_NOTES_TAIL_CHARS = 1000;

export interface CompressedDealContext {
  recordId: string;
  agent: DealContext["agent"];
  property: DealContext["property"];
  outreachStatus: string | null;
  hoursSinceInbound: number | null;
  hoursSinceOutbound: number | null;
  responseDue: boolean;
  multiListingAlert: boolean;
  dealStage?: DealContext["dealStage"];
  dealStageSignals?: DealContext["dealStageSignals"];
  lastInboundBody: string | null;
  notesTail: string | null;
  timeline: Array<{
    timestamp: string;
    channel: TimelineEntry["channel"];
    direction: TimelineEntry["direction"];
    sender: string;
    body: string;
  }>;
  timelineDroppedCount: number;
}

function isLLMRelevant(entry: TimelineEntry): boolean {
  if (entry.channel === "system") return false;
  if (!entry.body || entry.body.trim().length < 4) return false;
  return true;
}

export function compressForLLM(ctx: DealContext): CompressedDealContext {
  const conversational = ctx.timeline.filter(isLLMRelevant);
  const trimmed = conversational.slice(-MAX_TIMELINE_ENTRIES);
  const droppedCount = ctx.timeline.length - trimmed.length;

  const lastInboundBodyRaw = (ctx.metadata?.lastInboundBody as string | undefined) ?? null;
  const lastInboundBody = lastInboundBodyRaw
    ? lastInboundBodyRaw.slice(0, MAX_LAST_INBOUND_CHARS)
    : null;

  // Notes content is already merged into the timeline by lib/timeline-merge,
  // so we surface only the most recent note-channel entry's tail (cap at
  // 1000 chars) to give the LLM Alex's manual context without exploding
  // the prompt.
  const lastNoteEntry = [...ctx.timeline].reverse().find(
    (e) => e.channel === "note" && (e.body ?? "").length > 0,
  );
  const notesTail = lastNoteEntry ? lastNoteEntry.body.slice(-MAX_NOTES_TAIL_CHARS) : null;

  return {
    recordId: ctx.recordId,
    agent: ctx.agent,
    property: ctx.property,
    outreachStatus: (ctx.metadata?.outreachStatus as string | undefined) ?? null,
    hoursSinceInbound: ctx.hoursSinceInbound,
    hoursSinceOutbound: ctx.hoursSinceOutbound,
    responseDue: ctx.responseDue,
    multiListingAlert: ctx.multiListingAlert,
    dealStage: ctx.dealStage,
    dealStageSignals: ctx.dealStageSignals,
    lastInboundBody,
    notesTail,
    timeline: trimmed.map((e) => ({
      timestamp: e.timestamp,
      channel: e.channel,
      direction: e.direction,
      sender: e.sender,
      body: (e.body ?? "").replace(/\s+/g, " ").slice(0, MAX_BODY_CHARS),
    })),
    timelineDroppedCount: Math.max(0, droppedCount),
  };
}

/**
 * Renders a compressed deal context's timeline to the multi-line text
 * block used in the LLM user prompt. Format is intentionally identical
 * to the previous inline summarizeTimeline output so prompt behavior is
 * preserved.
 */
export function renderCompressedTimeline(c: CompressedDealContext): string {
  if (c.timeline.length === 0) return "(no recent timeline entries)";
  return c.timeline
    .map((e) => {
      // Notes-channel entries carry the raw timestamp string from
      // lib/notes.ts (e.g. "5/13 10:30pm" without year) which new Date()
      // cannot parse — falls through as Invalid Date and toISOString()
      // throws RangeError. Fall back to the raw string when parsing
      // fails so the brief doesn't 500 on records dominated by notes.
      let ts = "—";
      if (e.timestamp) {
        const d = new Date(e.timestamp);
        if (!isNaN(d.getTime())) {
          ts = d.toISOString().replace("T", " ").slice(0, 16);
        } else {
          ts = e.timestamp.slice(0, 16);
        }
      }
      const dir = e.direction === "in" ? "AGENT" : "ALEX";
      return `[${ts}] ${dir} (${e.channel.toUpperCase()}): ${e.body}`;
    })
    .join("\n");
}
