// BUYER INTAKE — the one unauthenticated WRITE path in the app.
//
// POST here from app/buyer-intake and from the public deal page
// (app/d/[recordId]). It creates or updates a Buyer record and sends two
// emails, so anyone on the internet can move Airtable state and Alex's inbox
// through it. Hardened 2026-09-12, in this order:
//
//   1. 8 KB body cap, checked on the raw text BEFORE JSON.parse — a 5 MB body
//      should not be parsed just to be rejected.
//   2. Honeypot: a hidden `website` field both forms render. Filled means bot;
//      answer 200 and write NOTHING, so the stuffer gets no signal to adapt to.
//   3. Field validation + caps (lib/buyers/intake-validate.ts), fail-closed.
//   4. Per-IP rate limit in KV: one submission per 2 minutes, 10 per day.
//      Skipped entirely when KV is not configured (dev/CI) — the limiter is a
//      brake on abuse, not a gate on correctness, so a KV outage must not
//      close the form to real buyers. Both of those are deliberate.

import { NextResponse } from "next/server";
import { findBuyerByEmail, createBuyerV2, updateBuyerV2, BUYER_V2_FIELDS } from "@/lib/buyers-v2";
import { sendEmail, type GmailSendResult } from "@/lib/gmail";
import { audit } from "@/lib/audit-log";
import {
  INTAKE_MAX_BODY_BYTES,
  isHoneypotFilled,
  validateIntakeBody,
} from "@/lib/buyers/intake-validate";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";

export const runtime = "nodejs";
export const maxDuration = 30;

const BURST_TTL_SECONDS = 120;
const DAILY_CAP = 10;
const DAY_TTL_SECONDS = 86_400;

/** First x-forwarded-for entry, else x-real-ip, else "unknown" (a shared
 *  bucket — deliberately: an unidentifiable caller gets the tightest limit). */
function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

type RateVerdict = "ok" | "burst" | "daily" | "skipped";

/** setNx is the burst lock (atomic, strongly consistent); incrBy + expire is
 *  the daily counter (KvClient has both — see lib/maverick/oauth/kv.ts). */
async function checkRateLimit(ip: string, nowIso: string): Promise<RateVerdict> {
  if (!kvConfigured()) return "skipped";
  try {
    const acquired = await kvProd.setNx(`intake:ip:${ip}`, nowIso, BURST_TTL_SECONDS);
    if (!acquired) return "burst";
    const dayKey = `intake:ip:${ip}:${nowIso.slice(0, 10)}`;
    const count = await kvProd.incrBy(dayKey, 1);
    if (count === 1) await kvProd.expire(dayKey, DAY_TTL_SECONDS);
    return count > DAILY_CAP ? "daily" : "ok";
  } catch (err) {
    // Fail OPEN, loudly. A KV blip must not silently close the buyer form.
    console.error("[buyers/intake] rate-limit check failed:", String(err).slice(0, 200));
    return "skipped";
  }
}

