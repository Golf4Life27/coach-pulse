// Dispo-driven buyer-criteria write-back (adjudication recXJrM7EYK3pEFmF
// item 3). @agent: dispo
//
// POST /api/buyers/dispo-feedback/[buyerId]
//
// Buyer-margin data is DISPO-DRIVEN, not cold-collected: when a buyer
// responds to a deal blast (counters a price, passes with a reason,
// states criteria, sends POF), the operator persists what the buyer
// REVEALED here. Each Tier B cycle converts provisional margins into
// sourced ones — this is the only path that fills Min_Deal_Spread, the
// Tier-C autonomous margin source.
//
// Body (all optional except at least one):
//   {
//     minDealSpread?: number,          // dollars — the buyer's stated spread
//     minAssignmentFeeTarget?: number, // dollars
//     maxRehab?: number,               // dollars
//     preferredCondition?: string[],   // select option names
//     pofReceived?: boolean,           // flips Proof_of_Funds_On_File
//     pofExpiryDate?: string,          // ISO date
//     sourceNote: string               // REQUIRED — what the buyer said,
//                                      // verbatim or summarized; this is
//                                      // the provenance line. A margin
//                                      // without its source quote is a
//                                      // fabrication waiting to happen.
//   }
//
// Boundary law: Scenario G stays READ-ONLY from G_Safe_View. This route
// is a separate inbound path; nothing here exposes internal pricing to
// buyers — it records what THEY said.
//
// Auth: dashboard cookie / CRON_SECRET / OAuth waterfall (same as every
// guarded route).

import { NextResponse } from "next/server";
import { getBuyerV2, updateBuyerV2, BUYER_V2_FIELDS } from "@/lib/buyers-v2";
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

interface FeedbackBody {
  minDealSpread?: number;
  minAssignmentFeeTarget?: number;
  maxRehab?: number;
  preferredCondition?: string[];
  pofReceived?: boolean;
  pofExpiryDate?: string;
  sourceNote: string;
}

function posNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ buyerId: string }> },
) {
  const t0 = Date.now();
  const { buyerId } = await params;
  if (!buyerId || !buyerId.startsWith("rec")) {
    return NextResponse.json({ error: "invalid_buyer_id" }, { status: 400 });
  }

  // ── Auth waterfall ──────────────────────────────────────────────
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

  let body: FeedbackBody;
  try {
    body = (await req.json()) as FeedbackBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (typeof body.sourceNote !== "string" || body.sourceNote.trim().length < 5) {
    return NextResponse.json(
      { error: "source_note_required", message: "sourceNote (what the buyer actually said) is mandatory — a margin without its source is a fabrication." },
      { status: 400 },
    );
  }

  const buyer = await getBuyerV2(buyerId);
  if (!buyer) return NextResponse.json({ error: "buyer_not_found", buyerId }, { status: 404 });

  const fields: Record<string, unknown> = {};
  const applied: string[] = [];
  if (body.minDealSpread !== undefined) {
    if (!posNum(body.minDealSpread)) return NextResponse.json({ error: "min_deal_spread_invalid" }, { status: 400 });
    fields[BUYER_V2_FIELDS.Min_Deal_Spread] = Math.round(body.minDealSpread);
    applied.push(`Min_Deal_Spread=$${Math.round(body.minDealSpread).toLocaleString()}`);
  }
  if (body.minAssignmentFeeTarget !== undefined) {
    if (!posNum(body.minAssignmentFeeTarget)) return NextResponse.json({ error: "min_assignment_fee_invalid" }, { status: 400 });
    fields[BUYER_V2_FIELDS.Min_Assignment_Fee_Target] = Math.round(body.minAssignmentFeeTarget);
    applied.push(`Min_Assignment_Fee_Target=$${Math.round(body.minAssignmentFeeTarget).toLocaleString()}`);
  }
  if (body.maxRehab !== undefined) {
    if (!posNum(body.maxRehab)) return NextResponse.json({ error: "max_rehab_invalid" }, { status: 400 });
    fields[BUYER_V2_FIELDS.Max_Rehab] = Math.round(body.maxRehab);
    applied.push(`Max_Rehab=$${Math.round(body.maxRehab).toLocaleString()}`);
  }
  if (body.preferredCondition !== undefined) {
    if (!Array.isArray(body.preferredCondition) || body.preferredCondition.some((s) => typeof s !== "string")) {
      return NextResponse.json({ error: "preferred_condition_invalid" }, { status: 400 });
    }
    fields[BUYER_V2_FIELDS.Preferred_Condition] = body.preferredCondition;
    applied.push(`Preferred_Condition=[${body.preferredCondition.join(", ")}]`);
  }
  if (body.pofReceived !== undefined) {
    fields[BUYER_V2_FIELDS.Proof_of_Funds_On_File] = body.pofReceived === true;
    applied.push(`POF=${body.pofReceived === true}`);
  }
  if (body.pofExpiryDate !== undefined) {
    const t = Date.parse(body.pofExpiryDate);
    if (!Number.isFinite(t)) return NextResponse.json({ error: "pof_expiry_invalid" }, { status: 400 });
    fields[BUYER_V2_FIELDS.POF_Expiry_Date] = new Date(t).toISOString().slice(0, 10);
    applied.push(`POF_Expiry=${new Date(t).toISOString().slice(0, 10)}`);
  }

  if (applied.length === 0) {
    return NextResponse.json({ error: "no_fields", message: "at least one criteria field is required" }, { status: 400 });
  }

  // Provenance line — every sourced margin carries the buyer's own words.
  const stamp = new Date().toISOString().slice(0, 10);
  const provenance = `[${stamp}] dispo-feedback (${authKind}): ${applied.join("; ")} — source: "${body.sourceNote.trim().slice(0, 300)}"`;
  fields[BUYER_V2_FIELDS.Notes] = buyer.notes ? `${buyer.notes}\n${provenance}` : provenance;

  try {
    await updateBuyerV2(buyerId, fields);
  } catch (err) {
    return NextResponse.json({ error: "write_failed", detail: String(err).slice(0, 300) }, { status: 502 });
  }

  await audit({
    agent: "dispo",
    event: "buyer_criteria_writeback",
    status: "confirmed_success",
    recordId: buyerId,
    inputSummary: { auth_kind: authKind, fields_applied: applied },
    outputSummary: { source_note_len: body.sourceNote.trim().length },
    ms: Date.now() - t0,
  });

  return NextResponse.json({ ok: true, buyerId, applied, provenance });
}
