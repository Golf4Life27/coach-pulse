// DEPRECATED (Milestone 4, 2026-06-16). This route's math gate compares the
// INFORMATIONAL-ONLY Underwritten_MAO — the 23 Fields root cause — so its
// persisted Pre_EMD_Verdict can diverge from the ENFORCED gate. The single
// source of truth is now lib/orchestrator/pre-emd-gate-live.runPreEmdGateForDeal
// (enforced by request-emd + actions/sign_contract; displayed by
// /api/deals/pre-emd-state). Do NOT add new readers of this route's verdict —
// it is retained only for back-compat + audit and is superseded by the gate.
//
// INV-023 Pre-EMD gate EVALUATOR (2026-06-10). @agent: orchestrator
//
// GET|POST /api/orchestrator/pre-emd-evaluate?recordId=<listing recId>
//
// Runs the Pre-EMD gate (PE-01..PE-07) against the listing, COMPUTES the
// math gate (Underwritten_MAO >= contract_price — operator ruling 4: a
// hand-flippable checkbox for a computable fact invites drift, so the
// evaluator owns it), derives the aggregate verdict, and PERSISTS all of
// it to the joined Deals row:
//
//   Pre_EMD_Math_Gate          green | red | not_yet_evaluated
//   Pre_EMD_Verdict            pass | hold | block | not_yet_evaluated
//   Pre_EMD_Last_Evaluated_At  evaluation stamp
//   Pre_EMD_Hold_Reasons       itemized misses (checks + attestations)
//
// Verdict derivation:
//   block — the math is decisively AGAINST the deal (math gate red:
//           contract_price > Underwritten_MAO). No attestation can fix it.
//   hold  — anything missing: failed/data_missing checks, math gate not
//           yet computable, or operator attestations (CMA / ARV / photos)
//           unchecked. Retryable.
//   pass  — all 7 checks pass AND math gate green AND the three operator
//           attestations are checked.
//
// The EMD-fire path (app/api/deals/[dealId]/request-emd) refuses anything
// but pass. Auth: dashboard cookie / CRON_SECRET / OAuth waterfall.

import { NextResponse } from "next/server";
import { runGate } from "@/lib/orchestrator/gate-runner";
import { PRE_EMD_GATE, PRE_EMD_CHECKS, PRE_EMD_CONFIG } from "@/lib/orchestrator/pre-emd-checks";
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
export const maxDuration = 60;

export type MathGate = "green" | "red" | "not_yet_evaluated";
export type PreEmdVerdict = "pass" | "hold" | "block" | "not_yet_evaluated";

/** @deprecated Milestone 4 — compares the informational-only Underwritten_MAO
 *  (the 23 Fields root cause). The enforced money check is the Pre-EMD gate's
 *  DD-4 (Contract ≤ Your_MAO = Buyer_Median − Est_Rehab − Wholesale_Fee), via
 *  runPreEmdGateForDeal. Retained only for the existing unit test; not the
 *  source of truth.
 *
 *  Pure: the evaluator-owned math gate. Both inputs must be positive
 *  numbers to compute; anything else is not_yet_evaluated (never guessed). */
export function computeMathGate(
  underwrittenMao: number | null | undefined,
  contractPrice: number | null | undefined,
): MathGate {
  const mao = typeof underwrittenMao === "number" && underwrittenMao > 0 ? underwrittenMao : null;
  const price = typeof contractPrice === "number" && contractPrice > 0 ? contractPrice : null;
  if (mao == null || price == null) return "not_yet_evaluated";
  return mao >= price ? "green" : "red";
}

