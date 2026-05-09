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

interface SiblingRecord {
  recordId: string;
  address: string;
  listPrice: number | null;
}

function scorePropertyMatch(
  messageBody: string,
  targetAddress: string,
  targetPrice: number | null,
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

  if (targetPrice) {
    const priceMatches = messageBody.match(/\$[\d,]+/g) ?? [];
    for (const pm of priceMatches) {
      const val = parseInt(pm.replace(/[$,]/g, ""), 10);
      if (!isNaN(val) && Math.abs(val - targetPrice) <= 1000) { targetScore += 0.3; break; }
    }
  }

  let bestSibling = { recordId: "", confidence: 0 };
  for (const sib of siblings) {
    let sibScore = 0;
    const sibTokens = sib.address.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    const sibHits = sibTokens.filter((t) => bodyLower.includes(t)).length;
    if (sibTokens.length > 0 && sibHits >= Math.ceil(sibTokens.length * 0.5)) sibScore += 0.6;
    if (sib.listPrice) {
      const priceMatches = messageBody.match(/\$[\d,]+/g) ?? [];
      for (const pm of priceMatches) {
        const val = parseInt(pm.replace(/[$,]/g, ""), 10);
        if (!isNaN(val) && Math.abs(val - sib.listPrice) <= 1000) { sibScore += 0.3; break; }
      }
    }
    if (sibScore > bestSibling.confidence) bestSibling = { recordId: sib.recordId, confidence: sibScore };
  }

  if (bestSibling.confidence > targetScore && bestSibling.confidence >= 0.5) return bestSibling;
  return { recordId: "", confidence: targetScore };
}

function isDuplicate(entry: { body: string; direction: string }, existing: TimelineEntry[]): boolean {
  if (entry.body.length < 10) return false;
  const snippet = entry.body.slice(0, 40).toLowerCase();
  const dir = entry.direction === "in" ? "in" : "out";
  return existing.some((e) => e.direction === dir && e.body.toLowerCase().includes(snippet));
}

export interface MergeOptions {
  recordId: string;
  targetAddress: string;
  targetPrice: number | null;
  agentName: string | null;
  siblings?: SiblingRecord[];
}

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

  for (const msg of quoMessages) {
    const direction = msg.direction === "incoming" ? "in" as const : "out" as const;
    const match = hasSiblings
      ? scorePropertyMatch(msg.body, opts.targetAddress, opts.targetPrice, siblings)
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
      ? scorePropertyMatch(msg.body, opts.targetAddress, opts.targetPrice, siblings)
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
    if (!isDuplicate({ body: entry.text, direction }, timeline)) {
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

export function computeResponseStatus(timeline: TimelineEntry[]): {
  lastInbound: string | null;
  lastOutbound: string | null;
  hoursSinceInbound: number | null;
  hoursSinceOutbound: number | null;
  responseDue: boolean;
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
  const responseDue = lastInbound !== null && (lastOutbound === null || new Date(lastInbound) > new Date(lastOutbound));

  return { lastInbound, lastOutbound, hoursSinceInbound, hoursSinceOutbound, responseDue, lastInboundBody };
}
