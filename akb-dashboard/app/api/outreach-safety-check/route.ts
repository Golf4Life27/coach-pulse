import { NextResponse } from "next/server";
import { getListing } from "@/lib/airtable";
import type { AgentContext, SafetyCheckResult, SafetyCheckReason } from "@/types/jarvis";

export const runtime = "nodejs";
export const maxDuration = 30;

const COOLDOWN_DAYS = 7;
const REINTRODUCTION_PATTERN = /this is alex with akb solutions/i;

interface SafetyCheckInput {
  recordId: string;
  channel: "sms" | "email" | "none";
  body: string;
  agentIdentifier?: string;
}

function originFromReq(req: Request): string {
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}

async function fetchAgentContext(origin: string, identifier: string, cookie: string | null): Promise<AgentContext | null> {
  try {
    const headers: Record<string, string> = {};
    if (cookie) headers.cookie = cookie;
    const res = await fetch(`${origin}/api/agent-context/${encodeURIComponent(identifier)}`, { headers, cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as AgentContext | { error: string };
    if ("error" in data) return null;
    return data;
  } catch {
    return null;
  }
}

function fail(
  reason: SafetyCheckReason,
  warning: string,
  agentContext: AgentContext,
  suggestedDraft?: string,
): SafetyCheckResult {
  return {
    passed: false,
    reason,
    warnings: [warning],
    agentContext,
    suggestedDraft,
  };
}

export async function POST(req: Request) {
  let input: SafetyCheckInput;
  try {
    input = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { recordId, channel, body } = input;
  if (!recordId || typeof recordId !== "string") {
    return NextResponse.json({ error: "Missing recordId" }, { status: 400 });
  }
  if (!channel || (channel !== "sms" && channel !== "email" && channel !== "none")) {
    return NextResponse.json({ error: "Invalid channel" }, { status: 400 });
  }
  if (typeof body !== "string") {
    return NextResponse.json({ error: "Missing body" }, { status: 400 });
  }

  // Resolve identifier: explicit agentIdentifier wins, else pull from listing.
  const listing = await getListing(recordId);
  if (!listing) {
    return NextResponse.json({ error: "Listing not found", recordId }, { status: 404 });
  }

  const identifier = input.agentIdentifier
    ?? listing.agentPhone
    ?? listing.agentEmail
    ?? null;

  // No identifier means we can't safety-check by relationship; fall through as passed.
  if (!identifier) {
    const stub: AgentContext = {
      identifier: "",
      agentName: listing.agentName ?? "Agent",
      totalListings: 0,
      totalOutreaches: 0,
      totalReplies: 0,
      lastInteractionAt: null,
      daysSinceLastInteraction: null,
      activeProperties: [],
      propertiesWithUnansweredInbound: [],
      depthScore: 0,
      inferredTone: "transactional",
    };
    const result: SafetyCheckResult = { passed: true, warnings: [], agentContext: stub };
    return NextResponse.json(result);
  }

  const origin = originFromReq(req);
  const cookie = req.headers.get("cookie");
  const ac = await fetchAgentContext(origin, identifier, cookie);

  if (!ac) {
    // If we can't get agent context, don't block — the upstream call may have
    // failed because the identifier is novel. Pass through with a warning.
    const stub: AgentContext = {
      identifier,
      agentName: listing.agentName ?? "Agent",
      totalListings: 0,
      totalOutreaches: 0,
      totalReplies: 0,
      lastInteractionAt: null,
      daysSinceLastInteraction: null,
      activeProperties: [],
      propertiesWithUnansweredInbound: [],
      depthScore: 0,
      inferredTone: "transactional",
    };
    const result: SafetyCheckResult = {
      passed: true,
      warnings: ["Could not load agent context — proceeding without relationship checks."],
      agentContext: stub,
    };
    return NextResponse.json(result);
  }

  // Check 3 — Unanswered inbound (highest priority).
  const otherUnanswered = ac.propertiesWithUnansweredInbound.filter((p) => p.recordId !== recordId);
  if (otherUnanswered.length > 0) {
    const first = otherUnanswered[0];
    const result = fail(
      "unanswered_inbound",
      `${ac.agentName} hasn't been responded to on ${first.address}${otherUnanswered.length > 1 ? ` (and ${otherUnanswered.length - 1} more)` : ""}. Respond there before contacting about a new property.`,
      ac,
    );
    return NextResponse.json(result, { status: 200 });
  }

  // Check 1 — Cooldown (7 days). Skip cooldown if we're replying TO this listing
  // — i.e. the inbound is on this very record (responseDue).
  if (ac.daysSinceLastInteraction !== null && ac.daysSinceLastInteraction < COOLDOWN_DAYS) {
    const otherActive = ac.activeProperties.find((p) => p.recordId !== recordId);
    if (otherActive) {
      const result = fail(
        "cooldown",
        `You contacted ${ac.agentName} ${ac.daysSinceLastInteraction}d ago about ${otherActive.address}. Consider holding off or referencing it.`,
        ac,
      );
      return NextResponse.json(result, { status: 200 });
    }
  }

  // Check 2 — Reintroduction on a record that already had outreach.
  if (listing.lastOutreachDate && REINTRODUCTION_PATTERN.test(body)) {
    const suggested = body.replace(REINTRODUCTION_PATTERN, "").replace(/^[\s,.-]+/, "").replace(/^Hi [^,]+,?\s*/i, (m) => m);
    const result = fail(
      "reintroduction_detected",
      `This record has prior outreach (${listing.lastOutreachDate}). Drop "this is Alex with AKB Solutions" — the agent already knows you.`,
      ac,
      suggested.trim(),
    );
    return NextResponse.json(result, { status: 200 });
  }

  // Check 4 — Tone match: depth >= 2 but body still has the cold intro.
  if (ac.depthScore >= 2 && REINTRODUCTION_PATTERN.test(body)) {
    const suggested = body.replace(REINTRODUCTION_PATTERN, "").replace(/^[\s,.-]+/, "").replace(/^Hi [^,]+,?\s*/i, (m) => m);
    const result = fail(
      "tone_mismatch",
      `${ac.agentName} is ${ac.depthScore === 2 ? "engaged" : "a known relationship"} — never re-introduce yourself. Drop the "this is Alex with AKB Solutions" line.`,
      ac,
      suggested.trim(),
    );
    return NextResponse.json(result, { status: 200 });
  }

  // Check 6 — Pre-offer screen on first outreach. If listing has no prior
  // outreach (lastOutreachDate empty) AND no pre-offer-screen has run, we
  // block until the operator runs the screen. This is the Ford St guard.
  const isFirstOutreach = !listing.lastOutreachDate || (ac.totalOutreaches === 0);
  if (isFirstOutreach && !listing.preOfferScreenAt) {
    const result: SafetyCheckResult = {
      passed: false,
      reason: "cooldown",
      warnings: [
        `Pre-offer screen has not run on ${listing.address}. Run /api/pre-offer-screen first or this outreach may fire on a property with hidden flags (fire damage, negative spread, distress mismatch).`,
      ],
      agentContext: ac,
    };
    return NextResponse.json(result, { status: 200 });
  }

  // Check 7 — Pre-offer screen prior result was Block.
  if (listing.preOfferScreenResult === "Block") {
    const result: SafetyCheckResult = {
      passed: false,
      reason: "cooldown",
      warnings: [
        `Pre-offer screen flagged BLOCKERS on ${listing.address}: ${(listing.preOfferScreenNotes ?? "").split("\n").filter((l) => l.startsWith("BLOCK:")).join(" / ")}. Resolve before contacting.`,
      ],
      agentContext: ac,
    };
    return NextResponse.json(result, { status: 200 });
  }

  const result: SafetyCheckResult = { passed: true, warnings: [], agentContext: ac };
  return NextResponse.json(result);
}
