// DD V3.0 informal-answer parser.
//
// The agent often answers DD questions in conversation BEFORE Alex fires
// the formal volley templates. We scan inbound timeline messages for
// keyword patterns and credit each DD V3.0 item that's been answered,
// even if the formal DD_Checklist multi-select hasn't been ticked.
//
// Output is consumed by /api/dd-status to compute informallyAnswered
// alongside formallyAnswered.

import type { TimelineEntry } from "@/types/jarvis";
import { DD_V3_ITEMS, type DDItem } from "@/types/jarvis";

export interface DDInformalAnswers {
  // DD V3.0 items the parser is confident were answered in the timeline.
  answered: DDItem[];
  // Per-item evidence: which message snippet drove the credit.
  evidence: Partial<Record<DDItem, { snippet: string; timestamp: string }>>;
}

interface PatternRule {
  item: DDItem;
  patterns: RegExp[];
  // Optional require — text must ALSO match this to count (filters false
  // positives on word-fragment matches).
  requireAny?: RegExp[];
}

const RULES: PatternRule[] = [
  {
    item: "Vacancy/Occupancy Status",
    patterns: [
      /\bvacant\b/i,
      /\bunoccupied\b/i,
      /\btenant\s*[- ]?\s*occupied\b/i,
      /\boccupied\b/i,
      /\bsquatter/i,
      /\b(?:no one|nobody)\s+(?:lives|living)\s+(?:there|here)\b/i,
    ],
  },
  {
    item: "Utility Status Known",
    patterns: [
      /\bno\s+util(?:ity|ities)\b/i,
      /\butil(?:ity|ities)\s+(?:are\s+)?(?:on|off|disconnected|shut\s*off)\b/i,
      /\bwinteriz(?:ed|ation)\b/i,
      /\b(?:water|gas|electric)\s+(?:is\s+)?(?:on|off|shut\s*off|disconnected|disabled)\b/i,
      /\bpower\s+(?:is\s+)?(?:on|off)\b/i,
    ],
  },
  {
    item: "Roof Age Asked",
    patterns: [
      /\broof\b.*(?:age|years?|old|new|original|replaced|need)/i,
      /\b(?:new|old|original)\s+roof\b/i,
      /\broof\s+(?:is|was)\s+(?:replaced|done|new|old)\b/i,
      /\broof\s+(?:needs?|good|fine|ok)\b/i,
    ],
  },
  {
    item: "HVAC Age Asked",
    patterns: [
      /\bhvac\b/i,
      /\bfurnace\b/i,
      /\bheat\s*pump\b/i,
      /\b(?:central\s+)?(?:air|a\/?c)\b.*(?:age|years?|old|new|works|broken|needs?|none)/i,
      /\bneeds?\s+hvac\b/i,
      /\bno\s+(?:hvac|furnace|a\/?c)\b/i,
    ],
  },
  {
    item: "Water Heater Age Asked",
    patterns: [
      /\bwater\s+heater\b/i,
      /\bhot\s+water\s+(?:heater|tank)\b/i,
      /\btankless\b/i,
    ],
  },
  {
    item: "Electrical Age Asked",
    patterns: [
      /\belectric(?:al)?\b.*(?:panel|wiring|service|knob|tube|original|new|updated|amp)/i,
      /\bknob\s*(?:and|&|n')\s*tube\b/i,
      /\b(?:100|150|200)\s*amp\b/i,
      /\bbreaker\s+(?:box|panel)\b/i,
      /\bexisting\s+electrical\b/i,
    ],
  },
  {
    item: "Plumbing Age Asked",
    patterns: [
      /\bplumb(?:ing|er)\b/i,
      /\bcast\s*iron\b/i,
      /\blead\s*(?:pipe|line|service)\b/i,
      /\bpex\b/i,
      /\bcopper\s+(?:pipe|plumb)/i,
      /\bgalvaniz(?:ed)?\b/i,
      /\bexisting\s+plumb/i,
    ],
  },
  {
    item: "Foundation Issues Disclosed",
    patterns: [
      /\bfoundation\b/i,
      /\bbasement\s+(?:crack|leak|wall|wet|dry)/i,
      /\bsettling\b/i,
      /\bcrack(?:s|ed|ing)?\s+(?:wall|foundation|slab)/i,
      /\bno\s+foundation\s+(?:issues|problems|cracks)\b/i,
    ],
  },
  {
    item: "Active Leaks Disclosed",
    patterns: [
      /\b(?:active|known)\s+leak/i,
      /\bleak(?:s|ing)?\b.*(?:roof|ceiling|pipe|basement|water)/i,
      /\b(?:water|moisture)\s+damage\b/i,
      /\bno\s+(?:active\s+)?leaks?\b/i,
      /\bdry\s+basement\b/i,
    ],
  },
  {
    item: "Sewer Issues Disclosed",
    patterns: [
      /\bsewer\s+(?:line|main|backup|issue|problem|replace)/i,
      /\b(?:cast\s*iron|clay|orangeburg)\s+sewer\b/i,
      /\bno\s+sewer\s+(?:issues|problems|backups?)\b/i,
    ],
  },
  {
    item: "Environmental Hazards Disclosed",
    patterns: [
      /\basbestos\b/i,
      /\blead\s+(?:paint|based|hazard)\b/i,
      /\bmold\b/i,
      /\bmildew\b/i,
      /\bradon\b/i,
      /\bunderground\s+(?:storage\s+)?tank\b/i,
      /\bno\s+(?:asbestos|lead|mold|environmental)/i,
    ],
  },
  {
    item: "Permits/Violations Disclosed",
    patterns: [
      /\bopen\s+permit/i,
      /\b(?:building\s+)?code\s+violation/i,
      /\bunpermitted\s+(?:work|addition|garage|conversion)/i,
      /\bcity\s+(?:violation|citation|notice)/i,
      /\bcondemned\b/i,
      /\bno\s+(?:permits?|violations?)\b/i,
    ],
  },
];

export function parseDDAnswersFromTimeline(timeline: TimelineEntry[]): DDInformalAnswers {
  const answered = new Set<DDItem>();
  const evidence: Partial<Record<DDItem, { snippet: string; timestamp: string }>> = {};

  // Walk newest → oldest so the most recent mention wins for a given item.
  const inboundOnly = timeline
    .filter((e) => e.direction === "in" && e.channel !== "system" && (e.body ?? "").length > 0)
    .slice()
    .reverse();

  for (const entry of inboundOnly) {
    const body = entry.body ?? "";
    for (const rule of RULES) {
      if (answered.has(rule.item)) continue;
      const hit = rule.patterns.some((p) => p.test(body));
      if (!hit) continue;
      if (rule.requireAny && !rule.requireAny.some((p) => p.test(body))) continue;
      answered.add(rule.item);
      evidence[rule.item] = {
        snippet: body.slice(0, 200),
        timestamp: entry.timestamp,
      };
    }
    if (answered.size === DD_V3_ITEMS.length) break;
  }

  return {
    answered: DD_V3_ITEMS.filter((it) => answered.has(it)),
    evidence,
  };
}
