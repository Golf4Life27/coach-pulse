// Phase 13 — Sentinel inbound classifier endpoint.
//
// GET  /api/sentinel/classify/[recordId][?apply_motivation=1]
// POST /api/sentinel/classify/[recordId]  body = { body?: string }
//
// N.1: classify the latest inbound from listing.notes (or an
// explicitly POSTed body), audit the result.
//
// N.2: optional `?apply_motivation=1` auto-writes the motivation
// score to Listings_V1.Seller_Motivation_Score per the v1.3 spec
// (Phase 20.2 added the field; Phase 13.4 closes the loop). The
// write is itself approval-gated by these conditions:
//   - intent ∈ {motivated, lukewarm}
//   - motivation_score_hint != null (1-5)
//   - existing Seller_Motivation_Score IS null (never stomp an
//     operator-set value — the operator's call always wins)
// When any condition fails, the score isn't written and the audit
// captures the skip reason.
//
// Phase 13 charter: no OUTBOUND action without explicit operator
// click. Writing motivation-score metadata IS NOT outbound; the
// reply-send path remains operator-only via /api/deal-action/[id].
//
// Read posture: pulls the latest inbound from the listing's notes
// field via lib/notes.lastInboundLine — same source of truth the
// jarvis-brief route uses for timeline context.

import { NextResponse } from "next/server";
import { getListing, updateListingRecord } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import { lastInboundLine, parseConversation } from "@/lib/notes";
import { classifyInboundReply } from "@/lib/sentinel/classifier";
import { decideMotivationApply } from "@/lib/sentinel/motivation-gate";
import type { SentinelClassification } from "@/lib/sentinel/types";

export const runtime = "nodejs";
export const maxDuration = 30;

type Ctx = { params: Promise<{ recordId: string }> };

async function readBodyOverride(req: Request): Promise<string | null> {
  if (req.method !== "POST") return null;
  try {
    const json = (await req.json().catch(() => null)) as
      | { body?: unknown }
      | null;
    if (json && typeof json.body === "string" && json.body.trim().length > 0) {
      return json.body;
    }
  } catch {
    /* fall through */
  }
  return null;
}

type MotivationApplyOutcome =
  | {
      applied: false;
      reason:
        | "not_requested"
        | "intent_not_motivated_or_lukewarm"
        | "no_hint"
        | "existing_score_set"
        | "write_error";
      existing: number | null;
      hint: number | null;
      error?: string;
    }
  | { applied: true; written_score: number; previous: number | null };

/** Wraps the pure decideMotivationApply gate with the actual write
 *  side-effect when it resolves to "apply". Errors are captured
 *  (never thrown) so the classify flow always returns. */
async function maybeApplyMotivation(
  apply: boolean,
  recordId: string,
  classification: SentinelClassification,
  existing: number | null,
): Promise<MotivationApplyOutcome> {
  const decision = decideMotivationApply({ apply, classification, existingScore: existing });
  if (decision.decision === "skip") {
    return {
      applied: false,
      reason: decision.reason,
      existing: decision.existing_score,
      hint: decision.hint,
    };
  }
  try {
    await updateListingRecord(recordId, {
      Seller_Motivation_Score: decision.score,
    });
    return { applied: true, written_score: decision.score, previous: null };
  } catch (err) {
    return {
      applied: false,
      reason: "write_error",
      existing,
      hint: decision.score,
      error: String(err).slice(0, 300),
    };
  }
}

async function handle(req: Request, ctx: Ctx): Promise<Response> {
  const t0 = Date.now();
  const { recordId } = await ctx.params;
  const url = new URL(req.url);
  const applyMotivation = url.searchParams.get("apply_motivation") === "1";

  const listing = await getListing(recordId);
  if (!listing) {
    return NextResponse.json({ error: `Listing ${recordId} not found` }, { status: 404 });
  }

  // Resolve the body to classify: explicit override via POST body wins,
  // otherwise parse the latest inbound out of the notes field.
  const override = await readBodyOverride(req);
  const body = override ?? lastInboundLine(listing.notes);
  if (!body || body.trim().length === 0) {
    return NextResponse.json(
      {
        recordId,
        error: "no_inbound_to_classify",
        detail:
          "Listing has no inbound message in notes. Send a POST with { body: '...' } to classify an explicit message.",
      },
      { status: 400 },
    );
  }

  // Build a tight timeline context — the LLM benefits from prior
  // turns to disambiguate short replies ("yes", "send it") from
  // fresh ones. Cap at the last 4 conversational entries to keep
  // the prompt compact.
  const entries = parseConversation(listing.notes);
  const recent = entries
    .slice(-5)
    .filter((e) => e.type === "inbound" || e.type === "outbound")
    .map(
      (e) => `[${e.type === "inbound" ? "agent" : "us"}] ${e.text.slice(0, 240)}`,
    );

  try {
    const classification = await classifyInboundReply({
      body,
      listing: {
        address: listing.address,
        list_price: listing.listPrice,
        state: listing.state,
      },
      agent: {
        name: listing.agentName,
      },
      recent_timeline_snippets: recent,
    });

    const motivation = await maybeApplyMotivation(
      applyMotivation,
      recordId,
      classification,
      listing.sellerMotivationScore ?? null,
    );

    await audit({
      agent: "sentinel",
      event: "sentinel_classified",
      status: "confirmed_success",
      recordId,
      inputSummary: {
        address: listing.address,
        agent_name: listing.agentName,
        body_length: body.length,
        body_source: override ? "explicit_post" : "latest_inbound_from_notes",
        apply_motivation: applyMotivation,
      },
      outputSummary: {
        intent: classification.intent,
        confidence: classification.confidence,
        red_flags: classification.red_flags,
        motivation_score_hint: classification.motivation_score_hint,
        reasoning: classification.reasoning,
        model: classification.model,
        motivation_apply: motivation,
      },
      decision: classification.intent,
      ms: Date.now() - t0,
    });

    // Separate audit row when motivation was successfully written —
    // makes Pulse's "Sentinel auto-scored X of Y inbounds this week"
    // baseline straightforward.
    if (motivation.applied) {
      await audit({
        agent: "sentinel",
        event: "sentinel_motivation_applied",
        status: "confirmed_success",
        recordId,
        inputSummary: {
          intent: classification.intent,
          confidence: classification.confidence,
        },
        outputSummary: {
          written_score: motivation.written_score,
          previous: motivation.previous,
        },
        decision: `score_${motivation.written_score}`,
        ms: Date.now() - t0,
      });
    }

    return NextResponse.json({
      recordId,
      body_source: override ? "explicit_post" : "latest_inbound_from_notes",
      classified_body: body,
      classification,
      motivation_apply: motivation,
      elapsed_ms: Date.now() - t0,
    });
  } catch (err) {
    await audit({
      agent: "sentinel",
      event: "sentinel_classified",
      status: "confirmed_failure",
      recordId,
      inputSummary: {
        address: listing.address,
        body_length: body.length,
      },
      outputSummary: {
        error: String(err).slice(0, 500),
      },
      decision: "error",
      ms: Date.now() - t0,
    });
    return NextResponse.json(
      { recordId, error: "classifier_failed", detail: String(err).slice(0, 500) },
      { status: 500 },
    );
  }
}

export async function GET(req: Request, ctx: Ctx) {
  return handle(req, ctx);
}

export async function POST(req: Request, ctx: Ctx) {
  return handle(req, ctx);
}
