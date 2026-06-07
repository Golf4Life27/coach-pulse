// Phase 14 / O.1 — Pulse scan endpoint.
//
// GET /api/agents/pulse/scan
//
// Fires the 6 detectors against the current system state. Each
// detection state transition (off→on / on→off) writes to Spine
// with attribution_agent: pulse and to the audit log. Steady-state
// detections (active in both scans) don't re-write — keeps Spine
// clean of duplicate alerts.
//
// Triggering:
//   - Manual via this GET endpoint (operator on demand)
//   - Daily cron via vercel.json (registered separately in O.x;
//     defaults to 0 12 * * * which doesn't collide with existing
//     daily slots: 0 8 / 0 9 / 0 10 / 0 11 / 0 13)
//
// Auth posture: no app-level auth — same convention as the rest of
// the /api/* routes in this codebase. Vercel deployment-level
// access control covers it.

import { NextResponse } from "next/server";
import { readRecentFromKv } from "@/lib/audit-log";
import { countSpineRowsSince } from "@/lib/pulse/spine-count";
import { getActiveListingsForBrief, getActiveVerificationUrlCoverage } from "@/lib/airtable";
import { fetchCodebaseMetadataState } from "@/lib/maverick/sources/codebase-metadata";
import { readPulseState } from "@/lib/pulse/active-store";
import { runPulseScan } from "@/lib/pulse/runner";

export const runtime = "nodejs";
export const maxDuration = 60;

const DEFAULT_AUDIT_LIMIT = 500;

export async function GET() {
  const t0 = Date.now();
  try {
    // I/O fan-out in parallel to keep the scan within the lambda
    // budget. Each source is independent.
    // Durable Spine counts (fix 2026-06-07 for the false "zero writes"
    // alarm): the audit-log buffer can evict write_state events before
    // the 48h cutoff in high-cron sessions. The Spine table count is
    // authoritative.
    const nowMs = Date.now();
    const since24Iso = new Date(nowMs - 24 * 3_600_000).toISOString();
    const since48Iso = new Date(nowMs - 48 * 3_600_000).toISOString();
    const [audit, listings, metadata, previousState, urlCoverage, spine24, spine48] = await Promise.all([
      readRecentFromKv(DEFAULT_AUDIT_LIMIT),
      getActiveListingsForBrief({ recentDays: 14 }),
      fetchCodebaseMetadataState({ timeoutMs: 3_000 }).catch(() => null),
      readPulseState(),
      getActiveVerificationUrlCoverage().catch(() => null),
      countSpineRowsSince(since24Iso),
      countSpineRowsSince(since48Iso),
    ]);

    const testCount =
      metadata && metadata.ok && metadata.data ? metadata.data.test_count : null;

    const result = await runPulseScan({
      audit_log: audit,
      listings,
      test_count: testCount,
      previous_test_count: previousState.test_count_anchor,
      env: process.env as Record<string, string | undefined>,
      verification_url_coverage: urlCoverage,
      spine_writes_24h: spine24,
      spine_writes_48h: spine48,
      now: () => new Date(),
    });

    return NextResponse.json({
      scanned_at: new Date().toISOString(),
      elapsed_ms: Date.now() - t0,
      audit_log_size: audit.length,
      listings_examined: listings.length,
      verification_url_coverage: urlCoverage,
      test_count: testCount,
      previous_test_count: previousState.test_count_anchor,
      transitions: {
        new: result.new_ids,
        resolved: result.resolved_ids,
        steady: result.steady_ids,
      },
      spine_writes: result.spine_writes,
      detections: result.detections,
      state: result.state,
    });
  } catch (err) {
    console.error("[pulse-scan] failed:", err);
    return NextResponse.json(
      {
        error: "pulse_scan_failed",
        detail: String(err).slice(0, 500),
        elapsed_ms: Date.now() - t0,
      },
      { status: 500 },
    );
  }
}
