// Phase 13 / N.2 — Sentinel reply drafter endpoint.
//
// GET  /api/sentinel/draft/[recordId]   → classify the latest inbound,
//                                         then compose drafts in one
//                                         round-trip.
// POST /api/sentinel/draft/[recordId]   → body = { body?, classification? }
//                                         use an explicit classification
//                                         (no re-classify) or override body.
//
// **Approval-gated:** Returns a SentinelDraftPackage. Drafts are
// proposals only — sending requires an explicit operator click via
// the existing /api/deal-action/[id] path. Phase 13 charter: no
// outbound action without explicit click.

import { NextResponse } from "next/server";
import { getListing } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import { lastInboundLine, parseConversation } from "@/lib/notes";
import { classifyInboundReply } from "@/lib/sentinel/classifier";
import { draftRepliesFor } from "@/lib/sentinel/drafter";
import type { SentinelClassification } from "@/lib/sentinel/types";

export const runtime = "nodejs";
// Two Anthropic calls back-to-back (classify + draft). 60s is generous.
export const maxDuration = 60;

type Ctx = { params: Promise<{ recordId: string }> };

interface PostBody {
  body?: unknown;
  classification?: unknown;
}

async function readPost(req: Request): Promise<PostBody> {
  if (req.method !== "POST") return {};
  try {
    const json = (await req.json().catch(() => null)) as PostBody | null;
    return json ?? {};
  } catch {
    return {};
  }
}

async function handle(req: Request, ctx: Ctx): Promise<Response> {
  const t0 = Date.now();
  const { recordId } = await ctx.params;
  const post = await readPost(req);

  const listing = await getListing(recordId);
  if (!listing) {
    return NextResponse.json({ error: `Listing ${recordId} not found` }, { status: 404 });
  }

  const overrideBody =
    typeof post.body === "string" && post.body.trim().length > 0 ? post.body : null;
  const body = overrideBody ?? lastInboundLine(listing.notes);
  if (!body || body.trim().length === 0) {
    return NextResponse.json(
      {
        recordId,
        error: "no_inbound_to_draft",
        detail:
          "Listing has no inbound message in notes. POST { body: '...' } to draft against an explicit message.",
      },
      { status: 400 },
    );
  }

  const entries = parseConversation(listing.notes);
  const recent = entries
    .slice(-5)
    .filter((e) => e.type === "inbound" || e.type === "outbound")
    .map(
      (e) => `[${e.type === "inbound" ? "agent" : "us"}] ${e.text.slice(0, 240)}`,
    );

  const classifierInput = {
    body,
    listing: {
      address: listing.address,
      list_price: listing.listPrice,
      state: listing.state,
    },
    agent: { name: listing.agentName },
    recent_timeline_snippets: recent,
  };

  try {
    // Step 1: classification — from POST override or fresh classifier call.
    let classification: SentinelClassification;
    const explicitClassification = post.classification;
    if (
      explicitClassification &&
      typeof explicitClassification === "object" &&
      typeof (explicitClassification as { intent?: unknown }).intent === "string"
    ) {
      classification = explicitClassification as SentinelClassification;
    } else {
      classification = await classifyInboundReply(classifierInput);
    }

    // Step 2: draft package — short-circuits to empty for alert-only
    // intents (wire-fraud / off-topic / spam) without an LLM call.
    const pkg = await draftRepliesFor(classifierInput, classification);

    await audit({
      agent: "sentinel",
      event: "sentinel_drafted",
      status: "confirmed_success",
      recordId,
      inputSummary: {
        address: listing.address,
        intent: classification.intent,
        confidence: classification.confidence,
        body_length: body.length,
      },
      outputSummary: {
        draft_count: pkg.drafts.length,
        options: pkg.drafts.map((d) => d.option),
        recommended_index: pkg.recommended_index,
        model: pkg.model,
      },
      decision: pkg.drafts.length === 0 ? "alert_only" : "drafts_proposed",
      ms: Date.now() - t0,
    });

    return NextResponse.json({
      recordId,
      body_source: overrideBody ? "explicit_post" : "latest_inbound_from_notes",
      classified_body: body,
      draft_package: pkg,
      elapsed_ms: Date.now() - t0,
    });
  } catch (err) {
    await audit({
      agent: "sentinel",
      event: "sentinel_drafted",
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
      { recordId, error: "drafter_failed", detail: String(err).slice(0, 500) },
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
