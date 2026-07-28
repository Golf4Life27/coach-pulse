// RETIRED SENDER (operator burn-down 2026-07-28, audit finding #1 —
// Spine recV9zpfSyF6BYbOj). @agent: crier
//
// This route was the "controlled first batch" sender. It survived the
// 2026-07-22 retirement sweep that killed its sibling (/api/outreach-fire)
// for the exact same defect: it priced the sent number off the RETIRED
// MAO_V1 field (List × 0.65 — the Blackmoor rail) via openerMaoGuard, which
// only caps downward and never derives value. It never imported the
// canonical pricer, so no ARV-sanity gate, no corroboration, no
// feasibility check, and no over-list tripwire ever saw its numbers. Worse,
// on confirmed delivery it wrote that retired number into
// Outreach_Offer_Price — the field parked-followup, the offer letter
// fallback, reply-alert, decision-math, and d3-cadence all treat as sticky
// ground truth — and it was that field's ONLY live writer.
//
// Doctrine (pricing-doctrine skill; INVARIANTS §2; "one concept per
// surface"): the value-anchored pricer is the SOLE producer of a sent
// number, and there is exactly ONE first-touch sender —
// /api/cron/h2-outreach (value-anchored opener + full guard stack + send
// cap + daily meter). Rather than re-implement the pricer here (a second
// copy that would drift), this route is RETIRED: it permanently refuses,
// independent of any env flag or confirm token. The operator's manual-fire
// need is served by the h2-outreach cron via the h2-send GitHub Actions
// workflow (dry preview by default; live only with the send flags set).

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

function retired(): Response {
  return NextResponse.json(
    {
      error: "outreach_batch_retired",
      reason:
        "Retired 2026-07-28: this sender priced its texts off the retired " +
        "MAO_V1 (65%-of-list Blackmoor rail) with none of the pricing " +
        "gates, and wrote that number to Outreach_Offer_Price for other " +
        "lanes to trust. The single value-anchored first-touch sender is " +
        "/api/cron/h2-outreach — fire it via the h2-send GitHub Actions " +
        "workflow (dry by default; live only with the send flags set).",
      canonical_sender: "/api/cron/h2-outreach",
      audit_ref: "Spine recV9zpfSyF6BYbOj (ruling-enforcement audit, finding #1)",
    },
    { status: 410 },
  );
}

export async function GET() {
  return retired();
}

export async function POST() {
  return retired();
}