export async function POST(req: Request) {
  const ip = clientIp(req);

  // ── 1. Size cap on the raw text, before any parsing. ──
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  if (raw.length > INTAKE_MAX_BODY_BYTES) {
    await audit({
      agent: "scout",
      event: "buyer_intake_oversized",
      status: "confirmed_failure",
      inputSummary: { ip, bytes: raw.length, cap: INTAKE_MAX_BODY_BYTES },
    }).catch(() => {});
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // ── 2. Honeypot: look like success, do nothing. ──
  if (isHoneypotFilled(body)) {
    await audit({
      agent: "scout",
      event: "buyer_intake_honeypot",
      status: "confirmed_success",
      inputSummary: { ip },
      outputSummary: { dropped: true },
      decision: "silent_drop",
    }).catch(() => {});
    return NextResponse.json({ ok: true });
  }

  // ── 3. Validation + caps. ──
  const validated = validateIntakeBody(body);
  if (!validated.ok) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }
  const input = validated.value;

  // ── 4. Per-IP rate limit (after validation so a typo does not burn a slot). ──
  const nowIso = new Date().toISOString();
  const verdict = await checkRateLimit(ip, nowIso);
  if (verdict === "burst" || verdict === "daily") {
    await audit({
      agent: "scout",
      event: "buyer_intake_rate_limited",
      status: "confirmed_failure",
      inputSummary: { ip, window: verdict === "burst" ? `${BURST_TTL_SECONDS}s` : "1d", email: input.email },
    }).catch(() => {});
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const fields: Record<string, unknown> = {
    [BUYER_V2_FIELDS.Name]: input.name,
    [BUYER_V2_FIELDS.Email]: input.email,
    [BUYER_V2_FIELDS.Entity]: input.entity,
    [BUYER_V2_FIELDS.Phone_Primary]: input.phone,
    [BUYER_V2_FIELDS.Markets]: input.markets,
    [BUYER_V2_FIELDS.Target_ZIPs]: input.targetZips,
    [BUYER_V2_FIELDS.Min_Price]: input.minPrice,
    [BUYER_V2_FIELDS.Max_Price]: input.maxPrice,
    [BUYER_V2_FIELDS.Min_Beds]: input.minBeds,
    [BUYER_V2_FIELDS.Property_Type_Preference]: input.propertyTypePreference,
    [BUYER_V2_FIELDS.Buyer_Type]: input.buyerType ?? "unknown",
    [BUYER_V2_FIELDS.Linked_Deal_Count]: input.volumePerYear,
    [BUYER_V2_FIELDS.Source]: "Inbound Form",
    [BUYER_V2_FIELDS.Status]: "Form Completed",
    [BUYER_V2_FIELDS.Form_Completed_At]: nowIso,
    [BUYER_V2_FIELDS.Last_Engagement_At]: nowIso,
    [BUYER_V2_FIELDS.Notes]: input.notes,
  };

  let buyerId: string;
  try {
    const existing = await findBuyerByEmail(input.email);
    if (existing) {
      await updateBuyerV2(existing.id, fields);
      buyerId = existing.id;
    } else {
      buyerId = await createBuyerV2(fields);
    }
  } catch (err) {
    console.error("[buyers/intake] Airtable error:", err);
    return NextResponse.json({ error: "Failed to save", detail: String(err) }, { status: 502 });
  }

  // Confirmation email + Alex notification — both best-effort. The
  // buyer record is what we're committing to in this endpoint; emails
  // are a side effect. But "best-effort" doesn't mean "invisible" —
  // sendEmail now audit-logs its own result with three-state status,
  // and we surface email_status to the caller so Make.com / form
  // backend can see what actually happened. Per the Positive
  // Confirmation Principle: 2xx is not the whole truth.
  //
  // Pattern note (5/13): replaces void sendEmail(...).catch(() => {})
  // which discarded the result entirely — exactly the swallow pattern
  // the principle exists to catch. Side-effect failures stay
  // non-fatal but become observable.
  async function safeSend(opts: Parameters<typeof sendEmail>[0]): Promise<GmailSendResult> {
    try {
      return await sendEmail(opts);
    } catch (err) {
      return {
        success: false,
        audit_status: "confirmed_failure",
        error: `sendEmail threw: ${String(err)}`,
      };
    }
  }

  const buyerEmailResult = await safeSend({
    to: input.email,
    subject: "Thanks — you're on the AKB buyer list",
    body: `Hi ${input.name.split(" ")[0] || "there"},\n\nThanks for filling out the AKB buyer form. We'll send deals matching your criteria as they come up.\n\n— Alex / AKB Solutions / (815) 556-9965`,
  });

  const alexEmail = process.env.ALEX_NOTIFY_EMAIL;
  const alexEmailResult: GmailSendResult | null = alexEmail
    ? await safeSend({
        to: alexEmail,
        subject: `New buyer intake: ${input.name}`,
        body: `Buyer: ${input.name} <${input.email}>\nEntity: ${input.entity ?? "—"}\nMarkets: ${(input.markets ?? []).join(", ") || "—"}\nMin/Max: $${input.minPrice ?? "?"} – $${input.maxPrice ?? "?"}\nBuyer type: ${input.buyerType ?? "?"}\nNotes: ${input.notes ?? "—"}\n\nReview: /buyers (id ${buyerId})`,
      })
    : null;

  return NextResponse.json({
    success: true,
    buyerId,
    email_status: {
      buyer_confirmation: buyerEmailResult.audit_status,
      buyer_confirmation_error: buyerEmailResult.error ?? buyerEmailResult.verifyError ?? null,
      alex_notification: alexEmailResult?.audit_status ?? "skipped",
      alex_notification_error: alexEmailResult?.error ?? alexEmailResult?.verifyError ?? null,
    },
  });
}
