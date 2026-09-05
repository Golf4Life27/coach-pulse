// Option-deadline tripwire (operator 2026-09-05): "$1,000 EMD per contract,
// $3,000 cap — the only way a deposit is lost is missing a termination
// deadline." Runs at 5 13 * * * UTC (see vercel.json). For every listing
// whose option/inspection window is within 5 days, within 2 days, or
// already lapsed, this fires ONCE per (record, stage): writes an operator
// action item, texts the operator's personal phone, and audits the fire.
//
// Same auth waterfall + kill switch + KV dedupe shape as
// app/api/cron/morning-digest/route.ts. Every external call (Airtable
// write, SMS send) is wrapped so one candidate's failure never stops the
// loop over the rest.
//
// FAIL-CLOSED on phone: no OPERATOR_PERSONAL_PHONE → action item still
// gets written (Alex sees it in Queue/pipeline), SMS is just skipped.
// ?dry_run=1 reports the would-be fires with no writes and no sends.

import { NextResponse } from "next/server";
import { audit } from "@/lib/audit-log";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import { sendMessage } from "@/lib/quo";
import { getListings } from "@/lib/airtable";
import {
  composeTripwireSms,
  selectTripwireCandidates,
  tripwireKey,
  type TripwireCandidate,
} from "@/lib/dispo/option-tripwire";

export const runtime = "nodejs";
export const maxDuration = 60;

const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
const ACTION_ITEMS_TABLE = "tblZRunAe5OaMTRCM"; // Operator_Action_Items
const CLAIM_TTL_SECONDS = 30 * 86_400; // 30 days — a stage fires at most once in that window

interface FireResult {
  recordId: string;
  address: string;
  stage: string;
  daysLeft: number;
  sent: boolean;
  action_item_written: boolean;
  sms: string;
}

interface SkipResult {
  recordId: string;
  stage: string;
}

/** Writes one Operator_Action_Items row. Field names match the read side
 *  (lib/decision-feed-server.ts, app/api/operator-actions/route.ts):
 *  Title, Source_Record_Id, Action_Required, Context, Priority, Status,
 *  Created_At. The UI derives the /pipeline/<id> link from Source_Record_Id
 *  itself (lib/conveyor/model.ts), so no separate link field is written. */
async function writeActionItem(candidate: TripwireCandidate, sms: string, nowIso: string): Promise<boolean> {
  if (!AIRTABLE_PAT) return false;
  const { listing, stage, daysLeft } = candidate;
  const title =
    stage === "lapsed"
      ? `OPTION LAPSED: ${listing.address || listing.id}`
      : stage === "t2"
        ? `OPTION T-2: ${listing.address || listing.id}`
        : `OPTION T-5: ${listing.address || listing.id}`;
  try {
    const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${ACTION_ITEMS_TABLE}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AIRTABLE_PAT}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: {
          Title: title,
          Source_Record_Id: listing.id,
          Action_Required: "Decide: assign, extend, or terminate before the option deadline.",
          Context: sms,
          Priority: stage === "lapsed" || stage === "t2" ? "high" : "medium",
          Status: "open",
          Created_At: nowIso,
        },
        typecast: true,
      }),
    });
    return res.ok;
  } catch (err) {
    console.error("[option-tripwire] action item write failed:", listing.id, stage, daysLeft, err);
    return false;
  }
}

async function sendSms(phone: string, sms: string): Promise<boolean> {
  try {
    await sendMessage(phone, sms);
    return true;
  } catch (err) {
    console.error("[option-tripwire] SMS send failed:", err);
    return false;
  }
}

async function claimKey(key: string): Promise<boolean> {
  if (!kvConfigured()) return true; // no KV — never claim, always fire (best-effort dev/CI posture)
  try {
    return await kvProd.setNx(key, "1", CLAIM_TTL_SECONDS);
  } catch (err) {
    console.error("[option-tripwire] KV claim failed, treating as unclaimed:", key, err);
    return true;
  }
}

export async function GET(req: Request) {
  const t0 = Date.now();
  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dry_run") === "1";
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

  const nowIso = new Date().toISOString();
  const phone = (process.env.OPERATOR_PERSONAL_PHONE ?? "").trim() || null;

  let listings: Awaited<ReturnType<typeof getListings>> = [];
  try {
    listings = await getListings();
  } catch (err) {
    await audit({
      agent: "maverick",
      event: "option_tripwire_run",
      status: "confirmed_failure",
      inputSummary: { auth_kind: authKind, dry_run: dryRun },
      error: String(err).slice(0, 300),
      ms: Date.now() - t0,
    });
    return NextResponse.json({ error: "listings_read_failed", detail: String(err).slice(0, 200) }, { status: 502 });
  }

  const candidates = selectTripwireCandidates(listings, nowIso);

  const fired: FireResult[] = [];
  const skippedAlreadyClaimed: SkipResult[] = [];
  const candidateSummary = candidates.map((c) => ({
    recordId: c.listing.id,
    address: c.listing.address,
    stage: c.stage,
    daysLeft: c.daysLeft,
  }));

  for (const candidate of candidates) {
    const { listing, stage, daysLeft } = candidate;
    const key = tripwireKey(listing.id, stage);
    const sms = composeTripwireSms(listing, stage, daysLeft);

    if (dryRun) {
      fired.push({
        recordId: listing.id,
        address: listing.address,
        stage,
        daysLeft,
        sent: false,
        action_item_written: false,
        sms,
      });
      continue;
    }

    const claimed = await claimKey(key);
    if (!claimed) {
      skippedAlreadyClaimed.push({ recordId: listing.id, stage });
      continue;
    }

    const actionItemWritten = await writeActionItem(candidate, sms, nowIso);
    const sent = phone ? await sendSms(phone, sms) : false;

    await audit({
      agent: "maverick",
      event: "option_tripwire_fired",
      status: actionItemWritten || sent ? "confirmed_success" : "uncertain",
      recordId: listing.id,
      inputSummary: { stage, days_left: daysLeft },
      outputSummary: { sent, action_item_written: actionItemWritten, sms },
      ms: Date.now() - t0,
    }).catch((err) => console.error("[option-tripwire] audit write failed:", err));

    fired.push({
      recordId: listing.id,
      address: listing.address,
      stage,
      daysLeft,
      sent,
      action_item_written: actionItemWritten,
      sms,
    });
  }

  await audit({
    agent: "maverick",
    event: "option_tripwire_run",
    status: "confirmed_success",
    inputSummary: { auth_kind: authKind, dry_run: dryRun, phone_configured: phone != null },
    outputSummary: {
      scanned: listings.length,
      candidates: candidateSummary.length,
      fired: fired.length,
      skipped_already_claimed: skippedAlreadyClaimed.length,
    },
    ms: Date.now() - t0,
  }).catch((err) => console.error("[option-tripwire] audit write failed:", err));

  return NextResponse.json({
    ok: true,
    scanned: listings.length,
    candidates: candidateSummary,
    fired,
    skipped_already_claimed: skippedAlreadyClaimed,
    dry_run: dryRun,
    duration_ms: Date.now() - t0,
  });
}
