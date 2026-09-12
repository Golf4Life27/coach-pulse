// Accepted-offer silence watchdog — cron route. @agent: maverick
//
// Runs at 0 15 * * * UTC (10am CT, see vercel.json). For every listing sitting
// at Offer Accepted with NO executed contract and no contact in either
// direction for silence_hours (default 48), this pages the operator with a
// Decision Card: nudge, re-open terms, or walk — one tap each.
//
// WHY IT EXISTS (1102 Montrose Ave): accepted 9/1 at $55,750, the agent chased
// 9/3, Maverick sent a holding reply, and then nine days passed. No text ever
// reached the operator, because every other alert lane in this system is
// event-driven and SILENCE IS NOT AN EVENT. The most valuable state in the
// funnel — a yes, unexecuted — was the only state with no watchdog.
//
// Shape is deliberately identical to app/api/cron/option-tripwire and
// contract-watch: auth waterfall + dashboard cookie, MAVERICK_CRON_ENABLED kill
// switch on the cron path, ?dry_run=1 for a no-writes preview, KV setNx dedupe,
// and a per-run cap. Detection and composition are pure and live in
// lib/maverick/accepted-silence; the paging is lib/maverick/operator-page.
//
// TWO GATES BEFORE THE PHONE RINGS:
//  - Chicago decency window (lib/escalation insideChicagoWindow) — outside it
//    the run reports outside_window and pages nobody.
//  - One page per record per UTC day (KV, 36h TTL). A stalled deal is still
//    stalled tomorrow; it should not ring twice today.

import { NextResponse } from "next/server";
import { audit } from "@/lib/audit-log";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import { getListings } from "@/lib/airtable";
import { insideChicagoWindow, readEscalationConfig } from "@/lib/escalation";
import { pageOperatorWithCard } from "@/lib/maverick/operator-page";
import {
  acceptedSilenceKey,
  composeAcceptedSilenceCard,
  composeAcceptedSilenceHeadline,
  findSilentAcceptedOffers,
  type SilentAcceptedOffer,
} from "@/lib/maverick/accepted-silence";

export const runtime = "nodejs";
export const maxDuration = 60;

/** 36h: longer than the one-UTC-day bucket it guards, so a run near midnight
 *  cannot re-page the same record twice within a few hours. */
const CLAIM_TTL_SECONDS = 36 * 3600;
const DEFAULT_SILENCE_HOURS = 48;

interface PageResult {
  recordId: string;
  address: string;
  silentHours: number;
  acceptedPrice: number | null;
  sent: boolean;
  reason: string | null;
  card_url_present: boolean;
  sms: string;
}

/** Best-effort claim, exactly like option-tripwire/contract-watch: with no KV
 *  configured (bare local dev / CI) there is nothing to dedupe against, so the
 *  candidate is treated as unclaimed rather than silently dropped. */
async function claim(key: string): Promise<boolean> {
  if (!kvConfigured()) return true;
  try {
    return await kvProd.setNx(key, "1", CLAIM_TTL_SECONDS);
  } catch (err) {
    console.error("[accepted-silence] KV claim failed, treating as unclaimed:", key, err);
    return true;
  }
}

