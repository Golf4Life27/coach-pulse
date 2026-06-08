// Paid-API call telemetry — wraps a single audit() entry per outbound
// HTTP call to a billed vendor (RentCast, ATTOM). Lives on the same
// agent:audit KV list the gate-runner + Pulse detectors already read,
// so per-source daily counts and per-deal runaway are derived from one
// source of truth — no parallel meter.
//
// Shape contract (consumed by lib/spend/derive.ts and the Pulse
// paid_api_spend_24h detector):
//   agent  = source vendor, lowercase ("rentcast" | "attom")
//   event  = "paid_api_call"
//   status = confirmed_success on 2xx, confirmed_failure on non-2xx /
//            thrown errors. uncertain is reserved for vendors with
//            queued/async semantics — neither RentCast nor ATTOM have
//            that today, so we don't emit it from this helper.
//   recordId optional — present when the call is attributable to a
//            specific listing. Absent for zip-level discovery scans.
//   outputSummary.endpoint — the path-fragment so per-endpoint mix is
//            visible in the audit detail without expanding inputSummary.
//   ms     — wall-clock duration of the HTTP call.

import { audit } from "@/lib/audit-log";

export type PaidApiSource = "rentcast" | "attom";

export interface AuditPaidCallArgs {
  source: PaidApiSource;
  /** Path fragment of the called endpoint, e.g. "avm/value" or
   *  "property/snapshot". No querystring. */
  endpoint: string;
  /** HTTP status code; -1 when the request threw before a response. */
  http: number;
  /** Wall-clock duration of the fetch, ms. */
  ms: number;
  /** Listing record id when the call is attributable to one. */
  recordId?: string;
  /** Short error message on non-2xx / throw. Capped at 300 chars. */
  error?: string;
}

export async function auditPaidCall(args: AuditPaidCallArgs): Promise<void> {
  const ok = args.http >= 200 && args.http < 300;
  await audit({
    agent: args.source,
    event: "paid_api_call",
    status: ok ? "confirmed_success" : "confirmed_failure",
    recordId: args.recordId,
    ms: args.ms,
    outputSummary: {
      endpoint: args.endpoint,
      http: args.http,
    },
    error: args.error ? args.error.slice(0, 300) : undefined,
  });
}
