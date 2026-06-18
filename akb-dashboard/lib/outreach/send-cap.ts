// H2 outreach send cap (M7 Part 2, operator 2026-06-18).
// @agent: orchestrator / sentry
//
// The SAFETY METER on the H2 opener lift. The live census shows 109 records
// already at outreach_ready; lifting H2_OUTREACH_HARD_DISABLE without a cap
// would fire all 109 at once. This module hard-bounds a live run to a handful
// of sends, in covered ZIPs only, watched-first.
//
// FAIL-CLOSED by construction:
//   - H2_COVERED_ZIPS unset → empty allowlist → ZERO sends (the operator must
//     declare the covered ZIPs before anything fires).
//   - per-run + per-zip caps default tight (5 / 2) and clamp to hard code
//     ceilings (25 / 10) so a fat-fingered env can never blast.
// The hard-disable (H2_OUTREACH_HARD_DISABLE) remains the master kill; this
// cap only ever applies AFTER the operator lifts it, and only to live sends.
//
// Pure. No I/O.

const DEFAULT_MAX_PER_RUN = 5;
const DEFAULT_MAX_PER_ZIP = 2;
// Hard ceilings — env can tune DOWN within these, never above (a larger ramp
// is a deliberate code change, never an env typo).
const CEIL_MAX_PER_RUN = 25;
const CEIL_MAX_PER_ZIP = 10;

export interface SendCapConfig {
  maxPerRun: number;
  maxPerZip: number;
  coveredZips: ReadonlySet<string>;
}

export type CapReason = "zip_not_covered" | "per_zip_cap" | "per_run_cap";

export interface CapDecision<T> {
  allowed: T[];
  capped: Array<{ item: T; zip: string | null; reason: CapReason }>;
  /** Echo of the effective config for the response/telemetry. */
  config: { maxPerRun: number; maxPerZip: number; coveredZips: string[] };
}

function clampInt(raw: string | undefined, dflt: number, ceil: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return dflt;
  return Math.min(ceil, Math.floor(n));
}

function norm5(zip: string | null | undefined): string | null {
  if (zip == null) return null;
  const d = String(zip).replace(/\D/g, "");
  return d.length >= 5 ? d.slice(0, 5) : null;
}

export function readSendCapConfig(env: NodeJS.ProcessEnv = process.env): SendCapConfig {
  const coveredZips = new Set<string>();
  for (const tok of (env.H2_COVERED_ZIPS ?? "").split(/[,\s]+/)) {
    const z = norm5(tok);
    if (z) coveredZips.add(z);
  }
  return {
    maxPerRun: clampInt(env.H2_MAX_SENDS_PER_RUN, DEFAULT_MAX_PER_RUN, CEIL_MAX_PER_RUN),
    maxPerZip: clampInt(env.H2_MAX_SENDS_PER_ZIP, DEFAULT_MAX_PER_ZIP, CEIL_MAX_PER_ZIP),
    coveredZips,
  };
}

/**
 * Pure: bound a list of would-send items to the cap. Order-preserving — the
 * first eligible items in covered ZIPs win the scarce slots; the rest are
 * deferred (they stay at outreach_ready and meter out over subsequent runs).
 * FAIL-CLOSED: an empty covered-ZIP allowlist caps everything (zero allowed).
 */
export function applySendCap<T>(
  items: T[],
  zipOf: (item: T) => string | null,
  cfg: SendCapConfig,
): CapDecision<T> {
  const allowed: T[] = [];
  const capped: CapDecision<T>["capped"] = [];
  const perZip = new Map<string, number>();

  for (const item of items) {
    const zip = norm5(zipOf(item));
    if (!zip || !cfg.coveredZips.has(zip)) {
      capped.push({ item, zip, reason: "zip_not_covered" });
      continue;
    }
    if ((perZip.get(zip) ?? 0) >= cfg.maxPerZip) {
      capped.push({ item, zip, reason: "per_zip_cap" });
      continue;
    }
    if (allowed.length >= cfg.maxPerRun) {
      capped.push({ item, zip, reason: "per_run_cap" });
      continue;
    }
    allowed.push(item);
    perZip.set(zip, (perZip.get(zip) ?? 0) + 1);
  }

  return {
    allowed,
    capped,
    config: {
      maxPerRun: cfg.maxPerRun,
      maxPerZip: cfg.maxPerZip,
      coveredZips: [...cfg.coveredZips],
    },
  };
}
