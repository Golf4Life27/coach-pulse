// Reply-triage backfill — recover the classifications that were computed
// and discarded. @agent: sentinel
//
// GET /api/admin/reply-triage-backfill
//   → DRY-RUN by default. Finds records with a Last_Inbound_At but no
//     Reply_Classification, re-pulls the live Quo thread, re-runs the SAME
//     lib/reply-triage classifier the live paths use, and reports what it
//     WOULD write. Writes nothing.
//   ?apply=1  → persists the triple.
//   ?limit=N  → records to process this run (default 40, hard max 150).
//
// WHY A BACKFILL IS POSSIBLE AT ALL: the labels are gone from Airtable, but
// the raw reply BODIES still live in Quo. Re-running the classifier over the
// original text reproduces exactly what the live path would have written —
// this is a recovery, not a re-interpretation.
//
// PACING: one Quo thread fetch per record, sequential. The limit is the
// brake; re-run until missing_total reaches 0. Deliberately NOT a cron —
// this is a one-shot repair, and a standing cron over a closed hole is the
// paid-call bleed the 2026-07-27 sweep cap exists to prevent.

import { NextResponse } from "next/server";
import { getListings, updateListingRecord } from "@/lib/airtable";
import { getMessagesForParticipant } from "@/lib/quo";
import { isSelfEchoOrAutoreply } from "@/lib/conversation-check";
import { triageSellerReply } from "@/lib/reply-triage";
import { buildReplyClassificationFields } from "@/lib/inbound/reply-classification";
import { audit } from "@/lib/audit-log";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";

export const runtime = "nodejs";
export const maxDuration = 300;

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 150;
// Stop starting new Quo fetches this late so in-flight writes land cleanly.
const WALL_CLOCK_BUDGET_MS = 270_000;

interface Row {
  record_id: string;
  address: string | null;
  classification: string | null;
  decision_kind: string | null;
  inbound_at: string | null;
  written: boolean;
  skipped: string | null;
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
  const apply = url.searchParams.get("apply") === "1";
  const rawLimit = Number(url.searchParams.get("limit"));
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(MAX_LIMIT, Math.floor(rawLimit)) : DEFAULT_LIMIT;

  let listings;
  try {
    listings = await getListings({ includeLegacy: true });
  } catch (err) {
    return NextResponse.json(
      { error: "listings_fetch_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  // The work-list: got a reply, has no persisted classification, and we still
  // know which number to re-read.
  const missing = listings.filter(
    (l) => Boolean(l.lastInboundAt) && !l.replyClassification && Boolean(l.agentPhone),
  );
  const unreachable = listings.filter(
    (l) => Boolean(l.lastInboundAt) && !l.replyClassification && !l.agentPhone,
  ).length;

  const batch = missing.slice(0, limit);
  const rows: Row[] = [];
  const errors: string[] = [];
  let written = 0;
  let truncatedForTime = false;

  for (const l of batch) {
    if (Date.now() - t0 > WALL_CLOCK_BUDGET_MS) {
      truncatedForTime = true;
      break;
    }
    try {
      const messages = await getMessagesForParticipant(l.agentPhone as string);
      // Newest genuine inbound — the same selection the live paths make.
      const inbound = [...messages]
        .filter((m) => m.direction === "incoming" && !isSelfEchoOrAutoreply(m.body))
        .sort((a, b) => Date.parse(b.createdAt || "") - Date.parse(a.createdAt || ""))[0];

      if (!inbound) {
        rows.push({
          record_id: l.id,
          address: l.address ?? null,
          classification: null,
          decision_kind: null,
          inbound_at: null,
          written: false,
          // Last_Inbound_At is set but Quo shows no genuine inbound on this
          // number now. Report it — do NOT invent a classification.
          skipped: "no_genuine_inbound_in_quo_thread",
        });
        continue;
      }

      const triage = triageSellerReply(inbound.body, l.outreachStatus ?? null);
      const fields = buildReplyClassificationFields(triage, inbound.createdAt);

      let didWrite = false;
      if (apply) {
        await updateListingRecord(l.id, fields);
        didWrite = true;
        written += 1;
      }
      rows.push({
        record_id: l.id,
        address: l.address ?? null,
        classification: triage.classification,
        decision_kind: triage.decisionKind,
        inbound_at: inbound.createdAt || null,
        written: didWrite,
        skipped: null,
      });
    } catch (err) {
      errors.push(`${l.address ?? l.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const byClassification: Record<string, number> = {};
  for (const r of rows) {
    if (!r.classification) continue;
    byClassification[r.classification] = (byClassification[r.classification] ?? 0) + 1;
  }

  if (apply && written > 0) {
    await audit({
      agent: "sentinel",
      event: "reply_triage_backfill",
      status: "confirmed_success",
      decision: `backfilled ${written} reply classifications (${missing.length - written} still missing)`,
      outputSummary: { written, remaining: missing.length - written, by_classification: byClassification },
      ms: Date.now() - t0,
    }).catch(() => {});
  }

  return NextResponse.json({
    ok: true,
    mode: apply ? "apply" : "dry_run",
    auth_kind: authKind,
    took_ms: Date.now() - t0,
    missing_total: missing.length,
    unreachable_no_agent_phone: unreachable,
    processed: rows.length,
    written,
    remaining_after_run: missing.length - written,
    truncated_for_time: truncatedForTime,
    by_classification: byClassification,
    errors: errors.slice(0, 20),
    rows,
  });
}
