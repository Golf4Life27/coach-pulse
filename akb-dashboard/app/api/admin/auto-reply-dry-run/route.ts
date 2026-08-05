// Auto-answer dry run — read exactly what the lane would have said.
// @agent: crier
//
// GET /api/admin/auto-reply-dry-run
//   ?limit=N     records to replay (default 60, max 300)
//   ?only=sent   show only the ones it WOULD have answered
//
// WRITES NOTHING. EVER. There is no ?apply — this route cannot send, and the
// live path is a separate switch (REPLY_AUTO_ANSWER_LIVE). The operator asked
// to "read exactly what it would have sent before a single message goes live",
// and a dry run that can also fire is not a dry run.
//
// It replays every record carrying a genuine inbound through the SAME two pure
// functions the live path uses — reply-triage.triageSellerReply to classify,
// auto-answer.decideAutoAnswer to decide — and prints the composed body next
// to the seller's actual words. Refusals are shown too, with their reason:
// what the lane DECLINES to answer is the more important half of the review.
//
// Source of the inbound text: the persisted Verification_Notes tail, which is
// where scan-replies/scan-comms record the body. That is a REPLAY, not a live
// Quo pull — a thread that has moved on since will show its older inbound.
// Stated here because a dry run that quietly reads stale text would flatter
// itself.

import { NextResponse } from "next/server";
import { getListings } from "@/lib/airtable";
import { triageSellerReply } from "@/lib/reply-triage";
import { decideAutoAnswer, AUTO_ANSWER_LIVE } from "@/lib/reply-triage/auto-answer";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";

export const runtime = "nodejs";
export const maxDuration = 120;

/** Last inbound body recorded on the record. The reply paths append a line
 *  shaped `Inbound from <agent>: "<body>"` / `L3 INBOUND: <CLASS>. Body: ...`;
 *  we take the LAST match so an evolving thread replays its newest turn.
 *  Null when nothing parses — never guessed. */
function lastInboundBody(notes: string | null | undefined): string | null {
  if (!notes) return null;
  const quoted = [...notes.matchAll(/Inbound from [^:]+:\s*"([^"]+)"/g)];
  if (quoted.length > 0) return quoted[quoted.length - 1][1];
  const l3 = [...notes.matchAll(/L3(?:\s+INBOUND)?:\s*[A-Z_]+\.?\s*Body:\s*([^\n]+)/g)];
  if (l3.length > 0) return l3[l3.length - 1][1].trim();
  return null;
}

/** True when this thread already carries an auto-answer stamp. */
function alreadyAutoAnswered(notes: string | null | undefined): boolean {
  return Boolean(notes && notes.includes("[Auto-answer]"));
}

export async function GET(req: Request) {
  const t0 = Date.now();

  const cookieHeader = req.headers.get("cookie");
  let authKind = "none";
  if (hasDashboardSession(cookieHeader)) {
    authKind = "dashboard_session";
  } else {
    const env = readAuthEnv();
    const headers = readAuthHeaders(req);
    const authRequired = kvConfigured() || env.cronSecret !== null || env.bearerDevToken !== null;
    if (authRequired) {
      const auth = await authenticate(headers, env, kvProd);
      if (!auth.ok) return NextResponse.json({ error: "unauthorized", reason: auth.reason }, { status: 401 });
      authKind = auth.kind;
    }
  }

  const url = new URL(req.url);
  const onlySent = url.searchParams.get("only") === "sent";
  const rawLimit = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(300, Math.floor(rawLimit)) : 60;

  let listings;
  try {
    listings = await getListings({ includeLegacy: true });
  } catch (err) {
    return NextResponse.json(
      { error: "listings_fetch_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  const replied = listings.filter((l) => Boolean(l.lastInboundAt));
  const rows: Array<Record<string, unknown>> = [];
  const wouldAnswer = { seller_costs: 0, offer_format: 0 };
  const refusals: Record<string, number> = {};
  let unparseable = 0;

  for (const l of replied.slice(0, limit)) {
    const inbound = lastInboundBody(l.notes);
    if (!inbound) {
      unparseable++;
      continue;
    }
    const triage = triageSellerReply(inbound, l.outreachStatus ?? null);
    const decision = decideAutoAnswer({
      classification: triage.classification,
      inboundBody: inbound,
      stickyOfferUsd: l.outreachOfferPrice ?? l.roughOpenerAmount ?? null,
      street: l.address ?? null,
      alreadyAutoAnswered: alreadyAutoAnswered(l.notes),
      // Force the composer to run regardless of the env flag — the point of
      // this route is seeing the body. `send` is reported separately.
      live: true,
    });

    // `would_send` is what the LIVE lane would do; it is NOT this route
    // sending anything.
    const wouldSend = decision.send;
    if (wouldSend) {
      wouldAnswer[triage.classification as "seller_costs" | "offer_format"] += 1;
    } else if (decision.refusal) {
      refusals[decision.refusal] = (refusals[decision.refusal] ?? 0) + 1;
    }
    if (onlySent && !wouldSend) continue;

    rows.push({
      record_id: l.id,
      address: l.address,
      classification: triage.classification,
      seller_said: inbound.slice(0, 240),
      would_send: wouldSend,
      would_say: decision.body,
      refusal: decision.refusal,
      why: decision.detail,
      sticky_offer: l.outreachOfferPrice ?? l.roughOpenerAmount ?? null,
    });
  }

  const answered = wouldAnswer.seller_costs + wouldAnswer.offer_format;
  return NextResponse.json({
    ok: true,
    writes: "none — this route cannot send, and has no apply mode",
    lane_live: AUTO_ANSWER_LIVE,
    auth_kind: authKind,
    took_ms: Date.now() - t0,
    replayed: rows.length,
    threads_with_a_reply: replied.length,
    inbound_unparseable: unparseable,
    would_answer: { total: answered, ...wouldAnswer },
    would_refuse: refusals,
    note:
      "Replayed from the persisted notes tail, not a live Quo pull — a thread that moved on since shows its older inbound.",
    rows,
  });
}
