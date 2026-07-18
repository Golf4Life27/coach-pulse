import type { TimelineEntry } from "@/types/jarvis";

interface QuoMessage {
  id: string;
  from: string;
  to: string;
  body: string;
  direction: "incoming" | "outgoing";
  createdAt: string;
}

interface GmailMessage {
  id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  date: string;
}

interface NotesEntry {
  type: "inbound" | "outbound" | "system";
  text: string;
  timestamp: string | null;
}

export interface SiblingRecord {
  recordId: string;
  address: string;
  /** Candidate prices the body could plausibly match for THIS sibling —
   *  typically [listPrice, outreachOfferPrice] minus nulls. The scorer
   *  awards +0.3 if any candidate matches within $1000.
   *  INV-016 fix (2026-06-08): the old scalar `listPrice` only matched
   *  retail; H2 outbound bodies carry the OFFER (≈65% of list), so a
   *  seller-agent reply citing our offer never triggered the bonus. */
  candidatePrices: number[];
}

/** Pure: ±$1000 fuzzy match — body $-amounts vs any candidate price. */
function bodyMatchesAnyPrice(body: string, candidates: readonly number[]): boolean {
  if (candidates.length === 0) return false;
  const matches = body.match(/\$[\d,]+/g) ?? [];
  for (const pm of matches) {
    const val = parseInt(pm.replace(/[$,]/g, ""), 10);
    if (isNaN(val)) continue;
    for (const c of candidates) {
      if (c && Math.abs(val - c) <= 1000) return true;
    }
  }
  return false;
}

export function scorePropertyMatch(
  messageBody: string,
  targetAddress: string,
  targetPrices: readonly number[],
  siblings: SiblingRecord[]
): { recordId: string; confidence: number } {
  const bodyLower = messageBody.toLowerCase();
  const targetLower = targetAddress.toLowerCase();

  let targetScore = 0;
  const addrTokens = targetLower.split(/\s+/).filter((t) => t.length > 2);
  const tokenHits = addrTokens.filter((t) => bodyLower.includes(t)).length;
  if (addrTokens.length > 0 && tokenHits >= Math.ceil(addrTokens.length * 0.5)) {
    targetScore += 0.6;
  }

  if (bodyLower.includes("listing at") || bodyLower.includes("property at")) {
    const afterAt = bodyLower.split(/(?:listing|property) at\s*/i)[1] ?? "";
    if (addrTokens.some((t) => afterAt.includes(t))) targetScore += 0.2;
  }

  if (bodyMatchesAnyPrice(messageBody, targetPrices)) targetScore += 0.3;

  let bestSibling = { recordId: "", confidence: 0 };
  for (const sib of siblings) {
    let sibScore = 0;
    const sibTokens = sib.address.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    const sibHits = sibTokens.filter((t) => bodyLower.includes(t)).length;
    if (sibTokens.length > 0 && sibHits >= Math.ceil(sibTokens.length * 0.5)) sibScore += 0.6;
    if (bodyMatchesAnyPrice(messageBody, sib.candidatePrices)) sibScore += 0.3;
    if (sibScore > bestSibling.confidence) bestSibling = { recordId: sib.recordId, confidence: sibScore };
  }

  if (bestSibling.confidence > targetScore && bestSibling.confidence >= 0.5) return bestSibling;
  return { recordId: "", confidence: targetScore };
}

/** Whitespace-normalized text for dedup comparison. The notes parser drops
 *  blank lines (a "\n\n" paragraph break becomes "\n"), so raw substring
 *  matching missed the notes copy of a live message and rendered it TWICE
 *  (Duane Covert, 2026-07-13: live Quo bubble + quo_webhook notes bubble of
 *  the same reply). All whitespace collapses to single spaces before compare. */
function dedupNorm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function findDuplicate(entry: { body: string; direction: string }, existing: TimelineEntry[]): TimelineEntry | null {
  if (entry.body.length < 10) return null;
  const eNorm = dedupNorm(entry.body);
  const snippet = eNorm.slice(0, 40);
  if (snippet.length < 10) return null;
  const dir = entry.direction === "in" ? "in" : "out";
  // SYMMETRIC containment (2026-07-18, the Canfield double-bubble): notes
  // entries can carry prefixes/markers AROUND the same message the live
  // bubble shows bare ("Phone: +1734… Body: Are you not getting my
  // texts?"), so a one-way "does existing contain my head?" check misses.
  // Either direction of containment marks the pair as the same message.
  return (
    existing.find((e) => {
      if (e.direction !== dir) return false;
      const xNorm = dedupNorm(e.body);
      if (xNorm.includes(snippet)) return true;
      const xSnippet = xNorm.slice(0, 40);
      return xSnippet.length >= 10 && eNorm.includes(xSnippet);
    }) ?? null
  );
}

