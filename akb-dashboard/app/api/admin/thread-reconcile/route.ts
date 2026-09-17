// ADMIN THREAD RECONCILE — writes hand-sent Quo outbound ids into
// Verification_Notes so the send gate (lib/outreach/thread-truth.ts,
// unrecorded_outbound_in_thread) can pass again (2026-09-17).
//
// WHY: the send gate is right to refuse — an operator manual text from the
// Quo app never ingests into notes, and per INVARIANTS "Send discipline"
// rule 1 the live thread outranks record notes, always. But recovering from
// a refusal by hand means retyping a Verification_Notes field that can run
// past 35k characters byte-exact, which is not a thing a chat session can
// do reliably. This route does the same job the operator would do by hand
// — copy the missing Quo message ids into the notes, verbatim, from the
// live thread — over the app's own Quo credentials, server-side.
//
// GET /api/admin/thread-reconcile?to=+1XXXXXXXXXX&record_id=rec...
//   default   DRY-RUN: report the unrecorded outbound messages, write nothing.
//   ?apply=1  prepend one reconcile block covering all of them (idempotent —
//             a second apply run finds count 0).
//
// Reuses thread-tail's thread read (lib/quo getMessagesForParticipant, same
// 30-day tail) and thread-truth's id parsing; the only new code is the pure
// block-builder in lib/outreach/thread-reconcile.ts.
//
// Auth waterfall matches app/api/admin/thread-tail/route.ts exactly.

import { NextResponse } from "next/server";
import { getListing, updateListingRecord } from "@/lib/airtable";
import { getMessagesForParticipant, type QuoMessage } from "@/lib/quo";
import { buildReconcileBlock, prependReconcileBlock } from "@/lib/outreach/thread-reconcile";
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

// Same 30-day tail thread-tail reads / the send-gate's thread-truth check
// uses (lib/outreach/send-gate.ts THREAD_TAIL_MINUTES).
const THREAD_TAIL_MINUTES = 30 * 24 * 60;
const TAIL_LIMIT = 50;

const E164_US_RE = /^\+1\d{10}$/;

export async function GET(req: Request) {
  const t0 = Date.now();

  // ── Auth waterfall — mirrors app/api/admin/thread-tail/route.ts.
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
  const apply = url.searchParams.get("apply") === "1";

  if (!to || !E164_US_RE.test(to)) {
    return NextResponse.json({ ok: false, error: "to required, E.164 +1XXXXXXXXXX" }, { status: 400 });
  }
  if (!recordId || !recordId.startsWith("rec")) {
    return NextResponse.json({ ok: false, error: "record_id required, must start with 'rec'" }, { status: 400 });
  }

  const toLast4 = to.slice(-4);

  try {
    const listing = await getListing(recordId);
    if (!listing) {
      return NextResponse.json({ ok: false, error: "listing not found", record_id: recordId }, { status: 404 });
    }

    const thread: QuoMessage[] = await getMessagesForParticipant(to, THREAD_TAIL_MINUTES);
    const newestFirst = [...thread].sort((a, b) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? ""));
    const tail = newestFirst.slice(0, TAIL_LIMIT);

    const now = new Date();
    const { unrecorded, block } = buildReconcileBlock(tail, listing.notes, now);
    const count = unrecorded.length;

    await audit({
      agent: "outreach",
      event: "thread_reconcile",
      status: "confirmed_success",
      recordId,
      inputSummary: { record_id: recordId, to_last4: toLast4, apply, count },
      ms: Date.now() - t0,
    });

    if (!apply) {
      return NextResponse.json({
        ok: true,
        record_id: recordId,
        to_last4: toLast4,
        unrecorded: unrecorded.map((m) => ({ id: m.id, createdAt: m.createdAt, body_preview: m.body.slice(0, 80) })),
        count,
      });
    }

    if (count === 0) {
      return NextResponse.json({ ok: true, applied: false, appended: 0 });
    }

    const nextNotes = prependReconcileBlock(block, listing.notes);
    await updateListingRecord(recordId, { Verification_Notes: nextNotes });

    return NextResponse.json({ ok: true, applied: true, appended: count, ids: unrecorded.map((m) => m.id) });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[thread-reconcile] failed:", error);
    await audit({
      agent: "outreach",
      event: "thread_reconcile",
      status: "confirmed_failure",
      recordId,
      inputSummary: { record_id: recordId, to_last4: toLast4, apply },
      error,
      ms: Date.now() - t0,
    }).catch(() => {});
    return NextResponse.json({ ok: false, error }, { status: 502 });
  }
}
