// 2026-06-05 — Verification_URL coverage detector.
//
// The rehab-vision sweep can only run on records that carry a
// Verification_URL (Firecrawl needs a portal-detail page to scrape;
// without one the pipeline falls back to Street-View-only and the
// preflight gate refuses). When ~396 of ~2,147 active records had no
// URL, the sweep crawled lex-first into those empties and stalled.
//
// This detector turns "% active records with a Verification_URL" into a
// standing Pulse metric so the gap stays visible instead of having to
// be re-discovered. It fires WARNING below a coverage floor (default
// 80%) and CRITICAL well below it (default 60%). The exact numerator/
// denominator/percent ride in source_data so the operator reads the
// live number off the Pulse card every scan — even when not firing,
// the scan response surfaces the coverage object.
//
// Coverage is computed in the scan route (getActiveVerificationUrlCoverage)
// and passed through detector input; this detector is pure over it.

import type { PulseDetection } from "../types";
import type { PulseDetectorInput } from "../detector-input";

const DEFAULT_WARNING_PCT = 80;
const DEFAULT_CRITICAL_PCT = 60;

function readPct(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 100) return fallback;
  return n;
}

export function detectVerificationUrlCoverage(
  input: PulseDetectorInput,
): PulseDetection[] {
  const cov = input.verification_url_coverage;
  // Null = coverage query failed/skipped, or zero active records = no
  // data (not a coverage problem). Either way, nothing to surface.
  if (!cov || cov.activeTotal === 0) return [];

  const warnPct = readPct(input.env, "PULSE_URL_COVERAGE_WARNING_PCT", DEFAULT_WARNING_PCT);
  const critPct = readPct(input.env, "PULSE_URL_COVERAGE_CRITICAL_PCT", DEFAULT_CRITICAL_PCT);

  // Above the warning floor → healthy, no fire. (The live % is still
  // surfaced in the scan response's coverage echo.)
  if (cov.coveragePct >= warnPct) return [];

  const severity = cov.coveragePct < critPct ? "critical" : "warning";
  return [
    {
      id: "verification_url_coverage_low",
      detector_id: "verification_url_coverage",
      severity,
      title: `Verification_URL coverage ${cov.coveragePct}% — ${cov.withoutUrl} of ${cov.activeTotal} active records have no URL`,
      description:
        `${cov.withUrl}/${cov.activeTotal} active records carry a Verification_URL ` +
        `(${cov.coveragePct}%). ${cov.withoutUrl} are URL-less — the rehab-vision sweep ` +
        `cannot run on those (Firecrawl has no page to scrape → Street-View-only → ` +
        `rehab preflight refusal). Operator-configured floors: warning <${warnPct}%, ` +
        `critical <${critPct}%.`,
      suggested_action:
        severity === "critical"
          ? "Run /api/admin/url-backfill to resolve URLs for the URL-less actives via Firecrawl (address + still-on-market confirmed). Confirm intake is persisting Verification_URL on new records."
          : "Schedule a url-backfill pass for the URL-less actives. The intake path now persists Firecrawl URLs on new records, so this should trend up over time.",
      detected_at: input.now().toISOString(),
      source_data: {
        active_total: cov.activeTotal,
        with_url: cov.withUrl,
        without_url: cov.withoutUrl,
        coverage_pct: cov.coveragePct,
        warning_pct: warnPct,
        critical_pct: critPct,
      },
    },
  ];
}
