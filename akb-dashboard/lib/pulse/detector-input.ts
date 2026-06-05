// Phase 14 / O.1 — shared detector input shape.
//
// Each detector is a pure function: (input: DetectorInput) =>
// PulseDetection[]. Input is composed by the runner from real I/O
// (audit log, Airtable, KV, env) so detectors stay testable without
// stubbing fetchers.

import type { AuditEntry } from "@/lib/audit-log";
import type { Listing } from "@/lib/types";

export interface PulseDetectorInput {
  /** Recent audit events, newest first. Bounded by the runner
   *  (default 500 entries via readRecentFromKv). */
  audit_log: AuditEntry[];
  /** Active listings from getActiveListingsForBrief. Used by the
   *  stale-data detector + cross-referenced by token-burn proxies. */
  listings: Listing[];
  /** Current canonical test count from lib/maverick/sources/
   *  codebase-metadata. Null when the prebuild artifact is missing
   *  (dev mode). Detectors degrade gracefully when null. */
  test_count: number | null;
  /** Previous test count anchor from KV (set after a successful
   *  scan); null on first run. */
  previous_test_count: number | null;
  /** Env vars for threshold overrides. Defaults to process.env in
   *  prod; tests inject. */
  env: Record<string, string | undefined>;
  /** Verification_URL coverage over the Live_Status=Active population
   *  (computed in the scan route via getActiveVerificationUrlCoverage).
   *  Null when the coverage query failed / was skipped — the detector
   *  degrades gracefully. Drives the verification_url_coverage metric. */
  verification_url_coverage?: {
    activeTotal: number;
    withUrl: number;
    withoutUrl: number;
    coveragePct: number;
  } | null;
  /** Now-clock for deterministic detection timestamps + age
   *  computations. */
  now: () => Date;
}
