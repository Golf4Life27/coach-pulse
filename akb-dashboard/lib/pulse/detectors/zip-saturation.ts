// Workstream D1 / 24.5 — Pulse ZIP-saturation detector.
//
// Surfaces market saturation off ZIP_Registry state (the zip-saturation-check
// cron is what mutates tiers + streaks; Pulse only observes):
//   - EXPANSION (warning): ≥1 ZIP at Market_Tier=saturated — the market is
//     tapped out, stage a replacement so outreach volume doesn't decay.
//   - APPROACHING (info): ≥1 active ZIP whose Below_Threshold_Streak_Days is
//     within the warning band but hasn't flipped yet — early heads-up.
//
// Pulse surfaces; it does not act. Operator stages new ZIPs.

import type { PulseDetection } from "../types";
import type { PulseDetectorInput } from "../detector-input";
import { DEFAULT_STREAK_DAYS } from "@/lib/zip-saturation";

const DEFAULT_WARN_STREAK = 10;

function readInt(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

export function detectZipSaturation(input: PulseDetectorInput): PulseDetection[] {
  const rows = input.zip_registry ?? [];
  if (rows.length === 0) return [];

  const warnStreak = readInt(input.env, "PULSE_ZIP_SATURATION_WARN_STREAK", DEFAULT_WARN_STREAK);
  const flipStreak = readInt(input.env, "SATURATION_STREAK_DAYS", DEFAULT_STREAK_DAYS);
  const fires: PulseDetection[] = [];

  const saturated = rows.filter((r) => r.marketTier === "saturated").map((r) => r.zip);
  if (saturated.length > 0) {
    fires.push({
      id: "zip_saturation_expansion",
      detector_id: "zip_saturation",
      severity: "warning",
      title: `${saturated.length} ZIP${saturated.length === 1 ? "" : "s"} saturated — consider market expansion`,
      description:
        `These ZIPs flipped to Market_Tier=saturated (rolling accept rate held below ` +
        `Saturation_Threshold for ${flipStreak}+ consecutive days): ${saturated.join(", ")}. ` +
        `Intake no longer targets them, so outreach volume will decay unless replaced. ` +
        `Stage new ZIPs in ZIP_Registry (Market_Tier=staged → approval_pending) to backfill the funnel.`,
      suggested_action:
        "Stage replacement ZIPs in ZIP_Registry and run them through the market-expansion approval gate.",
      detected_at: input.now().toISOString(),
      source_data: { saturated_zips: saturated, flip_streak: flipStreak },
    });
  }

  const approaching = rows
    .filter(
      (r) =>
        r.marketTier === "active" &&
        (r.belowThresholdStreakDays ?? 0) >= warnStreak &&
        (r.belowThresholdStreakDays ?? 0) < flipStreak,
    )
    .map((r) => ({ zip: r.zip, streak: r.belowThresholdStreakDays ?? 0 }));
  if (approaching.length > 0) {
    fires.push({
      id: "zip_saturation_approaching",
      detector_id: "zip_saturation",
      severity: "info",
      title: `${approaching.length} ZIP${approaching.length === 1 ? "" : "s"} approaching saturation`,
      description:
        `Active ZIPs whose below-threshold streak is in the warning band ` +
        `(≥${warnStreak}, flips at ${flipStreak}): ` +
        `${approaching.map((a) => `${a.zip} (${a.streak}d)`).join(", ")}. ` +
        `Each will flip to saturated if its accept rate stays low. Pre-stage replacements now to avoid a volume gap.`,
      suggested_action: "Pre-stage candidate replacement ZIPs so the approval gate is ready before a flip.",
      detected_at: input.now().toISOString(),
      source_data: { approaching, warn_streak: warnStreak, flip_streak: flipStreak },
    });
  }

  return fires;
}
