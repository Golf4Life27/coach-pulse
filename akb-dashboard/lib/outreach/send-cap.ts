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

// Volume ramp (operator /goal 2026-07-22, deliberate code change per the
// ceiling doctrine below): defaults lifted 5→12 per run and 2→3 per ZIP so
// the multi-slot cron can reach the operator's 100/day supply target once
// supply exists. The NEW daily send meter (below) hard-bounds the day at
// H2_DAILY_SEND_CAP regardless of slot count — per-run caps pace the day,
// the daily meter ends it.
const DEFAULT_MAX_PER_RUN = 12;
const DEFAULT_MAX_PER_ZIP = 3;
// Hard ceilings — env can tune DOWN within these, never above (a larger ramp
// is a deliberate code change, never an env typo).
const CEIL_MAX_PER_RUN = 25;
const CEIL_MAX_PER_ZIP = 10;
// Daily send governor: default + hard ceiling for total live sends per UTC
// day across ALL runs. 100 = the operator's ruled supply target (2026-07-22,
// "100/day is a SUPPLY TARGET"); the ceiling bounds a fat-fingered env.
const DEFAULT_DAILY_SEND_CAP = 100;
const CEIL_DAILY_SEND_CAP = 150;

export interface SendCapConfig {
  maxPerRun: number;
  maxPerZip: number;
  coveredZips: ReadonlySet<string>;
  /** "allowlist" = env-enumerated ZIPs (legacy). "auto" = the operator set
   *  H2_COVERED_ZIPS=auto (UNLEASH ruling, 2026-07-09): coverage follows the
   *  SEEDED-ZIP registry — any ZIP the system has seeded (and can therefore
   *  value-anchor price in) is send-covered, so metros expand by seeding
   *  alone, never by env surgery. The route fills coveredZips from the seed
   *  store when mode is "auto"; this pure module only reports the mode.
   *  Unset env stays FAIL-CLOSED (empty allowlist, zero sends). */
  coverageMode: "allowlist" | "auto";
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

// ── Daily send meter (operator /goal 2026-07-22) ───────────────────────
//
// The per-run caps alone stop bounding the day once the cron runs many
// slots — 8 slots × 25 (env ceiling) would be 200/day with no single
// brake. This meter is that brake: a KV counter of live sends per UTC
// day; each run's effective per-run cap is clamped to the unspent daily
// allowance. Mirrors the crawl meter's contract (frontier-governor):
// non-atomic add is acceptable (slots are hours apart; the per-run cap
// is the hard per-invocation bound), and an UNREADABLE meter falls back
// to the per-run cap alone rather than darking sends — but the route
// AUDITS that fallback so a broken meter is visible, never silent.

export function readDailySendCap(env: NodeJS.ProcessEnv = process.env): number {
  return clampInt(env.H2_DAILY_SEND_CAP, DEFAULT_DAILY_SEND_CAP, CEIL_DAILY_SEND_CAP);
}

/** KV key for today's live-send meter (UTC date). 48h TTL = day + slack. */
export function dailySendMeterKey(now: Date): string {
  return `h2:outreach:sends:${now.toISOString().slice(0, 10)}`;
}
export const DAILY_SEND_METER_TTL_S = 172_800;

export interface DailySendVerdict {
  /** Effective per-run send cap after the daily clamp. */
  maxPerRunToday: number;
  allowanceLeftToday: number;
  meterReadable: boolean;
  dailyCap: number;
  reason: string;
}

/** Pure: clamp a run's per-run send cap to the unspent share of the daily
 *  allowance. usedToday = null → meter unreadable → per-run cap alone. */
export function governDailySends(input: {
  maxPerRun: number;
  dailyCap: number;
  usedToday: number | null;
}): DailySendVerdict {
  const perRun = Math.max(0, Math.floor(input.maxPerRun));
  if (input.usedToday == null) {
    return {
      maxPerRunToday: perRun,
      allowanceLeftToday: -1,
      meterReadable: false,
      dailyCap: input.dailyCap,
      reason: "daily send meter unreadable — per-run cap only",
    };
  }
  const left = Math.max(0, input.dailyCap - Math.max(0, input.usedToday));
  const cap = Math.min(perRun, left);
  return {
    maxPerRunToday: cap,
    allowanceLeftToday: left,
    meterReadable: true,
    dailyCap: input.dailyCap,
    reason:
      cap < perRun
        ? `daily send cap clamp: ${left} of ${input.dailyCap} sends left today`
        : `within daily cap: ${left} of ${input.dailyCap} sends left today`,
  };
}

export function readSendCapConfig(env: NodeJS.ProcessEnv = process.env): SendCapConfig {
  const raw = (env.H2_COVERED_ZIPS ?? "").trim();
  const coverageMode: SendCapConfig["coverageMode"] = raw.toLowerCase() === "auto" ? "auto" : "allowlist";
  const coveredZips = new Set<string>();
  if (coverageMode === "allowlist") {
    for (const tok of raw.split(/[,\s]+/)) {
      const z = norm5(tok);
      if (z) coveredZips.add(z);
    }
  }
  return {
    maxPerRun: clampInt(env.H2_MAX_SENDS_PER_RUN, DEFAULT_MAX_PER_RUN, CEIL_MAX_PER_RUN),
    maxPerZip: clampInt(env.H2_MAX_SENDS_PER_ZIP, DEFAULT_MAX_PER_ZIP, CEIL_MAX_PER_ZIP),
    coveredZips,
    coverageMode,
  };
}

/** Route-side composition for "auto" mode: coverage = the seeded-ZIP set
 *  (a ZIP without a seed can't value-anchor price, so it could never send
 *  anyway — coverage and priceability collapse into one registry). In
 *  "allowlist" mode this is a no-op passthrough. Still fail-closed: auto
 *  mode with an EMPTY seed store covers nothing. */
export function resolveCoverage(cfg: SendCapConfig, seededZips: Iterable<string>): SendCapConfig {
  if (cfg.coverageMode !== "auto") return cfg;
  const covered = new Set<string>();
  for (const z of seededZips) {
    const n = norm5(z);
    if (n) covered.add(n);
  }
  return { ...cfg, coveredZips: covered };
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
