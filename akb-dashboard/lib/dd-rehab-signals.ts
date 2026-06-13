// DD-answer rehab signal extractor (spine recZ6tBZRmfFOLwqo, doctrine added
// to SYSTEM_HANDOFF.md 2026-06-13). @agent: appraiser
//
// THE PROBLEM IT SOLVES: the existing DD parser (lib/dd-parser) marks
// items "answered" but THROWS THE ANSWER CONTENT AWAY. Agent says "roof
// is 5 years old, electrical updated in 2010" — the system files "Roof
// Age Asked: answered, Electrical Age Asked: answered" and keeps the
// vision-fabricated rehab number untouched. That is the wire the
// operator named at 1am on 2026-06-13. This module pulls the structured
// AGE BUCKET out of those replies so a downstream module can collapse
// the rehab band.
//
// What we extract per mechanical: { ageBucket, evidenceSnippet }. We do
// NOT pretend to extract exact years — "5 years" vs "original" vs
// "updated in the 90s" is enough to swing rehab by tens of thousands;
// pinning to the dollar is the lie this whole rewrite exists to stop.

import type { TimelineEntry } from "@/types/jarvis";

export type AgeBucket =
  | "original_pre1980"   // "original", "knob & tube", "cast iron", or matches the house's pre-1980 build year with no update mention
  | "updated_post1980"   // "new", "updated", "replaced", "5 years old", post-1980 year mentioned
  | "unknown";           // item not addressed or ambiguous

export type Mechanical = "roof" | "hvac" | "waterHeater" | "electrical" | "plumbing";

export interface MechanicalSignal {
  bucket: AgeBucket;
  evidence: string | null; // snippet, ≤200 chars, null when unknown
  timestamp: string | null;
}

export interface DDRehabSignals {
  roof: MechanicalSignal;
  hvac: MechanicalSignal;
  waterHeater: MechanicalSignal;
  electrical: MechanicalSignal;
  plumbing: MechanicalSignal;
  /** How many of the 5 mechanicals are answered (not unknown). The DD-as-
   *  offer-gate threshold reads this. */
  answeredCount: number;
}

const NEW_PATTERNS = [
  /\b(?:brand\s+)?new\b/i,
  /\bupdated\b/i,
  /\bupgraded\b/i,
  /\breplaced\b/i,
  /\brecent(?:ly)?\b/i,
  /\b(?:last|past)\s+(?:few|couple|several)\s+years?\b/i,
  /\b(?:1|2|3|4|5|6|7|8|9|10|fifteen|twenty)\s*[- ]?\s*(?:yr|year)s?\s*(?:old|ago|new)?\b/i,
  /\b(?:200[0-9]|201[0-9]|202[0-9]|199[0-9]|198[0-9])\b/i, // year 1980+
];

const ORIGINAL_PATTERNS = [
  /\boriginal\b/i,
  /\bknob\s*(?:and|&|n')\s*tube\b/i,
  /\bcast\s*iron\b/i,
  /\bgalvanized\b/i,
  /\bnever\s+(?:replaced|updated|touched)\b/i,
  /\b(?:from|since)\s+(?:build|construction|the\s+house|day\s+one)\b/i,
  /\b(?:1[8-9]|19[0-7])[0-9]{2}\b/i, // pre-1980 year mention
];

// Per-mechanical keyword anchors. A sentence/phrase must include one of
// these for that mechanical to be eligible to claim a signal — keeps
// "roof updated" from claiming electrical was updated.
const ANCHORS: Record<Mechanical, RegExp[]> = {
  roof: [/\broof\b/i, /\bshingles?\b/i],
  hvac: [/\bhvac\b/i, /\bfurnace\b/i, /\bboiler\b/i, /\bheat(?:ing)?\b/i, /\b(?:central\s+)?a\.?c\.?\b/i, /\bair\s+conditioning\b/i],
  waterHeater: [/\bwater\s+heater\b/i, /\bhot\s+water\s+(?:heater|tank)\b/i, /\bwater\s+tank\b/i],
  electrical: [/\belectric(?:al)?\b/i, /\bwiring\b/i, /\bpanel\b/i, /\bbreaker\b/i, /\bknob\s*(?:and|&|n')\s*tube\b/i],
  plumbing: [/\bplumb(?:ing|er)\b/i, /\bpipes?\b/i, /\bcast\s*iron\b/i, /\bpex\b/i, /\bcopper\b/i, /\bgalvanized\b/i],
};

// Splitter that keeps "roof is 5 years, electrical original" as TWO
// independent claims rather than one blended one.
function splitClauses(body: string): string[] {
  return body
    .split(/[.;\n]|,\s+(?=[A-Za-z])/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function classifyClause(clause: string): "updated_post1980" | "original_pre1980" | "unknown" {
  // Original wins over updated when both fire on the same clause —
  // "originally knob & tube, partially updated" still has knob & tube.
  if (ORIGINAL_PATTERNS.some((p) => p.test(clause))) return "original_pre1980";
  if (NEW_PATTERNS.some((p) => p.test(clause))) return "updated_post1980";
  return "unknown";
}

/** Pure: extract per-mechanical age buckets from the inbound message
 *  timeline. Newest answer wins for each mechanical. */
export function extractDDRehabSignals(timeline: TimelineEntry[]): DDRehabSignals {
  const out: DDRehabSignals = {
    roof: { bucket: "unknown", evidence: null, timestamp: null },
    hvac: { bucket: "unknown", evidence: null, timestamp: null },
    waterHeater: { bucket: "unknown", evidence: null, timestamp: null },
    electrical: { bucket: "unknown", evidence: null, timestamp: null },
    plumbing: { bucket: "unknown", evidence: null, timestamp: null },
    answeredCount: 0,
  };

  // Newest first — first hit per mechanical wins.
  const inbound = timeline
    .filter((e) => e.direction === "in" && e.channel !== "system" && (e.body ?? "").length > 0)
    .slice()
    .reverse();

  const mechs: Mechanical[] = ["roof", "hvac", "waterHeater", "electrical", "plumbing"];

  for (const entry of inbound) {
    for (const clause of splitClauses(entry.body)) {
      for (const m of mechs) {
        if (out[m].bucket !== "unknown") continue;
        if (!ANCHORS[m].some((p) => p.test(clause))) continue;
        const b = classifyClause(clause);
        if (b === "unknown") continue;
        out[m] = { bucket: b, evidence: clause.slice(0, 200), timestamp: entry.timestamp };
      }
    }
    if (mechs.every((m) => out[m].bucket !== "unknown")) break;
  }

  out.answeredCount = mechs.filter((m) => out[m].bucket !== "unknown").length;
  return out;
}
