import type { DealStage, TimelineEntry } from "@/types/jarvis";

const PA_PATTERNS = [
  /\bname\s+(?:on|for)\s+(?:the\s+)?(?:pa|purchase\s+agreement|offer\s+letter|contract)\b/i,
  /\bsend\s+(?:over\s+)?the\s+(?:pa|purchase\s+agreement|contract)\b/i,
  /\bdrafting\s+(?:the\s+)?(?:pa|purchase\s+agreement)\b/i,
  /\bpa\s+(?:draft|letter|over)\b/i,
  /\bget\s+(?:the\s+)?(?:contract|pa)\s+(?:over|going|signed)\b/i,
  /\bemail\s+(?:over\s+)?the\s+(?:pa|purchase\s+agreement|contract)\b/i,
];

const COST_PATTERNS = [
  /\b(?:closing\s+cost|cost\s+breakdown|all[- ]?in|net\s+(?:to|amount|number)|cost\s+to\s+(?:close|seller))\b/i,
  /\bwhat\s+(?:are|will)\s+the\s+(?:total\s+)?(?:closing\s+costs|costs?)\b/i,
  /\bwho\s+(?:pays|covers)\s+(?:the\s+)?(?:closing|title|escrow)\b/i,
];

const INSPECTION_PATTERNS = [
  /\binspection\s+(?:scheduled|set|on|date|window|complete|done)\b/i,
  /\bwalkthrough\s+(?:scheduled|set|on|date)\b/i,
  /\boption\s+period\b/i,
];

const ACCEPT_PATTERNS = [
  /\b(?:i'?ll\s+take\s+it|works?\s+for\s+(?:me|us)|we'?ll\s+(?:take|do)\s+it|that\s+works|seller\s+(?:agreed|accepted)|deal|sounds?\s+(?:good|great))\b/i,
];

function anyMatch(patterns: RegExp[], s: string): boolean {
  return patterns.some((p) => p.test(s));
}

export interface DealStageSignals {
  paDrafting: boolean;
  costClarificationPending: boolean;
  inspectionStarted: boolean;
}

export function detectStageSignals(timeline: TimelineEntry[]): DealStageSignals {
  if (timeline.length === 0) {
    return { paDrafting: false, costClarificationPending: false, inspectionStarted: false };
  }

  // Inspect the last ~10 entries — older signals stale out.
  const recent = timeline.slice(-10);
  let lastInboundIdx = -1;
  let lastOutboundIdx = -1;
  for (let i = recent.length - 1; i >= 0; i--) {
    const e = recent[i];
    if (e.channel === "system") continue;
    if (e.direction === "in" && lastInboundIdx === -1) lastInboundIdx = i;
    if (e.direction === "out" && lastOutboundIdx === -1) lastOutboundIdx = i;
  }

  let paDrafting = false;
  let inspectionStarted = false;
  for (const entry of recent) {
    if (entry.channel === "system") continue;
    const body = entry.body ?? "";
    if (anyMatch(PA_PATTERNS, body)) paDrafting = true;
    if (anyMatch(INSPECTION_PATTERNS, body)) inspectionStarted = true;
  }

  // Cost clarification is "pending" when:
  //   (a) the agent's most recent message asked about costs (we owe them an answer), OR
  //   (b) our most recent message asked about costs (we're awaiting their breakdown).
  let costClarificationPending = false;
  if (lastInboundIdx >= 0 && anyMatch(COST_PATTERNS, recent[lastInboundIdx].body ?? "")) {
    costClarificationPending = true;
  }
  if (lastOutboundIdx >= 0 && anyMatch(COST_PATTERNS, recent[lastOutboundIdx].body ?? "")) {
    costClarificationPending = true;
  }

  return { paDrafting, costClarificationPending, inspectionStarted };
}

export interface InferStageInput {
  outreachStatus: string | null;
  timeline: TimelineEntry[];
  signals: DealStageSignals;
}

export function inferDealStage(input: InferStageInput): DealStage {
  const status = (input.outreachStatus ?? "").trim();
  if (status === "Dead" || status === "Walked" || status === "Terminated" || status === "No Response") return "dead";
  if (status === "Won" || status === "Closed") return "won";

  if (input.signals.inspectionStarted) return "inspection";

  if (status === "Offer Accepted") return "accepted_pending_pa";

  if (status === "Negotiating") {
    // If the seller's last move accepted, escalate to accepted_pending_pa.
    const lastInbound = [...input.timeline].reverse().find((e) => e.direction === "in" && e.channel !== "system");
    if (lastInbound && anyMatch(ACCEPT_PATTERNS, lastInbound.body ?? "")) {
      return "accepted_pending_pa";
    }
    return "negotiating";
  }

  if (status === "Response Received" || status === "Inbound Lead") return "engaged";
  if (status === "Texted" || status === "Emailed") return "outreach";
  return "cold";
}

export const DEAL_STAGE_LABEL: Record<DealStage, string> = {
  cold: "Cold",
  outreach: "Outreach",
  engaged: "Engaged",
  negotiating: "Negotiating",
  accepted_pending_pa: "Accepted · awaiting PA",
  pa_signed: "PA signed",
  inspection: "Inspection",
  closing: "Closing",
  dead: "Dead",
  won: "Won",
};
