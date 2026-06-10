// Funnel-audit snapshot — contract + adapter.
//
// CONTRACT (backend request #2, queued with ops): the outreach-batch route
// already computes this exact shape per run (app/api/admin/outreach-batch
// Step 1-4 dispositioning). Ops persists the latest run to KV and exposes
// GET /api/admin/funnel-snapshot returning FunnelSnapshot. The Disposition
// union and funnel_audit fields below are copied verbatim from the batch
// route — ops ships to this contract and the adapter flips to live with no
// UI change.
//
// Until then the adapter falls back to a SIMULATED fixture, loudly labeled
// in the UI. Never render mock numbers as real.

export type Disposition =
  | "planned"
  | "planned_over_limit"
  | "ineligible"
  | "pre_outreach_filter"
  | "prior_contact_stalled"
  | "bad_phone_quarantined"
  | "route_skipped"
  | "incomplete_plan"
  | "out_of_zip_scope";

export interface RecordDisposition {
  recordId: string;
  address: string | null;
  zip: string | null;
  disposition: Disposition;
  reason: string | null;
  prior?: { recordId: string; address: string; status: string } | null;
}

export interface FunnelSnapshot {
  generated_at: string;
  /** which run produced it: dry_run | live */
  mode: "dry_run" | "live";
  params: { zips: string[] | null; limit: number };
  funnel_audit: {
    input_count: number;
    in_zip_scope: number | null;
    disposition_total: number;
    missing_from_funnel: string[];
    bucket_counts: Record<Disposition, number>;
  };
  dispositions: RecordDisposition[];
}

export interface FunnelSnapshotResult {
  snapshot: FunnelSnapshot;
  /** live = from the ops snapshot route; simulated = local fixture */
  source: "live" | "simulated";
}

// Labels pass the stranger test (round-2 rule 1); the system's bucket name
// stays in `desc` alongside the plain explanation for provenance.
export const BUCKET_META: Record<
  Disposition,
  { label: string; desc: string; tone: "go" | "hold" | "drop" }
> = {
  planned: { label: "READY TO SEND", desc: "text is written and cleared — goes out on the next live run (planned)", tone: "go" },
  planned_over_limit: { label: "NEXT BATCH", desc: "cleared to send but this batch was full — queued for the next one (planned_over_limit)", tone: "hold" },
  prior_contact_stalled: { label: "WAITING ON AGENT", desc: "this agent already has an open conversation with us — held so we don't double-text (prior_contact_stalled)", tone: "hold" },
  pre_outreach_filter: { label: "NOT READY", desc: "missing something before we can text — status, approval, or freshness (pre_outreach_filter)", tone: "drop" },
  ineligible: { label: "PRICE BLOCKED", desc: "our opener would exceed the max we should pay, or the record is blocked (ineligible)", tone: "drop" },
  bad_phone_quarantined: { label: "BAD PHONE", desc: "the agent's phone number is unusable (bad_phone_quarantined)", tone: "drop" },
  route_skipped: { label: "SKIPPED", desc: "the sender skipped it — each record carries its reason (route_skipped)", tone: "drop" },
  incomplete_plan: { label: "DEFECT", desc: "the plan was missing a phone or message — a bug to look at, not a decision (incomplete_plan)", tone: "drop" },
  out_of_zip_scope: { label: "OUT OF AREA", desc: "outside the market this run was limited to (out_of_zip_scope)", tone: "drop" },
};

// Representative fixture so the lane is reviewable before ops ships the
// snapshot route. Shape-true (same buckets the 6/10 proving batch produced);
// addresses are placeholders, NOT real pipeline records.
const SIMULATED: FunnelSnapshot = {
  generated_at: "2026-06-10T15:28:00.000Z",
  mode: "dry_run",
  params: { zips: ["48227"], limit: 6 },
  funnel_audit: {
    input_count: 41,
    in_zip_scope: 38,
    disposition_total: 41,
    missing_from_funnel: [],
    bucket_counts: {
      planned: 6,
      planned_over_limit: 2,
      prior_contact_stalled: 21,
      pre_outreach_filter: 5,
      ineligible: 2,
      bad_phone_quarantined: 1,
      route_skipped: 1,
      incomplete_plan: 0,
      out_of_zip_scope: 3,
    },
  },
  dispositions: [
    { recordId: "recSIM0000000001", address: "00000 Simulated Ave", zip: "48227", disposition: "planned", reason: null },
    { recordId: "recSIM0000000002", address: "00001 Simulated Ave", zip: "48227", disposition: "prior_contact_stalled", reason: "same agent already contacted at 00000 Simulated Ave", prior: { recordId: "recSIM0000000001", address: "00000 Simulated Ave", status: "Texted" } },
    { recordId: "recSIM0000000003", address: "00002 Simulated Ave", zip: "48227", disposition: "pre_outreach_filter", reason: "not_outreach_ready: Outreach_Status=Texted" },
    { recordId: "recSIM0000000004", address: "00003 Simulated Ave", zip: "48227", disposition: "ineligible", reason: "mao_not_underwritten" },
    { recordId: "recSIM0000000005", address: "00004 Simulated Ave", zip: "48228", disposition: "out_of_zip_scope", reason: "out_of_zip_scope (48228)" },
  ],
};

export async function fetchFunnelSnapshot(): Promise<FunnelSnapshotResult> {
  try {
    const r = await fetch("/api/admin/funnel-snapshot", { cache: "no-store" });
    if (r.ok) {
      const snap = (await r.json()) as FunnelSnapshot;
      if (snap && snap.funnel_audit && snap.funnel_audit.bucket_counts) {
        return { snapshot: snap, source: "live" };
      }
    }
  } catch {
    // route not shipped yet — fall through to fixture
  }
  return { snapshot: SIMULATED, source: "simulated" };
}
