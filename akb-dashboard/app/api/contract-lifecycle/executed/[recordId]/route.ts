// CONTRACT EXECUTED — the operator's one click that starts the back half.
// @agent: maverick (2026-09-05)
//
// POST /api/contract-lifecycle/executed/[recordId]
//   { contractPrice, executedAt?, assignmentPrice?, optionDays?, closeDays? }
//
// Writes Contract_Executed_At + every downstream clock (Option_Deadline,
// EMD_Due_At, Close_Date), Contract_Offer_Price, Assignment_Price — see
// lib/dispo/contract-lifecycle.ts for the math. The dispo-trigger cron
// (25,55 * * * *) then picks the record up and fires the buyer email blast;
// the option-tripwire cron watches the deadline. This route sends nothing.
//
// Auth: dashboard cookie / CRON_SECRET / OAuth waterfall (same as
// app/api/admin/audit-tail). It writes money fields, so never open.
// Refuses a Dead record and refuses to re-stamp a record already executed
// unless ?force=1 — re-running by accident would silently move every clock.

import { NextResponse } from "next/server";
import { getListing, updateListingRecord } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import { contractExecutedFields, type ContractExecutedInput } from "@/lib/dispo/contract-lifecycle";

export const runtime = "nodejs";
export const maxDuration = 30;

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function stamp(): string {
  return new Date().toLocaleDateString("en-US", {
    month: "numeric", day: "numeric", year: "2-digit", hour: "numeric", minute: "2-digit", hour12: true,
  });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ recordId: string }> },
) {
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

  const { recordId } = await params;
  if (!/^rec[A-Za-z0-9]{14}$/.test(recordId ?? "")) {
    return NextResponse.json({ error: "invalid_record_id", recordId }, { status: 400 });
  }

  let raw: Record<string, unknown>;
  try {
    raw = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const input: ContractExecutedInput = {
    contractPrice: num(raw.contractPrice),
    executedAt: typeof raw.executedAt === "string" ? raw.executedAt : null,
    assignmentPrice: num(raw.assignmentPrice),
    optionDays: num(raw.optionDays),
    closeDays: num(raw.closeDays),
  };
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === "number" && Number.isNaN(v)) {
      return NextResponse.json({ error: `invalid_${k}` }, { status: 400 });
    }
  }
  const computed = contractExecutedFields(input);
  if (!computed.ok) return NextResponse.json({ error: computed.error }, { status: 400 });

  const listing = await getListing(recordId, { fresh: true });
  if (!listing) return NextResponse.json({ error: "listing_not_found", recordId }, { status: 404 });
  if (listing.outreachStatus === "Dead") {
    return NextResponse.json({ error: "listing_is_dead", recordId }, { status: 409 });
  }
  const force = new URL(req.url).searchParams.get("force") === "1";
  if (listing.contractExecutedAt && !force) {
    return NextResponse.json(
      { error: "already_executed", recordId, contractExecutedAt: listing.contractExecutedAt, hint: "add ?force=1 to move the clocks" },
      { status: 409 },
    );
  }

  const noteLine = `${stamp()} — CONTRACT EXECUTED (${authKind}): ${computed.summary}. Dispo blast queues on the next :25/:55 cron.`;
  const existingNotes = listing.notes ?? "";
  const fields: Record<string, unknown> = {
    ...computed.fields,
    Verification_Notes: existingNotes ? `${existingNotes}\n${noteLine}` : noteLine,
  };
  if (listing.outreachStatus !== "Offer Accepted") fields.Outreach_Status = "Offer Accepted";

  try {
    const drift = await updateListingRecord(recordId, fields);
    await audit({
      agent: "maverick",
      event: "contract_executed_marked",
      status: "confirmed_success",
      recordId,
      inputSummary: { ...input, authKind, force },
      outputSummary: { ...computed.fields, drift: drift.length },
      ms: Date.now() - t0,
    });
    return NextResponse.json({
      ok: true,
      recordId,
      address: listing.address,
      fields: computed.fields,
      summary: computed.summary,
      drift,
      next: "dispo-trigger cron fires the buyer blast at :25/:55; option-tripwire watches the deadline daily.",
    });
  } catch (err) {
    await audit({
      agent: "maverick",
      event: "contract_executed_marked",
      status: "confirmed_failure",
      recordId,
      error: String(err),
      ms: Date.now() - t0,
    });
    return NextResponse.json({ error: "airtable_write_failed", detail: String(err) }, { status: 502 });
  }
}
