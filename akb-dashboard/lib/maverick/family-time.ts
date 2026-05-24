// Phase 14.6 / Q.2 — Family-time signal awareness.
//
// Character Spec §4.6: Maverick respects Alex's family time. This
// helper classifies any given timestamp as "family-time" (don't
// surface non-critical pings) or "work-time" (surface normally).
// Briefing aggregator + Shepherd panel consume the flag to dim
// non-critical surfaces during family hours.
//
// Defaults: weekday evenings (after 18:00 local) + weekends. All
// configurable via env. Operator can override per their actual
// schedule.
//
// Pure helper — caller passes a Date; this function doesn't touch
// process.env or new Date() unless explicitly invoked via
// classifyNow(). Keeps tests deterministic.

export interface FamilyTimeRules {
  /** Hour of day (0-23) when work hours end on weekdays. After this
   *  hour, weekdays are family-time. Default 18 (6pm). */
  weekday_end_hour: number;
  /** Hour of day (0-23) when work hours start on weekdays. Before
   *  this hour, weekdays are family-time. Default 7 (7am). */
  weekday_start_hour: number;
  /** Whether weekends are wholly family-time. Default true. */
  weekends_family: boolean;
  /** Timezone for hour-of-day classification. Defaults to operator's
   *  configured tz via MAVERICK_TZ env, else "America/Chicago"
   *  (Alex is San Antonio-based). */
  timezone: string;
}

const DEFAULT_RULES: FamilyTimeRules = {
  weekday_end_hour: 18,
  weekday_start_hour: 7,
  weekends_family: true,
  timezone: "America/Chicago",
};

export function readFamilyTimeRules(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): FamilyTimeRules {
  const parseHour = (v: string | undefined, fallback: number): number => {
    if (!v) return fallback;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 23) return fallback;
    return Math.floor(n);
  };
  return {
    weekday_end_hour: parseHour(env.MAVERICK_FAMILY_END_HOUR, DEFAULT_RULES.weekday_end_hour),
    weekday_start_hour: parseHour(env.MAVERICK_FAMILY_START_HOUR, DEFAULT_RULES.weekday_start_hour),
    weekends_family: env.MAVERICK_WEEKENDS_FAMILY !== "false",
    timezone: env.MAVERICK_TZ ?? DEFAULT_RULES.timezone,
  };
}

interface ClockReading {
  /** 0 = Sunday, 6 = Saturday. */
  weekday: number;
  /** 0-23 in operator timezone. */
  hour: number;
}

/** Pure: extract weekday + hour-of-day in the operator's timezone.
 *  Exported so tests can lock the conversion logic. */
export function readClock(at: Date, tz: string): ClockReading {
  // Intl.DateTimeFormat is the only reliable cross-runtime tz path.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    hour: "numeric",
    hour12: false,
  });
  const parts = fmt.formatToParts(at);
  const weekdayStr = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
  const hourStr = parts.find((p) => p.type === "hour")?.value ?? "0";
  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  return {
    weekday: weekdayMap[weekdayStr] ?? 0,
    // Intl returns "24" at midnight for some locales — normalize.
    hour: (parseInt(hourStr, 10) || 0) % 24,
  };
}

export interface FamilyTimeClassification {
  is_family_time: boolean;
  reason: "weekend" | "after_hours" | "before_hours" | "work_hours";
  clock: ClockReading;
  rules: FamilyTimeRules;
}

/** Pure: classify a timestamp as family-time or work-time given
 *  rules. Caller provides `at` + `rules`; no I/O. */
export function classifyFamilyTime(
  at: Date,
  rules: FamilyTimeRules = DEFAULT_RULES,
): FamilyTimeClassification {
  const clock = readClock(at, rules.timezone);
  // Weekend gate.
  if (rules.weekends_family && (clock.weekday === 0 || clock.weekday === 6)) {
    return { is_family_time: true, reason: "weekend", clock, rules };
  }
  // Weekday after-hours.
  if (clock.hour >= rules.weekday_end_hour) {
    return { is_family_time: true, reason: "after_hours", clock, rules };
  }
  // Weekday before-hours.
  if (clock.hour < rules.weekday_start_hour) {
    return { is_family_time: true, reason: "before_hours", clock, rules };
  }
  return { is_family_time: false, reason: "work_hours", clock, rules };
}

/** Convenience: classify the current wall-clock time. */
export function classifyNow(): FamilyTimeClassification {
  return classifyFamilyTime(new Date(), readFamilyTimeRules());
}
