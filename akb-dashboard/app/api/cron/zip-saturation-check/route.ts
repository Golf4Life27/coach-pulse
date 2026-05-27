// ZIP market-saturation auto-detection cron (Workstream D1 — 24.5).
// @agent: sentinel
//
// GET|POST /api/cron/zip-saturation-check[?dry_run=1]
//
// Daily. The SOLE writer of ZIP_Registry's rolling stats. For each
// launch/active ZIP it sums the trailing-window ZIP_Daily_Stats rows
// (appended by listings-intake) into true rolling figures and writes them
// back: Accept_Rate_30d, Avg_DOM, Avg_List_Price, Records_Ingested_30d.
//
// It then advances the saturation streak: a day whose rolling accept rate
// is under the ZIP's Saturation_Threshold extends Below_Threshold_Streak_Days;
// a good day resets it; a no-sample day leaves it unchanged. When an ACTIVE
// ZIP's streak reaches SATURATION_STREAK_DAYS (default 14) the ZIP flips to
// `saturated` (intake stops targeting it — getActiveIntakeRows excludes it)
// and a Spine row is written. Pulse surfaces the expansion suggestion off the
// saturated tier (lib/pulse/detectors/zip-saturation).
//
// Safety: DRY RUN by default; writes only when SATURATION_CHECK_LIVE="true"
// AND not ?dry_run=1. MAVERICK_CRON_ENABLED gate for cron-auth callers.

import { NextResponse } from "next/server";
import { audit } from "@/lib/audit-log";
import { writeState } from "@/lib/maverick/write-state";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import { getActiveIntakeRows, writeRollingStats } from "@/lib/zip-registry";
import { getRollingByZip, summarize } from "@/lib/zip-daily-stats";
import {
  evaluateSaturation,
  DEFAULT_STREAK_DAYS,
  DEFAULT_WINDOW_DAYS,
} from "@/lib/zip-saturation";

export const runtime = "nodejs";
export const maxDuration = 120;

function readInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

async function handle(req: Request): Promise<Response> {
  const t0 = Date.now();
  const url = new URL(req.url);

  // ── Auth waterfall (mirrors listings-intake / h2-outreach) ──────
  const cookieHeader = req.headers.get("cookie");
  let authKind: "dashboard_session" | "oauth" | "cron" | "bearer_dev" | "none" = "none";
  if (hasDashboardSession(cookieHeader)) {
    authKind = "dashboard_session";
  } else {
    const env = readAuthEnv();
    const headers = readAuthHeaders(req);
    const authRequired = kvConfigured() || env.cronSecret !== null || env.bearerDevToken !== null;
    if (authRequired) {
      const auth = await authenticate(headers, env, kvProd);
      if (!auth.ok) {
        return NextResponse.json({ error: "unauthorized", reason: auth.reason }, { status: 401 });
      }
      authKind = auth.kind;
    }
  }
  if (authKind === "cron" && process.env.MAVERICK_CRON_ENABLED !== "true") {
    return NextResponse.json({ error: "cron_disabled" }, { status: 503 });
  }

  const liveEnv = process.env.SATURATION_CHECK_LIVE === "true";
  const forcedDry = url.searchParams.get("dry_run") === "1";
  const dryRun = !liveEnv || forcedDry;

  const windowDays = readInt(process.env.SATURATION_WINDOW_DAYS, DEFAULT_WINDOW_DAYS);
  const streakDays = readInt(process.env.SATURATION_STREAK_DAYS, DEFAULT_STREAK_DAYS);
  const now = new Date();

  let rows;
  let rolling;
  try {
    [rows, rolling] = await Promise.all([
      getActiveIntakeRows(),
      getRollingByZip({ windowDays, asOf: now }),
    ]);
  } catch (err) {
    return NextResponse.json(
      { error: "saturation_read_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  const summary = {
    dry_run: dryRun,
    window_days: windowDays,
    streak_days: streakDays,
    zips_evaluated: rows.length,
    rolling_written: 0,
    newly_saturated: [] as string[],
    skipped_no_data: 0,
    errors: [] as string[],
  };
  const perZip: Array<Record<string, unknown>> = [];

  for (const row of rows) {
    const agg = rolling.get(row.zip);
    const s = agg
      ? summarize(agg)
      : { acceptRate: null, avgDom: null, avgListPrice: null, recordsIngested: 0, considered: 0, sampleDays: 0 };
    const prevStreak = row.belowThresholdStreakDays ?? 0;
    const ev = evaluateSaturation({
      acceptRate: s.acceptRate,
      considered: s.considered,
      threshold: row.saturationThreshold,
      previousStreak: prevStreak,
      streakThreshold: streakDays,
      tier: row.marketTier,
    });
    if (!ev.evaluable) summary.skipped_no_data++;

    perZip.push({
      zip: row.zip,
      tier: row.marketTier,
      accept_rate: s.acceptRate,
      threshold: ev.thresholdUsed,
      considered: s.considered,
      sample_days: s.sampleDays,
      prev_streak: prevStreak,
      new_streak: ev.newStreak,
      below_threshold: ev.belowThreshold,
      would_saturate: ev.shouldSaturate,
    });

    if (dryRun) continue;

    try {
      await writeRollingStats(row.recordId, {
        acceptRate30d: s.acceptRate,
        avgDom: s.avgDom,
        avgListPrice: s.avgListPrice,
        recordsIngested30d: s.recordsIngested,
        belowThresholdStreakDays: ev.newStreak,
        marketTier: ev.shouldSaturate ? "saturated" : undefined,
      });
      summary.rolling_written++;
    } catch (err) {
      summary.errors.push(`${row.zip}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    if (ev.shouldSaturate) {
      summary.newly_saturated.push(row.zip);
      try {
        await writeState({
          event_type: "decision",
          attribution_agent: "sentinel",
          title: `ZIP ${row.zip} flipped to SATURATED (${streakDays}-day accept-rate streak)`,
          description:
            `ZIP ${row.zip} (${row.market ?? "?"}) held a rolling accept rate below its ` +
            `Saturation_Threshold (${(ev.thresholdUsed * 100).toFixed(2)}%) for ${ev.newStreak} ` +
            `consecutive days — rolling accept_rate=${s.acceptRate != null ? (s.acceptRate * 100).toFixed(2) + "%" : "n/a"}, ` +
            `considered=${s.considered} over ${windowDays}d. Market_Tier→saturated; intake stops ` +
            `targeting it. Consider staging a replacement market in ZIP_Registry.`,
        });
      } catch (err) {
        console.error(`[zip-saturation-check] Spine write failed for ${row.zip}:`, err);
      }
    }
  }

  await audit({
    agent: "sentinel",
    event: dryRun ? "zip_saturation_check_dry_run" : "zip_saturation_check_live",
    status: summary.errors.length > 0 ? "uncertain" : "confirmed_success",
    inputSummary: { auth_kind: authKind, window_days: windowDays, streak_days: streakDays, dry_run: dryRun },
    outputSummary: {
      zips_evaluated: summary.zips_evaluated,
      rolling_written: summary.rolling_written,
      newly_saturated: summary.newly_saturated,
      skipped_no_data: summary.skipped_no_data,
    },
    ms: Date.now() - t0,
  });

  return NextResponse.json({
    ok: true,
    auth_kind: authKind,
    duration_ms: Date.now() - t0,
    ...summary,
    per_zip: perZip,
  });
}

export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}
