// ADMIN THREAD TAIL — read-only Quo thread tail for one phone number,
// using the app's own Quo credentials (2026-09-17).
//
// WHY: the Quo MCP connector has been returning Unauthorized all day, so a
// Claude session composing a reply has no way to read the live thread
// before answering. INVARIANTS "Send discipline" rule 1 requires exactly
// that read before any send: "the live thread outranks record notes —
// always... pull the live thread tail for that number in the same turn
// and read it before sending." This route is that read, exposed over the
// app's own working Quo credentials instead of the dead connector.
//
// READ-ONLY. It never calls sendMessage / sendMessageWithId / sendGuarded.
// It reuses the exact thread-fetch helper the send-gate's thread-truth check
// already calls (lib/quo.ts getMessagesForParticipant) — no new HTTP client.
//
// GET /api/admin/thread-tail?to=+1XXXXXXXXXX
// GET /api/admin/thread-tail?to=+1XXXXXXXXXX&limit=20
// GET /api/admin/thread-tail?to=+1XXXXXXXXXX&record_id=rec...
//
// Auth waterfall matches app/api/admin/photo-backfill/route.ts exactly.

import { NextResponse } from "next/server";
import { getListing } from "@/lib/airtable";
import { getMessagesForParticipant, type QuoMessage } from "@/lib/quo";
import { parseKnownQuoIds, countUnrecordedOutbound } from "@/lib/outreach/thread-truth";
import { audit } from "@/lib/audit-log";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";

export const runtime = "nodejs";
export const maxDuration = 30;

// Same 30-day tail the send-gate's thread-truth check reads (lib/outreach/
// send-gate.ts THREAD_TAIL_MINUTES) — wide enough to catch any manual send,
// capped at 300 messages by lib/quo pagination.
const THREAD_TAIL_MINUTES = 30 * 24 * 60;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

// The agent-facing outreach line (docs/system/SYSTEM_FACTS.md — carrier
// registered, backs QUO_PHONE_ID's default "PNLosBI6fh"). Not a secret: a
// dialable number, reported here only for context, never the credential
// that authenticates to Quo.
const OUTREACH_LINE_E164 = "+18155569965";

const E164_US_RE = /^\+1\d{10}$/;

function parseLimit(raw: string | null): number {
  if (!raw) return DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

export async function GET(req: Request) {
  const t0 = Date.now();

  // ── Auth waterfall — mirrors app/api/admin/photo-backfill/route.ts.
  const cookieHeader = req.headers.get("cookie");
  if (!hasDashboardSession(cookieHeader)) {
    const env = readAuthEnv();
    const headers = readAuthHeaders(req);
    const authRequired = kvConfigured() || env.cronSecret !== null || env.bearerDevToken !== null;
    if (authRequired) {
      const auth = await authenticate(headers, env, kvProd);
      if (!auth.ok) return NextResponse.json({ error: "unauthorized", reason: auth.reason }, { status: 401 });
    }
  }

  const url = new URL(req.url);
  const to = url.searchParams.get("to");
  const recordId = url.searchParams.get("record_id");
  const limit = parseLimit(url.searchParams.get("limit"));

  if (!to || !E164_US_RE.test(to)) {
    return NextResponse.json(
      { ok: false, error: "to required, E.164 +1XXXXXXXXXX" },
      { status: 400 },
    );
  }
  if (recordId && !recordId.startsWith("rec")) {
    return NextResponse.json(
      { ok: false, error: "record_id must start with 'rec'" },
      { status: 400 },
    );
  }

  const toLast4 = to.slice(-4);

  try {
    let knownQuoIds: Set<string> | null = null;
    if (recordId) {
      const listing = await getListing(recordId);
      if (!listing) {
        return NextResponse.json({ ok: false, error: "listing not found", recordId }, { status: 404 });
      }
      knownQuoIds = parseKnownQuoIds(listing.notes);
    }

    const thread: QuoMessage[] = await getMessagesForParticipant(to, THREAD_TAIL_MINUTES);

    const unrecordedOutboundCount = knownQuoIds ? countUnrecordedOutbound(thread, knownQuoIds) : undefined;

    const newestFirst = [...thread].sort((a, b) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? ""));
    const tail = newestFirst.slice(0, limit);

    const messages = tail.map((m) => ({
      id: m.id,
      direction: m.direction,
      createdAt: m.createdAt,
      body: m.body,
    }));

    await audit({
      agent: "crier",
      event: "thread_tail_read",
      status: "confirmed_success",
      recordId: recordId ?? undefined,
      inputSummary: { to_last4: toLast4, limit },
      outputSummary: { count: messages.length, unrecorded_outbound_count: unrecordedOutboundCount ?? null },
      ms: Date.now() - t0,
    });

    return NextResponse.json({
      ok: true,
      to,
      inbox: OUTREACH_LINE_E164,
      count: messages.length,
      messages,
      ...(knownQuoIds ? { known_quo_ids: Array.from(knownQuoIds) } : {}),
      ...(unrecordedOutboundCount !== undefined ? { unrecorded_outbound_count: unrecordedOutboundCount } : {}),
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[thread-tail] fetch failed:", err);
    await audit({
      agent: "crier",
      event: "thread_tail_read",
      status: "confirmed_failure",
      recordId: recordId ?? undefined,
      inputSummary: { to_last4: toLast4, limit },
      error,
      ms: Date.now() - t0,
    }).catch(() => {});
    return NextResponse.json({ ok: false, error }, { status: 502 });
  }
}
