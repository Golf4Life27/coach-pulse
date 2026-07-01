// Evict specific H2 dispatch claims from KV (key `h2:dispatch:{recordId}`).
// @agent: sentry
//
// POST /api/admin/clear-dispatch-claim
//   body: { recordIds: string[], apply?: boolean }
//
// apply DEFAULTS FALSE — a delete only happens on explicit { "apply": true }.
// The dry path READS each claim's current value (the ISO stamp of when it was
// claimed) so the operator can confirm it's a stale/poison claim before
// evicting. This route ONLY ever touches keys under the fixed `h2:dispatch:`
// prefix — it cannot delete an arbitrary KV key.
//
// Why this exists: the h2-outreach send loop acquires the per-record KV claim
// BEFORE the pre-dispatch gates (hydration / >85%-of-list economics) and
// `continue`s on a gate block WITHOUT releasing the claim — so a blocked record
// is "poisoned" for the full 24h claim TTL and cannot send even after the block
// clears. Evicting the poison claim lets the record send on the next run.
// (Durable fix — acquire the claim AFTER the gates — is tracked separately.)
//
// Clearing a claim never sends anything: it only lets a FUTURE run re-attempt,
// which re-runs every gate. Provide only record IDs you've verified were not
// actually texted (a genuinely-sent record is no longer first_touch-eligible,
// so clearing its claim is a no-op anyway).
//
// Auth: the standard waterfall (OAuth mat_ / CRON_SECRET+x-vercel-cron /
// dev bearer) plus the same-origin dashboard cookie.

import { NextResponse } from "next/server";
import { audit } from "@/lib/audit-log";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";

export const runtime = "nodejs";
export const maxDuration = 60;

const CLAIM_PREFIX = "h2:dispatch:";
const RECORD_ID_RE = /^rec[A-Za-z0-9]{14}$/;

export async function POST(req: Request) {
  const t0 = Date.now();

  // ── Auth waterfall (+ dashboard cookie) ──────────────────────────
  const cookieHeader = req.headers.get("cookie");
  let authKind: "dashboard_session" | "oauth" | "cron" | "bearer_dev" | "none" = "none";
  if (hasDashboardSession(cookieHeader)) {
    authKind = "dashboard_session";
  } else {
    const env = readAuthEnv();
    const headers = readAuthHeaders(req);
    const authRequired = kvConfigured() || env.cronSecret !== null || env.bearerDevToken !== null;
    if (authRequired) {
      const auth = await authenticate(headers, env, kvProd);
      if (!auth.ok) {
        return NextResponse.json({ error: "unauthorized", reason: auth.reason }, { status: 401 });
      }
      authKind = auth.kind;
    }
  }

  // ── Params: apply defaults FALSE ─────────────────────────────────
  let body: { recordIds?: unknown; apply?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }
  const apply = body.apply === true;
  const recordIds = Array.isArray(body.recordIds)
    ? Array.from(
        new Set(body.recordIds.filter((x): x is string => typeof x === "string" && RECORD_ID_RE.test(x))),
      )
    : [];

  if (recordIds.length === 0) {
    return NextResponse.json(
      {
        error: "no_valid_record_ids",
        hint: "body.recordIds must be a non-empty array of Airtable record IDs (rec + 14 chars).",
      },
      { status: 400 },
    );
  }

  if (!kvConfigured()) {
    return NextResponse.json({ error: "kv_not_configured" }, { status: 503 });
  }

  // ── Inspect (and, when apply, delete) each claim ─────────────────
  const results: Array<{
    recordId: string;
    key: string;
    claimedAt: string | null;
    existed: boolean;
    cleared: boolean;
  }> = [];
  for (const recordId of recordIds) {
    const key = `${CLAIM_PREFIX}${recordId}`;
    const claimedAt = await kvProd.get(key).catch(() => null);
    const existed = claimedAt != null;
    let cleared = false;
    if (apply && existed) {
      const n = await kvProd.del(key).catch(() => 0);
      cleared = n > 0;
    }
    results.push({ recordId, key, claimedAt, existed, cleared });
  }

  const existedCount = results.filter((r) => r.existed).length;
  const clearedCount = results.filter((r) => r.cleared).length;

  await audit({
    agent: "sentry",
    event: apply ? "clear_dispatch_claim_apply" : "clear_dispatch_claim_dry_run",
    status: "confirmed_success",
    inputSummary: { auth_kind: authKind, apply, recordIds },
    outputSummary: { existedCount, clearedCount, results },
    decision: apply ? "claims_cleared" : "dry_run",
    ms: Date.now() - t0,
  });

  return NextResponse.json({
    mode: apply ? "apply" : "dry_run",
    elapsed_ms: Date.now() - t0,
    prefix: CLAIM_PREFIX,
    requested: recordIds.length,
    existedCount,
    clearedCount,
    results,
  });
}
