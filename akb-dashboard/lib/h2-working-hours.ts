// H2 working-hours gate (INV-H2-WORKING-HOURS). @agent: crier
//
// PURE. No env reads, no clock baked in (callers pass `now`), no I/O — so
// every window decision is deterministic and unit-testable, including DST
// boundaries (Intl.DateTimeFormat resolves the offset for the given instant).
//
// A first-touch SMS may only fire 8am–8pm in the PROPERTY's local timezone
// (derived from State), all 7 days by default. Outside the window the H2
// route returns `outside_hours` and leaves the record at Outreach_Status=""
// so the next in-window cron run picks it up. Only first_touch is gated —
// prior_contact_stall and bad_phone_quarantine do not text, so their Airtable
// bookkeeping runs 24/7 (see the route).

export const DEFAULT_TIMEZONE = "America/Chicago";

// State → canonical IANA timezone. Unknown states fall back to
// DEFAULT_TIMEZONE (operator home zone) with tz_defaulted=true so the route
// can warn. Restricted states are included with their real zones for
// completeness; they never reach the gate (not textable).
export const STATE_TIMEZONES: Readonly<Record<string, string>> = {
  TX: "America/Chicago",
  TN: "America/Chicago",
  MI: "America/Detroit",
  FL: "America/New_York",
  GA: "America/New_York",
  AL: "America/Chicago",
  MS: "America/Chicago",
  LA: "America/Chicago",
  AR: "America/Chicago",
  KY: "America/New_York",
  WV: "America/New_York",
  OH: "America/New_York",
  IN: "America/Indiana/Indianapolis",
  // Restricted (won't text) — real zones for completeness.
  MO: "America/Chicago",
  OK: "America/Chicago",
  ND: "America/Chicago",
  IL: "America/Chicago",
  NC: "America/New_York",
  SC: "America/New_York",
};

export interface WorkingHoursConfig {
  enabled: boolean;
  startHour: number; // inclusive
  endHour: number; // exclusive
  days: number[]; // 0=Sun … 6=Sat
}

export const DEFAULT_WORKING_HOURS: WorkingHoursConfig = {
  enabled: true,
  startHour: 8,
  endHour: 20,
  days: [0, 1, 2, 3, 4, 5, 6],
};

export interface WorkingHoursMeta {
  state: string | null;
  timezone: string;
  local_hour: number;
  local_weekday: number;
  window_start: number;
  window_end: number;
  tz_defaulted: boolean;
}

export interface WorkingHoursResult {
  inside: boolean;
  meta: WorkingHoursMeta;
}

/** Pure: resolve a State value to its IANA zone. Unknown → CT default. */
export function resolveTimezone(state: string | null | undefined): { tz: string; isDefault: boolean } {
  const key = (state ?? "").trim().toUpperCase();
  const tz = STATE_TIMEZONES[key];
  return tz ? { tz, isDefault: false } : { tz: DEFAULT_TIMEZONE, isDefault: true };
}

const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/** Pure: the hour (0–23) and weekday (0–6) of `now` in the given IANA zone.
 *  Intl handles DST automatically for the instant. */
export function localHourAndWeekday(tz: string, now: Date): { hour: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    hour: "2-digit",
    weekday: "short",
  }).formatToParts(now);
  let hour = 0;
  let weekday = 0;
  for (const p of parts) {
    if (p.type === "hour") hour = parseInt(p.value, 10) % 24;
    else if (p.type === "weekday") weekday = WEEKDAY_INDEX[p.value] ?? 0;
  }
  return { hour, weekday };
}

/** Pure: is `now` inside the working-hours window for a property in `state`? */
export function evaluateWorkingHours(
  state: string | null | undefined,
  cfg: WorkingHoursConfig,
  now: Date = new Date(),
): WorkingHoursResult {
  const { tz, isDefault } = resolveTimezone(state);
  const { hour, weekday } = localHourAndWeekday(tz, now);
  const inside = hour >= cfg.startHour && hour < cfg.endHour && cfg.days.includes(weekday);
  return {
    inside,
    meta: {
      state: state ?? null,
      timezone: tz,
      local_hour: hour,
      local_weekday: weekday,
      window_start: cfg.startHour,
      window_end: cfg.endHour,
      tz_defaulted: isDefault,
    },
  };
}

/** Pure: build a config from raw env strings, falling back to defaults on
 *  missing/invalid input. `enabled` is true unless explicitly "false". */
export function parseWorkingHoursConfig(env: {
  enabled?: string | undefined;
  start?: string | undefined;
  end?: string | undefined;
  days?: string | undefined;
}): WorkingHoursConfig {
  const startHour = parseHour(env.start, DEFAULT_WORKING_HOURS.startHour);
  const endHour = parseHour(env.end, DEFAULT_WORKING_HOURS.endHour);
  const days = parseDays(env.days);
  return {
    enabled: env.enabled !== "false",
    startHour,
    endHour,
    days,
  };
}

function parseHour(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 24 ? n : fallback;
}

function parseDays(raw: string | undefined): number[] {
  if (raw == null || raw.trim() === "") return [...DEFAULT_WORKING_HOURS.days];
  const days = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  return days.length > 0 ? Array.from(new Set(days)) : [...DEFAULT_WORKING_HOURS.days];
}