function isDuplicate(entry: { body: string; direction: string }, existing: TimelineEntry[]): boolean {
  return findDuplicate(entry, existing) != null;
}

export interface MergeOptions {
  recordId: string;
  targetAddress: string;
  /** All candidate prices the target listing's body could match — at
   *  minimum [listPrice], ideally [listPrice, outreachOfferPrice]. Empty
   *  array disables the +0.3 price-match bonus. */
  targetPrices: readonly number[];
  agentName: string | null;
  siblings?: SiblingRecord[];
  /** SOLE-ENGAGED TIE-BREAK (685 Bolton fix, 2026-07-13). True when the
   *  TARGET record is in a live-money status (Negotiating / Response
   *  Received / Counter Received / Offer Accepted) and NO sibling is. A
   *  multi-listing agent's generic SMS ("Ok, sounds good") carries no
   *  address/price signal, scored 0, and was hidden from ALL of the phone's
   *  threads — including the one deal actually being negotiated. Absent
   *  contrary signals, a mid-negotiation message belongs to the negotiation:
   *  the tie-break lifts signal-less messages to exactly the 0.6 render
   *  floor on the sole engaged record only. A message with a sibling
   *  address/price hit still routes to the sibling. */
  targetSoleEngaged?: boolean;
}

/** Messages at/above this confidence render in the record's thread. */
export const ATTRIBUTION_RENDER_FLOOR = 0.6;

export function mergeTimeline(
  quoMessages: QuoMessage[],
  gmailMessages: GmailMessage[],
  notesEntries: NotesEntry[],
  opts: MergeOptions
): { timeline: TimelineEntry[]; ambiguous: TimelineEntry[] } {
  const timeline: TimelineEntry[] = [];
  const ambiguous: TimelineEntry[] = [];
  const siblings = opts.siblings ?? [];
  const hasSiblings = siblings.length > 0;

  /** Apply the sole-engaged tie-break: only when no sibling claimed the
   *  message (no address/price hit ≥0.5) and the raw score is below the
   *  render floor. Never overrides a sibling win. */
  const withTieBreak = (match: { recordId: string; confidence: number }) => {
    if (
      opts.targetSoleEngaged &&
      match.confidence < ATTRIBUTION_RENDER_FLOOR &&
      (!match.recordId || match.recordId === opts.recordId)
    ) {
      return { recordId: opts.recordId, confidence: ATTRIBUTION_RENDER_FLOOR };
    }
    return match;
  };

  for (const msg of quoMessages) {
    const direction = msg.direction === "incoming" ? "in" as const : "out" as const;
    const match = hasSiblings
      ? withTieBreak(scorePropertyMatch(msg.body, opts.targetAddress, opts.targetPrices, siblings))
      : { recordId: opts.recordId, confidence: 1.0 };
    const entry: TimelineEntry = {
      timestamp: msg.createdAt, channel: "sms", direction, body: msg.body,
      sender: direction === "in" ? (opts.agentName ?? msg.from) : "Alex (AKB)",
      propertyMatch: { recordId: match.recordId || opts.recordId, confidence: hasSiblings ? match.confidence : 1.0 },
      raw: msg,
    };
    if (hasSiblings && match.confidence < 0.6) ambiguous.push(entry);
    timeline.push(entry);
  }

  for (const msg of gmailMessages) {
    const isInbound = !msg.from.toLowerCase().includes("alex") && !msg.from.toLowerCase().includes("akb");
    const direction = isInbound ? "in" as const : "out" as const;
    const match = hasSiblings
      ? withTieBreak(scorePropertyMatch(msg.body, opts.targetAddress, opts.targetPrices, siblings))
      : { recordId: opts.recordId, confidence: 1.0 };
    const entry: TimelineEntry = {
      timestamp: msg.date, channel: "email", direction, body: msg.body,
      subject: msg.subject,
      sender: isInbound ? (opts.agentName ?? msg.from) : "Alex (AKB)",
      propertyMatch: { recordId: match.recordId || opts.recordId, confidence: hasSiblings ? match.confidence : 1.0 },
      raw: msg,
    };
    if (hasSiblings && match.confidence < 0.6) ambiguous.push(entry);
    if (!isDuplicate({ body: msg.body, direction }, timeline)) timeline.push(entry);
  }

  for (let i = 0; i < notesEntries.length; i++) {
    const entry = notesEntries[i];
    if (entry.type === "system") {
      timeline.push({ timestamp: entry.timestamp ?? "", channel: "system", direction: "out", body: entry.text, sender: "System", propertyMatch: { recordId: opts.recordId, confidence: 1.0 } });
      continue;
    }
    const direction = entry.type === "inbound" ? "in" as const : "out" as const;
    const dup = findDuplicate({ body: entry.text, direction }, timeline);
    if (dup) {
      // The notes ledger is record-scoped truth: a captured copy on THIS
      // record proves the live message belongs here. Lift the live entry to
      // full confidence instead of just skipping the note — otherwise a
      // below-floor sibling-ambiguous quo/gmail copy survives the dedup and
      // then gets filtered out of the thread, vanishing the message.
      if (dup.propertyMatch.confidence < 1.0) {
        dup.propertyMatch = { recordId: opts.recordId, confidence: 1.0 };
      }
    } else {
      timeline.push({ timestamp: entry.timestamp ?? "", channel: "note", direction, body: entry.text, sender: entry.type === "inbound" ? (opts.agentName ?? "Agent") : "Alex (AKB)", propertyMatch: { recordId: opts.recordId, confidence: 1.0 } });
    }
  }

  timeline.sort((a, b) => {
    if (!a.timestamp && !b.timestamp) return 0;
    if (!a.timestamp) return -1;
    if (!b.timestamp) return 1;
    return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
  });

  return { timeline, ambiguous };
}