async function handle(req: Request) {
  const t0 = Date.now();
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

  const url = new URL(req.url);
  let recordId = url.searchParams.get("recordId") ?? "";
  if (!recordId && req.method === "POST") {
    try {
      const body = (await req.json()) as { recordId?: string };
      recordId = body.recordId ?? "";
    } catch { /* fall through */ }
  }
  if (!recordId) return NextResponse.json({ error: "recordId required" }, { status: 400 });

  // ── 1. Run the gate (PE-01..PE-07; PE-04/PE-07 read the joined deal). ──
  const gateResult = await runGate({
    gate: PRE_EMD_GATE,
    checks: PRE_EMD_CHECKS,
    config: PRE_EMD_CONFIG,
    recordId,
  });

  // ── 2. Resolve the Deals row (same join the gate-runner uses). ──────
  const listing = await getListing(recordId).catch(() => null);
  let deal: Awaited<ReturnType<typeof getDeals>>[number] | null = null;
  if (listing?.address) {
    const wantKey = normalizeAddressKey(listing.address.split(",")[0]);
    const deals = await getDeals().catch(() => []);
    deal = deals.find((d) => d.propertyAddress && normalizeAddressKey(d.propertyAddress.split(",")[0]) === wantKey) ?? null;
  }
  if (!deal) {
    return NextResponse.json({
      ok: false,
      error: "no_deal_row",
      detail: "No Deals row joins to this listing by address — the verdict has nowhere to persist. Create the deal first.",
      gate: gateResult,
      duration_ms: Date.now() - t0,
    }, { status: 404 });
  }

  // ── 3. Math gate (evaluator-owned, ruling 4). ───────────────────────
  const mathGate = computeMathGate(listing?.underwrittenMao ?? null, deal.contractPrice ?? null);

  // ── 4. Verdict + hold reasons. ──────────────────────────────────────
  const holdReasons: string[] = [];
  for (const r of gateResult.results ?? []) {
    if (r.status !== "pass") holdReasons.push(`${r.item_id} ${r.status}: ${r.reasoning}`);
  }
  if (mathGate === "not_yet_evaluated") {
    holdReasons.push(
      `MATH not_yet_evaluated: needs Underwritten_MAO (listing: ${listing?.underwrittenMao ?? "null"}) and contract_price (deal: ${deal.contractPrice ?? "null"}).`,
    );
  } else if (mathGate === "red") {
    holdReasons.push(
      `MATH red: contract_price $${(deal.contractPrice ?? 0).toLocaleString()} > Underwritten_MAO $${(listing?.underwrittenMao ?? 0).toLocaleString()} — deal math decisively against; no attestation can fix this.`,
    );
  }
  const attestations: Array<[string, boolean]> = [
    ["Pre_EMD_CMA_Validated", deal.preEmdCmaValidated === true],
    ["Pre_EMD_ARV_Confirmed", deal.preEmdArvConfirmed === true],
    ["Pre_EMD_Photos_Validated", deal.preEmdPhotosValidated === true],
  ];
  for (const [name, ok] of attestations) {
    if (!ok) holdReasons.push(`ATTESTATION missing: ${name} unchecked.`);
  }

  const checksAllPass = (gateResult.results ?? []).length > 0 && (gateResult.results ?? []).every((r) => r.status === "pass");
  const attestationsAllOk = attestations.every(([, ok]) => ok);
  const verdict: PreEmdVerdict =
    mathGate === "red" ? "block"
    : checksAllPass && mathGate === "green" && attestationsAllOk ? "pass"
    : "hold";

  // ── 5. Persist to the Deal (evaluator-owned fields only). ───────────
  const nowIso = new Date().toISOString();
  let writeError: string | null = null;
  try {
    await updateDealRecord(deal.id, {
      Pre_EMD_Math_Gate: mathGate,
      Pre_EMD_Verdict: verdict,
      Pre_EMD_Last_Evaluated_At: nowIso,
      Pre_EMD_Hold_Reasons: holdReasons.length > 0 ? holdReasons.join("\n") : "(none — all green)",
    });
  } catch (err) {
    writeError = err instanceof Error ? err.message : String(err);
  }

  await audit({
    agent: "orchestrator",
    event: "pre_emd_evaluate",
    status: writeError ? "confirmed_failure" : "confirmed_success",
    recordId,
    inputSummary: { auth_kind: authKind, deal_record_id: deal.id },
    outputSummary: { verdict, math_gate: mathGate, hold_reason_count: holdReasons.length, write_error: writeError },
    ms: Date.now() - t0,
  });

  return NextResponse.json({
    ok: writeError == null,
    deprecated: true,
    superseded_by:
      "Enforced INV-023 gate (runPreEmdGateForDeal) — displayed by /api/deals/pre-emd-state, enforced by /api/deals/request-emd and /api/actions/sign_contract. This route's Underwritten_MAO math is the 23 Fields root cause; do not rely on its verdict.",
    recordId,
    deal_record_id: deal.id,
    verdict,
    math_gate: mathGate,
    math_inputs: { underwritten_mao: listing?.underwrittenMao ?? null, contract_price: deal.contractPrice ?? null },
    hold_reasons: holdReasons,
    checks: (gateResult.results ?? []).map((r) => ({ id: r.item_id, status: r.status, reasoning: r.reasoning })),
    persisted: writeError == null ? { Pre_EMD_Math_Gate: mathGate, Pre_EMD_Verdict: verdict, Pre_EMD_Last_Evaluated_At: nowIso } : null,
    write_error: writeError,
    duration_ms: Date.now() - t0,
  });
}

export async function GET(req: Request) { return handle(req); }
export async function POST(req: Request) { return handle(req); }
