// Daily Death Rule sweep — P0-10 (operator approved 2026-09-24, spine
// recYbAYqkguZSOTeF). The rule itself is an operator ruling on the spine
// (2026-09-23, spine reclKuvb2ZlGTL09O): an UNSIGNED deal where the other
// side (seller/agent) has been silent 14+ days is Dead. Signed deals never
// die this way — an executed contract instead gets ONE operator card asking
// for a termination-notice decision.
//
// GET/POST /api/cron/death-rule
//   (no apply)   DRY RUN (the default). Reports what it WOULD do; writes
//                nothing. This is also what ?dry_run=1 means — it's the
//                same thing spelled out for the cron path below.
//   ?apply=1     actually write: kill via lib/pipeline/mark-dead's helper,
//                and upsert one termination-decision operator card per
//                executed-and-silent record. No sends of any kind either way.
//
// Ships live in vercel.json with ?dry_run=1 so the operator reviews the
// first real list before HQ flips it to ?apply=1.
//
// Auth: the standard shared write-route waterfall (dashboard cookie /
// CRON_SECRET / OAuth) — lib/security/write-route-auth.scan.test.ts fails
// CI on an unguarded write-capable route.

import { NextResponse } from "next/server";
import { requireSendAuth } from "@/lib/send-route-auth";
import { audit } from "@/lib/audit-log";
import { getListings } from "@/lib/airtable";
import type { Listing } from "@/lib/types";
import {
  classifyDeathRule,
  DEATH_RULE_SILENCE_MS,
  type DeathRuleResult,
} from "@/lib/pipeline/death-rule";
import { markRecordDead } from "@/lib/pipeline/mark-dead";
import { upsertOperatorActions, type OperatorAction } from "@/lib/maverick/operator-actions";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";

export const runtime = "nodejs";
export const maxDuration = 60;

const SPINE_REF = "operator ruling 2026-09-23, spine reclKuvb2ZlGTL09O";
// Termination-decision cards are a nudge to look, not a clock of their own —
// a week's visibility is plenty; the next daily sweep re-upserts the same id
// (idempotent) for as long as the record stays executed + silent.
const CARD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface RecordSummary {
  id: string;
  address: string;
  status: string | null;
  daysSilent: number | null;
}

function parseApply(req: Request): boolean {
  const url = new URL(req.url);
  return url.searchParams.get("apply") === "1";
}

function toDeathRuleInput(listing: Listing) {
  return {
    outreachStatus: listing.outreachStatus,
    lastInboundAt: listing.lastInboundAt,
    lastOutboundAt: listing.lastOutboundAt,
    lastOutreachDate: listing.lastOutreachDate,
    createdTime: listing.createdTime ?? null,
    contractExecutedAt: listing.contractExecutedAt ?? null,
  };
}

function buildTerminationCard(rec: RecordSummary, nowIso: string): OperatorAction {
  return {
    id: `termination-${rec.id}`,
    title: `Executed deal gone silent ${rec.daysSilent ?? "14+"}d — decide termination: ${rec.address}`,
    why:
      `Signed contract, but the counterparty's last message was ${rec.daysSilent ?? "14+"} days ago. ` +
      `Signed deals never auto-die (${SPINE_REF}) — this needs your call: send a termination notice, or re-engage.`,
    instructions: "Review the live thread, then either issue termination or follow up. No automated send fires from this card.",
    href: `/pipeline/${rec.id}`,
    revenueUsd: null,
    deadlineAt: null,
    expiresAt: new Date(new Date(nowIso).getTime() + CARD_TTL_MS).toISOString(),
    postedAt: nowIso,
    postedBy: "death-rule-cron",
  };
}

async function handle(req: Request) {
  const auth = await requireSendAuth(req);
  if (!auth.ok) return auth.response;

  const t0 = Date.now();
  const apply = parseApply(req);
  const now = new Date();
  const nowIso = now.toISOString();

  let listings: Listing[];
  try {
    listings = await getListings();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: "listings_fetch_failed", message }, { status: 500 });
  }

  const wouldKill: RecordSummary[] = [];
  const needsTermination: RecordSummary[] = [];
  let contactedLast14Days = 0;

  for (const listing of listings) {
    const result: DeathRuleResult = classifyDeathRule(toDeathRuleInput(listing), nowIso);
    const summary: RecordSummary = {
      id: listing.id,
      address: listing.address,
      status: listing.outreachStatus,
      daysSilent: result.daysSilent,
    };

    if (result.verdict === "dead") {
      wouldKill.push(summary);
    } else if (result.verdict === "executed_needs_termination_card") {
      needsTermination.push(summary);
    }

    if (listing.lastInboundAt) {
      const sinceInbound = now.getTime() - new Date(listing.lastInboundAt).getTime();
      if (Number.isFinite(sinceInbound) && sinceInbound >= 0 && sinceInbound < DEATH_RULE_SILENCE_MS) {
        contactedLast14Days++;
      }
    }
  }

  let killed = 0;
  let killFailed = 0;
  let cardsUpserted = 0;

  if (apply) {
    const byId = new Map(listings.map((l) => [l.id, l] as const));

    for (const rec of wouldKill) {
      const listing = byId.get(rec.id);
      const outcome = await markRecordDead(
        rec.id,
        `${rec.daysSilent}+ days of counterparty silence on Last_Inbound_At (${SPINE_REF})`,
        { record: listing ? { notes: listing.notes, contractExecutedAt: listing.contractExecutedAt ?? null } : null, now },
      );
      if (outcome.ok) killed++;
      else killFailed++;
    }

    if (needsTermination.length > 0 && kvConfigured()) {
      const cards = needsTermination.map((rec) => buildTerminationCard(rec, nowIso));
      const res = await upsertOperatorActions(kvProd, cards);
      cardsUpserted = res.total ?? cards.length;
    }
  }

  const summary = {
    apply,
    population: listings.length,
    would_kill: wouldKill.length,
    killed,
    kill_failed: killFailed,
    executed_needs_termination_card: needsTermination.length,
    termination_cards_upserted: cardsUpserted,
    counterparty_contact_last_14_days: contactedLast14Days,
  };

  await audit({
    agent: "orchestrator",
    event: "death_rule_sweep",
    status: killFailed > 0 ? "uncertain" : "confirmed_success",
    inputSummary: { apply, auth_kind: auth.authKind, population: listings.length },
    outputSummary: summary,
    decision: apply ? "applied" : "dry_run",
    ms: Date.now() - t0,
  });

  return NextResponse.json({
    ok: true,
    ...summary,
    would_kill_records: wouldKill,
    executed_needs_termination_records: needsTermination,
    generated_at: nowIso,
    duration_ms: Date.now() - t0,
  });
}

export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}
