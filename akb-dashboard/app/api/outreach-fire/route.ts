// RETIRED SENDER (operator 2026-07-22). @agent: crier
//
// This route was a SECOND, parallel first-touch SMS sender that priced the
// door-opener at a flat 65% of list price (`listPrice * 0.65`) — the exact
// retired rail behind the Blackmoor $84.5k over-offer (INVARIANTS §2,
// operator 2026-06-28). It survived the pricing-doctrine cleanup because it
// lived off to the side of the guarded h2-outreach cron, still wired to a
// one-click dashboard "Send N texts" button (components/OutreachPanel.tsx)
// and armed under the SAME H2_OUTREACH_HARD_DISABLE flag — which is `false`
// in production so the value-anchored cron can send. That left a list-anchored
// sender live on the dashboard.
//
// Doctrine (pricing-doctrine skill; INVARIANTS §2; "one concept per surface"):
// the value-anchored pricer is the SOLE producer of a sent number, and there
// is exactly ONE sender — /api/cron/h2-outreach (value-anchored opener + the
// full guard stack + send cap + daily send meter). Rather than reimplement the
// pricer here (a second copy that would drift), this route is RETIRED: the
// send path permanently refuses, independent of any env flag. The operator's
// manual-fire need is served by the h2-outreach cron via the h2-send GitHub
// Actions workflow (dry preview by default; live only with the send flags set).
//
// The badge-count GET is kept (the dashboard panel reads it) but no longer
// computes any list-fraction price — it counts qualified records by the
// non-pricing eligibility filters only.

import { getListings } from "@/lib/airtable";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Badge counts for the dashboard Outreach panel. NO pricing math — the
 *  retired 65%-of-list threshold is gone; this counts records that clear the
 *  non-pricing eligibility filters (the actual send + its guarded number are
 *  owned by /api/cron/h2-outreach). */
export async function GET() {
  try {
    const listings = await getListings();

    const contactedPhones = new Set<string>();
    for (const l of listings) {
      if (l.agentPhone && l.outreachStatus) {
        contactedPhones.add(l.agentPhone.replace(/[^0-9]/g, "").slice(-10));
      }
    }

    let newOutreach = 0;
    let multiListing = 0;

    for (const l of listings) {
      if (l.outreachStatus === "Multi-Listing Queued") {
        multiListing++;
        continue;
      }
      if (
        l.executionPath === "Auto Proceed" &&
        l.liveStatus === "Active" &&
        !l.outreachStatus &&
        !l.doNotText &&
        l.agentPhone &&
        l.listPrice && l.listPrice > 0 &&
        l.address
      ) {
        const clean = l.agentPhone.replace(/[^0-9]/g, "").slice(-10);
        if (!contactedPhones.has(clean)) newOutreach++;
      }
    }

    return Response.json({ newOutreach, multiListing });
  } catch {
    return Response.json({ newOutreach: 0, multiListing: 0 });
  }
}

/** RETIRED — permanent refusal, independent of any env flag. The list-anchored
 *  send path this route used to run is a pricing-doctrine violation; the single
 *  value-anchored sender is /api/cron/h2-outreach. */
export async function POST() {
  return Response.json(
    {
      error: "outreach_fire_retired",
      reason:
        "Retired 2026-07-22: this sender priced the opener at 65% of list " +
        "(the retired Blackmoor rail). The single value-anchored sender is " +
        "/api/cron/h2-outreach — fire it via the h2-send GitHub Actions " +
        "workflow (dry by default; live only with the send flags set).",
      canonical_sender: "/api/cron/h2-outreach",
    },
    { status: 410 },
  );
}