export async function GET(req: Request) {
  const t0 = Date.now();
  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dry_run") === "1";
  const silenceHoursRaw = Number(url.searchParams.get("silence_hours"));
  const silenceHours =
    Number.isFinite(silenceHoursRaw) && silenceHoursRaw > 0 ? silenceHoursRaw : DEFAULT_SILENCE_HOURS;

  // ── Auth waterfall (+ dashboard cookie) ──────────────────────────────────
  const cookieHeader = req.headers.get("cookie");
  let authKind = "none";
  if (hasDashboardSession(cookieHeader)) authKind = "dashboard_session";
  else {
    const env = readAuthEnv();
    const headers = readAuthHeaders(req);
    const authRequired = kvConfigured() || env.cronSecret !== null || env.bearerDevToken !== null;
    if (authRequired) {
      const auth = await authenticate(headers, env, kvProd);
      if (!auth.ok) return NextResponse.json({ error: "unauthorized", reason: auth.reason }, { status: 401 });
      authKind = auth.kind;
    }
  }
  if (authKind === "cron" && process.env.MAVERICK_CRON_ENABLED !== "true") {
    return NextResponse.json({ error: "cron_disabled" }, { status: 503 });
  }

  const now = new Date();
  const cfg = readEscalationConfig();

  // ── Decency window. Outside it, nothing pages — this is the operator's own
  // phone, and a stalled deal at 3am is still stalled at 10am.
  if (!insideChicagoWindow(now, cfg)) {
    return NextResponse.json({
      ok: true,
      outcome: "outside_window",
      window: { startHour: cfg.windowStartHour, endHour: cfg.windowEndHour, tz: "America/Chicago" },
      dry_run: dryRun,
      duration_ms: Date.now() - t0,
    });
  }

  let listings: Awaited<ReturnType<typeof getListings>> = [];
  try {
    listings = await getListings();
  } catch (err) {
    await audit({
      agent: "maverick",
      event: "accepted_silence_run",
      status: "confirmed_failure",
      inputSummary: { auth_kind: authKind, dry_run: dryRun, silence_hours: silenceHours },
      error: String(err).slice(0, 300),
      ms: Date.now() - t0,
    }).catch(() => {});
    return NextResponse.json({ error: "listings_read_failed", detail: String(err).slice(0, 200) }, { status: 502 });
  }

  const scan = findSilentAcceptedOffers(listings, now, { silenceHours });
  const dayBucket = now.toISOString().slice(0, 10);
  const todayIso = dayBucket;

  const paged: PageResult[] = [];
  const skippedAlreadyClaimed: Array<{ recordId: string; address: string }> = [];
  const skippedCapped: Array<{ recordId: string; address: string }> = [];

  const summarize = (i: SilentAcceptedOffer) => ({
    recordId: i.recordId,
    address: i.address,
    silentHours: i.silentHours,
    acceptedPrice: i.acceptedPrice,
    lastTouchIso: i.lastTouchIso,
    lastOutboundAt: i.lastOutboundAt,
    lastInboundAt: i.lastInboundAt,
  });

  for (const item of scan.due) {
    const sms = composeAcceptedSilenceHeadline(item, now);

    // Oldest silence is first, so the cap trims the least-rotten tail.
    if (paged.length >= cfg.maxPerRun) {
      skippedCapped.push({ recordId: item.recordId, address: item.address });
      continue;
    }

    if (dryRun) {
      paged.push({
        recordId: item.recordId,
        address: item.address,
        silentHours: item.silentHours,
        acceptedPrice: item.acceptedPrice,
        sent: false,
        reason: "dry_run",
        card_url_present: false,
        sms,
      });
      continue;
    }

    if (!(await claim(acceptedSilenceKey(dayBucket, item.recordId)))) {
      skippedAlreadyClaimed.push({ recordId: item.recordId, address: item.address });
      continue;
    }

    const card = composeAcceptedSilenceCard(item, todayIso);
    const res = await pageOperatorWithCard({
      title: card.title,
      context: card.context,
      options: card.options,
      ttlHours: 48,
      sms: { headline: sms, reason: "Tap to nudge, re-open terms, or walk." },
      audit: { agent: "maverick", event: "accepted_silence_paged", recordId: item.recordId },
    });

    paged.push({
      recordId: item.recordId,
      address: item.address,
      silentHours: item.silentHours,
      acceptedPrice: item.acceptedPrice,
      sent: res.sent,
      reason: res.reason,
      card_url_present: res.cardUrl !== null,
      // The HEADLINE, not res.body: the body carries the card URL, and that
      // token is a bearer credential (see lib/maverick/decision-card). It
      // belongs in the SMS and the audit row, not echoed back over HTTP.
      sms,
    });
  }

  const counts = {
    candidates: scan.due.length + scan.unmeasurable.length + scan.held.length,
    due: scan.due.length,
    unmeasurable: scan.unmeasurable.length,
    held: scan.held.length,
    paged: paged.filter((p) => p.sent).length,
    skipped_already_claimed: skippedAlreadyClaimed.length,
    dry_run: dryRun,
  };

  await audit({
    agent: "maverick",
    event: "accepted_silence_run",
    status: "confirmed_success",
    inputSummary: { auth_kind: authKind, silence_hours: silenceHours, max_per_run: cfg.maxPerRun },
    outputSummary: { ...counts, scanned: listings.length, skipped_capped: skippedCapped.length },
    ms: Date.now() - t0,
  }).catch((err) => console.error("[accepted-silence] audit write failed:", err));

  return NextResponse.json({
    ok: true,
    ...counts,
    scanned: listings.length,
    items: {
      due: scan.due.map(summarize),
      unmeasurable: scan.unmeasurable,
      held: scan.held,
    },
    pages: paged,
    skipped_already_claimed: skippedAlreadyClaimed,
    skipped_capped: skippedCapped,
    duration_ms: Date.now() - t0,
  });
}
