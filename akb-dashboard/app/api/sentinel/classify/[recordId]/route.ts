// Phase 13 / N.1 — Sentinel inbound classifier endpoint.
//
// GET  /api/sentinel/classify/[recordId]           → classify the latest
//                                                    inbound from the
//                                                    listing's notes
// POST /api/sentinel/classify/[recordId]           → body = { body?: string }
//                                                    classify an explicitly-
//                                                    supplied body (lets the
//                                                    backfill / approval queue
//                                                    re-classify older inbounds
//                                                    without re-reading notes)
//
// **Approval-gated:** This endpoint produces a classification result
// and writes an audit log entry. It does NOT mutate the listing
// (Seller_Motivation_Score, Outreach_Status, etc.) and does NOT
// auto-send any reply. N.2 layers the draft generator + Seller_
// Motivation_Score wiring; N.3 ships the Sentinel-room approval
// queue UI. Phase 13 charter: no outbound action without explicit
// operator click.
//
// Read posture: pulls the latest inbound from the listing's notes
// field via lib/notes.lastInboundLine — same source of truth the
// jarvis-brief route uses for timeline context. This is the parsed-
// notes path, not a direct Quo API call. Direct Quo can come later
// if the operator needs scan-time fidelity beyond what Make scrapes.

import { NextResponse } from "next/server";
import { getListing } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import { lastInboundLine, parseConversation } from "@/lib/notes";
import { classifyInboundReply } from "@/lib/sentinel/classifier";

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

async function handle(req: Request, ctx: Ctx): Promise<Response> {
  const t0 = Date.now();
  const { recordId } = await ctx.params;

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
      },
      outputSummary: {
        intent: classification.intent,
        confidence: classification.confidence,
        red_flags: classification.red_flags,
        motivation_score_hint: classification.motivation_score_hint,
        reasoning: classification.reasoning,
        model: classification.model,
      },
      decision: classification.intent,
      ms: Date.now() - t0,
    });

    return NextResponse.json({
      recordId,
      body_source: override ? "explicit_post" : "latest_inbound_from_notes",
      classified_body: body,
      classification,
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
