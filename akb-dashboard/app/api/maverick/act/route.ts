// Maverick Decision Card — redeem route.
// @agent: maverick
//
// The other half of the Decision Card channel: given a token and an option
// key, redeem the card and execute the PRE-DECLARED action that came with
// it. No auth beyond the token itself — the token IS the credential, the
// same trust model as a password-reset link. What keeps that safe is that
// the option key can only select among actions Maverick already wrote into
// the card at creation time (see lib/maverick/decision-card.ts); nothing
// the caller supplies here reaches HANDLERS except that pre-baked action.
//
// Execution reuses the SAME HANDLERS map the dashboard's own action buttons
// call, exported from app/api/actions/[type]/route.ts — one implementation
// of "what mark_dead does", not two that can drift apart. (It stays in that
// route file rather than a shared lib module because gate-integrity.test.ts
// source-scans app/api/**/route.ts for the Pre-EMD gate call around any
// Contract-Signed write — see the comment there.)

import { NextResponse } from "next/server";
import { audit } from "@/lib/audit-log";
import { redeemCard } from "@/lib/maverick/decision-card";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import { HANDLERS, EmdGateBlockedError } from "@/app/api/actions/[type]/route";

export const runtime = "nodejs";
export const maxDuration = 30;

interface ActBody {
  token?: unknown;
  optionKey?: unknown;
}

export async function POST(req: Request) {
  const t0 = Date.now();

  if (!kvConfigured()) {
    return NextResponse.json({ error: "kv_not_configured" }, { status: 503 });
  }

  let body: ActBody;
  try {
    body = (await req.json()) as ActBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (typeof body.token !== "string" || body.token.length === 0) {
    return NextResponse.json({ error: "token required" }, { status: 400 });
  }
  if (typeof body.optionKey !== "string" || body.optionKey.length === 0) {
    return NextResponse.json({ error: "optionKey required" }, { status: 400 });
  }

  const nowIso = new Date().toISOString();
  const result = await redeemCard(kvProd, body.token, body.optionKey, nowIso);

  if (!result.ok) {
    // Do NOT execute. The card refused the redemption — expired, already
    // used, unknown token, or an option key that doesn't exist on the
    // stored card. That last case is the security property in action: a
    // tampered or guessed key never reaches HANDLERS.
    return NextResponse.json({ ok: false, reason: result.reason }, { status: 409 });
  }

  const { option } = result;
  const handler = HANDLERS[option.action.type];
  if (!handler) {
    // The card was created with a type that was allowlisted at creation
    // time but has since been removed from HANDLERS (deploy drift). The
    // card is already spent — report the failure rather than silently
    // succeeding.
    await audit({
      agent: "maverick",
      event: "decision_card_redeemed",
      status: "confirmed_failure",
      inputSummary: { token: body.token, option_key: option.key, action_type: option.action.type },
      error: "handler_not_found",
      ms: Date.now() - t0,
    }).catch(() => {});
    return NextResponse.json({ ok: false, error: "handler_not_found" }, { status: 500 });
  }

  try {
    await handler(option.action);
  } catch (err) {
    // Redemption already happened — do NOT un-redeem. A half-executed retry
    // on a spent card is worse than a stuck one; the audit trail carries
    // what happened so the operator can fix it by hand.
    const detail = err instanceof EmdGateBlockedError ? err.decision.reason : String(err);
    await audit({
      agent: "maverick",
      event: "decision_card_redeemed",
      status: "confirmed_failure",
      inputSummary: { token: body.token, option_key: option.key, action_type: option.action.type },
      error: String(detail).slice(0, 300),
      ms: Date.now() - t0,
    }).catch(() => {});
    return NextResponse.json({ ok: false, error: "action_failed", detail: String(detail) }, { status: 500 });
  }

  // Safe to log the token here — it is now spent (redeemCard already
  // claimed it single-use), so logging it can't be used to redeem again.
  await audit({
    agent: "maverick",
    event: "decision_card_redeemed",
    status: "confirmed_success",
    inputSummary: { token: body.token, option_key: option.key, action_type: option.action.type },
    decision: "decision_card_redeemed",
    ms: Date.now() - t0,
  }).catch(() => {});

  return NextResponse.json({ ok: true, confirmation: option.confirmation });
}
