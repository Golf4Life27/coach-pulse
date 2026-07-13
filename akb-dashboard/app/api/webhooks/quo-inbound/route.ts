// M6 — Quo SMS inbound webhook (DARK SCAFFOLD). @agent: outreach
//
// Operator decision (M6): build the reliable capture by EXTENDING the existing
// poll path, AND scaffold this instant-webhook endpoint DARK (flag-off,
// unit-tested) for a later cutover — DO NOT activate it now. Activation =
// (1) operator re-points Quo's webhook here, (2) sets INBOUND_CAPTURE_LIVE=true.
//
// Posture until then: parse + plan + AUDIT, write NOTHING (watched-first). The
// pure plan (lib/inbound/capture.planInboundCapture) is what the unit tests
// exercise; this route is the thin executor.
//
// FAIL-CLOSED: an unparseable / outbound payload → 200 ack, no-op. A matched
// reply with no live listing → the Unmatched_Replies catch-all (never dropped).
// A transient write error → 500 so Quo retries; a parse no-op never retries.

import { NextResponse } from "next/server";
import { getActiveListingsForBrief, updateListingRecord } from "@/lib/airtable";
import { appendQuoMessagesToNotes } from "@/lib/outreach/quo-sync";
import { audit } from "@/lib/audit-log";
import { parseQuoWebhookPayload } from "@/lib/inbound/webhook-parse";
import { planInboundCapture } from "@/lib/inbound/capture";
import { isInboundCaptureLive } from "@/lib/inbound/flag";
import { createUnmatchedReply } from "@/lib/inbound/store";
import type { MatchableListing } from "@/lib/inbound/types";

export const runtime = "nodejs";
export const maxDuration = 30;

/** Shared-secret guard. When QUO_WEBHOOK_SECRET is set, the caller must
 *  present it (?secret= or x-webhook-secret). Unset ⇒ accept for PARSING
 *  only — live execution additionally requires the secret (see below). */
function secretOk(req: Request): boolean {
  const want = process.env.QUO_WEBHOOK_SECRET;
  if (!want) return true;
  const url = new URL(req.url);
  const got = req.headers.get("x-webhook-secret") ?? url.searchParams.get("secret") ?? "";
  return got === want;
}

async function handle(req: Request) {
  if (!secretOk(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // FAIL-CLOSED (Tier-2 hardening, 2026-07-13): INBOUND_CAPTURE_LIVE is
  // already true in prod (gmail-sync writes prove it), which armed this
  // endpoint to EXECUTE — status flips + notes writes — while the secret
  // guard above degrades to accept-all when QUO_WEBHOOK_SECRET is unset.
  // An unauthenticated caller could forge "inbound SMS" and poison records.
  // Live execution now refuses without a configured secret; watched mode
  // (parse + audit, zero writes) stays reachable for validation.
  if (isInboundCaptureLive() && !process.env.QUO_WEBHOOK_SECRET) {
    await audit({
      agent: "outreach",
      event: "inbound_webhook_misconfigured",
      status: "confirmed_failure",
      inputSummary: {},
      outputSummary: { reason: "live_without_secret" },
      error: "INBOUND_CAPTURE_LIVE=true but QUO_WEBHOOK_SECRET unset — refusing to execute (fail-closed). Set the secret and include it in the webhook URL.",
    });
    return NextResponse.json(
      { error: "misconfigured", reason: "live_capture_requires_webhook_secret" },
      { status: 503 },
    );
  }

  let payload: unknown = null;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ ok: true, ignored: "unparseable_body" });
  }

  const msg = parseQuoWebhookPayload(payload);
  if (!msg) return NextResponse.json({ ok: true, ignored: "not_inbound_or_malformed" });

  const live = isInboundCaptureLive();

  // Source population for matching. In WATCHED mode a population error is
  // non-fatal (we still ack); in LIVE mode it must 500 so Quo retries.
  let listings: MatchableListing[] = [];
  try {
    const rows = await getActiveListingsForBrief({ recentDays: 365, cacheKey: "quo-webhook:365d" });
    listings = rows.map((l) => ({
      id: l.id,
      agentPhone: (l as { agentPhone?: string | null }).agentPhone ?? null,
      agentEmail: (l as { agentEmail?: string | null }).agentEmail ?? null,
      outreachStatus: (l as { outreachStatus?: string | null }).outreachStatus ?? null,
    }));
  } catch (err) {
    if (live) return NextResponse.json({ ok: false, error: "population_fetch_failed", message: String(err) }, { status: 500 });
  }

  const plan = planInboundCapture(msg, listings);

  // WATCHED (default): audit the plan, write nothing.
  if (!live) {
    await audit({
      agent: "outreach",
      event: "inbound_webhook_watched",
      status: "uncertain",
      inputSummary: { channel: msg.channel, external_id: msg.externalId, sender: msg.sender },
      outputSummary: { plan: plan.kind, escalate: plan.kind === "matched" || plan.kind === "unmatched" ? plan.escalate : false },
      decision: "watched_no_write",
    });
    return NextResponse.json({ ok: true, watched: true, plan: plan.kind });
  }

  // LIVE: execute the plan.
  try {
    if (plan.kind === "ignored") {
      return NextResponse.json({ ok: true, plan: "ignored", reason: plan.reason });
    }
    if (plan.kind === "unmatched") {
      const r = await createUnmatchedReply(plan.fields);
      await audit({
        agent: "outreach",
        event: "inbound_unmatched_captured",
        status: "confirmed_success",
        inputSummary: { channel: msg.channel, sender: msg.sender },
        outputSummary: { record_id: r.recordId, created: r.created, classification: plan.triage.classification, escalate: plan.escalate },
        decision: "catch_all",
      });
      return NextResponse.json({ ok: true, plan: "unmatched", recordId: r.recordId, created: r.created });
    }
    // matched — append verbatim to the record's notes + advance status.
    const rows = await getActiveListingsForBrief({ recentDays: 365, cacheKey: "quo-webhook:365d" });
    const listing = rows.find((l) => l.id === plan.listingId);
    const append = appendQuoMessagesToNotes(
      (listing as { notes?: string | null } | undefined)?.notes ?? "",
      [{ id: msg.externalId, body: msg.body, createdAt: msg.receivedAt, direction: "incoming" }],
      { syncMarkerSource: "quo_webhook" },
    );
    const fields: Record<string, unknown> = { Last_Inbound_At: msg.receivedAt };
    if (append.newEvents.length > 0) fields.Verification_Notes = append.notes;
    if (plan.newStatus) fields.Outreach_Status = plan.newStatus;
    await updateListingRecord(plan.listingId, fields);
    await audit({
      agent: "outreach",
      event: "inbound_matched_captured",
      status: "confirmed_success",
      recordId: plan.listingId,
      inputSummary: { channel: msg.channel, sender: msg.sender },
      outputSummary: { classification: plan.triage.classification, new_status: plan.newStatus, escalate: plan.escalate, appended: append.newEvents.length },
      decision: plan.escalate ? "escalate" : "capture",
    });
    return NextResponse.json({ ok: true, plan: "matched", recordId: plan.listingId, newStatus: plan.newStatus });
  } catch (err) {
    // Transient write failure → 500 so Quo retries (we never want to lose a reply).
    await audit({
      agent: "outreach",
      event: "inbound_webhook_write_failed",
      status: "confirmed_failure",
      inputSummary: { channel: msg.channel, sender: msg.sender, plan: plan.kind },
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ ok: false, error: "write_failed", message: String(err) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  return handle(req);
}