/** INV-010 — Pipeline stages where RESPONSE DUE is structurally
 *  inappropriate. A signed contract / closed deal / dead record can
 *  have an old inbound newer than the most recent outbound, but the
 *  alert "agent waiting on you" is wrong: the operator is waiting on
 *  title, on closing, on nothing. Suppress.
 *
 *  Negotiating / offer_drafted INTENTIONALLY stay open — an unanswered
 *  inbound at those stages IS operator-actionable. */
const RESPONSE_DUE_SUPPRESSED_STAGES: ReadonlySet<string> = new Set([
  "under_contract",
  "dispo_active",
  "assignment_signed",
  "closed",
  "dead",
]);

export function computeResponseStatus(
  timeline: TimelineEntry[],
  pipelineStage?: string | null,
): {
  lastInbound: string | null;
  lastOutbound: string | null;
  hoursSinceInbound: number | null;
  hoursSinceOutbound: number | null;
  responseDue: boolean;
  /** INV-010 — set when responseDue was suppressed by stage gate. Lets
   *  the UI distinguish "no inbound" from "inbound but past the
   *  engagement window" if a future surface wants to. */
  responseDueSuppressedByStage: boolean;
  lastInboundBody: string | null;
} {
  let lastInbound: string | null = null;
  let lastOutbound: string | null = null;
  let lastInboundBody: string | null = null;

  for (const entry of timeline) {
    if (entry.channel === "system") continue;
    if (entry.direction === "in" && entry.timestamp) {
      if (!lastInbound || new Date(entry.timestamp) > new Date(lastInbound)) {
        lastInbound = entry.timestamp;
        lastInboundBody = entry.body;
      }
    }
    if (entry.direction === "out" && entry.timestamp) {
      if (!lastOutbound || new Date(entry.timestamp) > new Date(lastOutbound)) lastOutbound = entry.timestamp;
    }
  }

  const now = Date.now();
  const hoursSinceInbound = lastInbound ? Math.floor((now - new Date(lastInbound).getTime()) / 3_600_000) : null;
  const hoursSinceOutbound = lastOutbound ? Math.floor((now - new Date(lastOutbound).getTime()) / 3_600_000) : null;
  const rawResponseDue =
    lastInbound !== null && (lastOutbound === null || new Date(lastInbound) > new Date(lastOutbound));

  // INV-010: stage-aware suppression. An old "thanks!" inbound on a
  // record at "under_contract" should not light up the operator's deal
  // page with "agent waiting on you" — the workflow has moved past the
  // reply-due window.
  const suppressed =
    rawResponseDue &&
    typeof pipelineStage === "string" &&
    RESPONSE_DUE_SUPPRESSED_STAGES.has(pipelineStage);

  return {
    lastInbound,
    lastOutbound,
    hoursSinceInbound,
    hoursSinceOutbound,
    responseDue: rawResponseDue && !suppressed,
    responseDueSuppressedByStage: suppressed,
    lastInboundBody,
  };
}
