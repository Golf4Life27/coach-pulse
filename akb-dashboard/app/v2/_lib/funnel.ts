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

export const BUCKET_META: Record<
  Disposition,
  { label: string; desc: string; tone: "go" | "hold" | "drop" }
> = {
  planned: { label: "PLANNED", desc: "first-touch plan complete — fires on next live run", tone: "go" },
  planned_over_limit: { label: "OVER LIMIT", desc: "plan complete, dropped by batch limit — next batch", tone: "hold" },
  prior_contact_stalled: { label: "AGENT STALL", desc: "same agent already in an open thread — releases on reply or window expiry", tone: "hold" },
  pre_outreach_filter: { label: "NOT READY", desc: "failed outreach-ready check (status / approval / freshness)", tone: "drop" },
  ineligible: { label: "INELIGIBLE", desc: "opener-vs-MAO guard or record-level block", tone: "drop" },
  bad_phone_quarantined: { label: "BAD PHONE", desc: "agent phone would not normalize to E.164", tone: "drop" },
  route_skipped: { label: "ROUTE SKIP", desc: "cadence router skipped (per-record reason attached)", tone: "drop" },
  incomplete_plan: { label: "INCOMPLETE", desc: "first_touch plan missing phone or message — defect bucket", tone: "drop" },
  out_of_zip_scope: { label: "OUT OF ZIP", desc: "outside the market scope of this run", tone: "drop" },
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
