// INV-023 Pre-EMD panel backend. @agent: orchestrator
//
// GET  /api/deals/pre-emd-state?recordId=<listing recId>
//   → the joined Deals row's Pre_EMD_* state (attestations + evaluator
//     outputs) for the gate panel on the deal page.
// POST /api/deals/pre-emd-state { dealId, field, value }
//   → flip ONE operator attestation. ONLY the five operator-owned fields
//     are writable here; the evaluator-owned fields (Pre_EMD_Math_Gate,
//     Pre_EMD_Verdict, ...) are REFUSED — ruling 4: the math belongs to
//     the gate, hand-flips invite drift.
//
// Auth: dashboard cookie / CRON_SECRET / OAuth waterfall.

import { NextResponse } from "next/server";
import { getListing, getDeals, updateDealRecord } from "@/lib/airtable";
import { normalizeAddressKey } from "@/lib/crawler/intake-filter";
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

/** The ONLY fields this route may write — operator attestations. The
 *  signoff carries by/at stamps written alongside it. */
const OPERATOR_ATTESTATION_FIELDS: Record<string, { airtable: string; stampAt?: string }> = {
  preEmdCmaValidated: { airtable: "Pre_EMD_CMA_Validated", stampAt: "Pre_EMD_CMA_Validated_At" },
  preEmdArvConfirmed: { airtable: "Pre_EMD_ARV_Confirmed" },
  preEmdPhotosValidated: { airtable: "Pre_EMD_Photos_Validated", stampAt: "Pre_EMD_Photos_Validated_At" },
  preEmdAssignmentClauseVerified: { airtable: "Pre_EMD_Assignment_Clause_Verified" },
  preEmdOperatorSignoff: { airtable: "Pre_EMD_Operator_Signoff", stampAt: "Pre_EMD_Operator_Signoff_At" },
};

async function gate(req: Request): Promise<{ ok: true; authKind: string } | { ok: false; res: NextResponse }> {
  const cookieHeader = req.headers.get("cookie");
  if (hasDashboardSession(cookieHeader)) return { ok: true, authKind: "dashboard_session" };
  const env = readAuthEnv();
  const headers = readAuthHeaders(req);
  const authRequired = kvConfigured() || env.cronSecret !== null || env.bearerDevToken !== null;
  if (!authRequired) return { ok: true, authKind: "none" };
  const auth = await authenticate(headers, env, kvProd);
  if (!auth.ok) return { ok: false, res: NextResponse.json({ error: "unauthorized", reason: auth.reason }, { status: 401 }) };
  return { ok: true, authKind: auth.kind };
}

async function findDealForListing(recordId: string) {
  const listing = await getListing(recordId).catch(() => null);
  if (!listing?.address) return { listing, deal: null };
  const wantKey = normalizeAddressKey(listing.address.split(",")[0]);
  const deals = await getDeals().catch(() => []);
  const deal = deals.find((d) => d.propertyAddress && normalizeAddressKey(d.propertyAddress.split(",")[0]) === wantKey) ?? null;
  return { listing, deal };
}

export async function GET(req: Request) {
  const g = await gate(req);
  if (!g.ok) return g.res;
  const url = new URL(req.url);
  const recordId = url.searchParams.get("recordId") ?? "";
  if (!recordId) return NextResponse.json({ error: "recordId required" }, { status: 400 });

  const { listing, deal } = await findDealForListing(recordId);
  if (!deal) return NextResponse.json({ found: false, deal: null });
  return NextResponse.json({
    found: true,
    deal: {
      id: deal.id,
      propertyAddress: deal.propertyAddress,
      contractPrice: deal.contractPrice ?? null,
      underwrittenMao: listing?.underwrittenMao ?? null,
      preEmdCmaValidated: deal.preEmdCmaValidated === true,
      preEmdArvConfirmed: deal.preEmdArvConfirmed === true,
      preEmdPhotosValidated: deal.preEmdPhotosValidated === true,
      preEmdAssignmentClauseVerified: deal.preEmdAssignmentClauseVerified === true,
      preEmdOperatorSignoff: deal.preEmdOperatorSignoff === true,
      preEmdMathGate: deal.preEmdMathGate ?? "not_yet_evaluated",
      preEmdVerdict: deal.preEmdVerdict ?? "not_yet_evaluated",
      preEmdLastEvaluatedAt: deal.preEmdLastEvaluatedAt ?? null,
      preEmdHoldReasons: deal.preEmdHoldReasons ?? null,
    },
  });
}

export async function POST(req: Request) {
  const g = await gate(req);
  if (!g.ok) return g.res;

  let body: { dealId?: string; field?: string; value?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const { dealId, field } = body;
  const value = body.value === true;
  if (!dealId || !field) return NextResponse.json({ error: "dealId and field required" }, { status: 400 });

  const spec = OPERATOR_ATTESTATION_FIELDS[field];
  if (!spec) {
    // Evaluator-owned or unknown field — REFUSED (ruling 4).
    return NextResponse.json(
      { error: "field_not_operator_writable", detail: `"${field}" is not an operator attestation. Evaluator-owned fields are written only by /api/orchestrator/pre-emd-evaluate.` },
      { status: 403 },
    );
  }

  const fields: Record<string, unknown> = { [spec.airtable]: value };
  if (spec.stampAt) fields[spec.stampAt] = value ? new Date().toISOString() : null;
  if (field === "preEmdOperatorSignoff") fields["Pre_EMD_Operator_Signoff_By"] = value ? "Alex (dashboard)" : null;

  try {
    await updateDealRecord(dealId, fields);
  } catch (err) {
    return NextResponse.json({ error: "write_failed", message: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
  await audit({
    agent: "orchestrator",
    event: "pre_emd_attestation_set",
    status: "confirmed_success",
    recordId: dealId,
    inputSummary: { field: spec.airtable, value, auth_kind: g.authKind },
    outputSummary: { written: true },
  });
  return NextResponse.json({ ok: true, dealId, field: spec.airtable, value });
}
