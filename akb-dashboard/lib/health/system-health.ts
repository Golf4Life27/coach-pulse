// System health check (M9, operator 2026-06-18).
// @agent: maverick / sentry
//
// THE REUSABLE PREAMBLE. Confirms the infra a paid/writing run depends on is
// up BEFORE the run touches anything — fail-closed. Built standalone so a later
// /api/health route (or any cron that spends/writes) can call the same check
// rather than re-implementing it.
//
// HALT conditions (the caller MUST NOT proceed with paid work or writes):
//   - KV not configured, or unreachable (a live round-trip read fails).
//   - the Firecrawl spend breaker is tripped (or its read fails — fail-closed:
//     if we can't confirm the brake, don't run).
// WARNINGS (advisory — reported, do NOT halt by themselves): a known
//   non-positive Firecrawl balance, or a balance-probe error.
//
// Why KV is a hard gate: the breaker + the sole-writer engine's audit trail
// both live in KV; with KV down the spend brake is blind (it fails OPEN) and
// stage-transition provenance is lost. So an autoseed/price run with KV down is
// exactly the unguarded-burn shape the breaker exists to prevent.
//
// Pure-ish: all I/O via injected deps (default to prod wiring) so it is unit-
// testable without secrets.

import { kvConfigured as kvConfiguredProd, kvProd, type KvClient } from "@/lib/maverick/oauth/kv";
import { checkFirecrawlBreaker, FIRECRAWL_HOURLY_CREDIT_CAP } from "@/lib/crawler/firecrawl-circuit-breaker";
import { probeFirecrawlBalance } from "@/lib/crawler/sources/firecrawl";

export interface SystemHealth {
  /** Fully green — no halts and no warnings. */
  healthy: boolean;
  /** The actionable gate: true => a paid/writing run MUST NOT proceed. */
  halt: boolean;
  /** Machine-readable halt reasons (empty when not halting). */
  haltReasons: string[];
  /** Advisory signals that do not stop the run. */
  warnings: string[];
  kv: { configured: boolean; reachable: boolean; error: string | null };
  firecrawl: {
    breakerTripped: boolean;
    spentRecent: number;
    cap: number;
    headroom: number;
    balanceRemaining: number | null;
    balanceError: string | null;
  };
  checkedAt: string;
}

export interface HealthDeps {
  kvConfigured?: () => boolean;
  kv?: KvClient;
  checkBreaker?: typeof checkFirecrawlBreaker;
  probeBalance?: typeof probeFirecrawlBalance;
  now?: () => Date;
}

// A read-only liveness probe — a GET on a (typically absent) key returns null
// without a write; only a transport/auth failure throws.
const KV_PING_KEY = "health:ping";

export async function checkSystemHealth(deps: HealthDeps = {}): Promise<SystemHealth> {
  const now = (deps.now ?? (() => new Date()))();
  const isConfigured = (deps.kvConfigured ?? kvConfiguredProd)();
  const kv = deps.kv ?? kvProd;
  const checkBreaker = deps.checkBreaker ?? checkFirecrawlBreaker;
  const probeBalance = deps.probeBalance ?? probeFirecrawlBalance;

  const haltReasons: string[] = [];
  const warnings: string[] = [];

  // ── KV: configured + reachable ──────────────────────────────────────
  let kvReachable = false;
  let kvError: string | null = null;
  if (!isConfigured) {
    kvError = "KV not configured (KV_REST_API_URL / KV_REST_API_TOKEN absent)";
    haltReasons.push("kv_not_configured");
  } else {
    try {
      await kv.get(KV_PING_KEY);
      kvReachable = true;
    } catch (e) {
      kvError = e instanceof Error ? e.message : String(e);
      haltReasons.push("kv_unreachable");
    }
  }

  // ── Firecrawl spend breaker (reads KV) ──────────────────────────────
  let breakerTripped = false;
  let spentRecent = 0;
  let cap = FIRECRAWL_HOURLY_CREDIT_CAP;
  let headroom = cap;
  try {
    const v = await checkBreaker(now);
    breakerTripped = v.tripped;
    spentRecent = v.spentRecent;
    cap = v.cap;
    headroom = v.headroom;
    if (v.tripped) haltReasons.push("firecrawl_breaker_tripped");
  } catch (e) {
    // Can't confirm the brake → fail-closed.
    haltReasons.push(`firecrawl_breaker_check_failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ── Firecrawl balance probe (advisory) ──────────────────────────────
  const bal = await probeBalance();
  if (bal.error) warnings.push(`firecrawl_balance_probe_error: ${bal.error}`);
  if (bal.remaining != null && bal.remaining <= 0) warnings.push("firecrawl_balance_nonpositive");

  const halt = haltReasons.length > 0;
  return {
    healthy: !halt && warnings.length === 0,
    halt,
    haltReasons,
    warnings,
    kv: { configured: isConfigured, reachable: kvReachable, error: kvError },
    firecrawl: {
      breakerTripped,
      spentRecent,
      cap,
      headroom,
      balanceRemaining: bal.remaining,
      balanceError: bal.error,
    },
    checkedAt: now.toISOString(),
  };
}
