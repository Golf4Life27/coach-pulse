// Pure tests for the H2 working-hours gate.

import { describe, it, expect } from "vitest";
import {
  resolveTimezone,
  localHourAndWeekday,
  evaluateWorkingHours,
  parseWorkingHoursConfig,
  effectiveSendWindow,
  evaluateSendWindow,
  SEND_WINDOW_FLOOR,
  DEFAULT_WORKING_HOURS,
  type WorkingHoursConfig,
} from "./h2-working-hours";

// Helpers: fixed UTC instants chosen so the CT/ET local hour is known.
// America/Chicago: CST = UTC-6 (winter), CDT = UTC-5 (summer).
const cfg = (over: Partial<WorkingHoursConfig> = {}): WorkingHoursConfig => ({
  ...DEFAULT_WORKING_HOURS,
  ...over,
});

describe("resolveTimezone", () => {
  it("maps known states to their IANA zone", () => {
    expect(resolveTimezone("TX")).toEqual({ tz: "America/Chicago", isDefault: false });
    expect(resolveTimezone("tn")).toEqual({ tz: "America/Chicago", isDefault: false });
    expect(resolveTimezone(" GA ")).toEqual({ tz: "America/New_York", isDefault: false });
    expect(resolveTimezone("MI")).toEqual({ tz: "America/Detroit", isDefault: false });
    expect(resolveTimezone("IN")).toEqual({ tz: "America/Indiana/Indianapolis", isDefault: false });
  });
  it("defaults unknown/empty states to America/Chicago, flagged", () => {
    expect(resolveTimezone("ZZ")).toEqual({ tz: "America/Chicago", isDefault: true });
    expect(resolveTimezone(null)).toEqual({ tz: "America/Chicago", isDefault: true });
    expect(resolveTimezone("")).toEqual({ tz: "America/Chicago", isDefault: true });
  });
});

describe("localHourAndWeekday — DST aware", () => {
  it("same 14:00Z instant is 8am CT in winter (CST) but 9am CT in summer (CDT)", () => {
    expect(localHourAndWeekday("America/Chicago", new Date("2026-01-15T14:00:00Z")).hour).toBe(8);
    expect(localHourAndWeekday("America/Chicago", new Date("2026-07-15T14:00:00Z")).hour).toBe(9);
  });
  it("resolves Eastern correctly (9am EST at 14:00Z) — cross-check vs CT", () => {
    expect(localHourAndWeekday("America/New_York", new Date("2026-01-15T14:00:00Z")).hour).toBe(9);
  });
  it("handles the spring-forward week (March 2026) without drift", () => {
    // 2026-03-08 is spring-forward; after it CT is CDT (UTC-5).
    expect(localHourAndWeekday("America/Chicago", new Date("2026-03-09T14:00:00Z")).hour).toBe(9);
    // Before it, still CST (UTC-6).
    expect(localHourAndWeekday("America/Chicago", new Date("2026-03-01T14:00:00Z")).hour).toBe(8);
  });
  it("reports weekday (Jan 15 2026 is a Thursday = 4)", () => {
    expect(localHourAndWeekday("America/Chicago", new Date("2026-01-15T14:00:00Z")).weekday).toBe(4);
  });
});

describe("evaluateWorkingHours — window boundaries (TX, CST)", () => {
  it("9am CT → inside, first_touch may fire", () => {
    const r = evaluateWorkingHours("TX", cfg(), new Date("2026-01-15T15:00:00Z"));
    expect(r.inside).toBe(true);
    expect(r.meta).toMatchObject({ state: "TX", timezone: "America/Chicago", local_hour: 9, window_start: 8, window_end: 20, tz_defaulted: false });
  });
  it("7am CT → outside (too early)", () => {
    expect(evaluateWorkingHours("TX", cfg(), new Date("2026-01-15T13:00:00Z")).inside).toBe(false);
  });
  it("8:00am exactly → inside (inclusive start)", () => {
    expect(evaluateWorkingHours("TX", cfg(), new Date("2026-01-15T14:00:00Z")).inside).toBe(true);
  });
  it("7:xx pm (hour 19) → inside (last hour can fire)", () => {
    expect(evaluateWorkingHours("TX", cfg(), new Date("2026-01-16T01:00:00Z")).inside).toBe(true);
  });
  it("8:00pm exactly (hour 20) → outside (exclusive end)", () => {
    expect(evaluateWorkingHours("TX", cfg(), new Date("2026-01-16T02:00:00Z")).inside).toBe(false);
  });
  it("TN 11pm CT → outside", () => {
    const r = evaluateWorkingHours("TN", cfg(), new Date("2026-01-16T05:00:00Z"));
    expect(r.inside).toBe(false);
    expect(r.meta.local_hour).toBe(23);
  });
});

describe("evaluateWorkingHours — day-of-week + unknown state", () => {
  it("excludes a day not in the allowed list (Sunday with weekdays-only)", () => {
    // 2026-01-18 is a Sunday; 9am CT, but days = Mon–Fri.
    const r = evaluateWorkingHours("TX", cfg({ days: [1, 2, 3, 4, 5] }), new Date("2026-01-18T15:00:00Z"));
    expect(r.inside).toBe(false);
    expect(r.meta.local_weekday).toBe(0);
  });
  it("unknown state defaults to CT and flags tz_defaulted", () => {
    const r = evaluateWorkingHours("ZZ", cfg(), new Date("2026-01-15T15:00:00Z"));
    expect(r.meta.timezone).toBe("America/Chicago");
    expect(r.meta.tz_defaulted).toBe(true);
    expect(r.inside).toBe(true);
  });
});

describe("parseWorkingHoursConfig", () => {
  it("returns operator defaults on empty env", () => {
    expect(parseWorkingHoursConfig({})).toEqual(DEFAULT_WORKING_HOURS);
  });
  it("parses custom values", () => {
    expect(parseWorkingHoursConfig({ start: "9", end: "18", days: "1,2,3,4,5" })).toEqual({
      enabled: true, startHour: 9, endHour: 18, days: [1, 2, 3, 4, 5],
    });
  });
  it("disables the gate only on explicit 'false'", () => {
    expect(parseWorkingHoursConfig({ enabled: "false" }).enabled).toBe(false);
    expect(parseWorkingHoursConfig({ enabled: "true" }).enabled).toBe(true);
    expect(parseWorkingHoursConfig({}).enabled).toBe(true);
  });
  it("falls back to defaults on invalid hours / days", () => {
    expect(parseWorkingHoursConfig({ start: "abc", end: "", days: "9,banana" })).toEqual(DEFAULT_WORKING_HOURS);
  });
});

// ─────────────────────────────────────────────────────────────────────
// SAFETY GATE (item 0): the non-disableable send-window floor.
// ─────────────────────────────────────────────────────────────────────

describe("effectiveSendWindow — env can NARROW, never widen/disable", () => {
  it("is always enabled (the floor can't be turned off)", () => {
    expect(effectiveSendWindow({ enabled: false, startHour: 8, endHour: 20, days: [0,1,2,3,4,5,6] }).enabled).toBe(true);
  });
  it("clamps a too-wide configured window back to the 8–20 floor", () => {
    const w = effectiveSendWindow({ enabled: true, startHour: 0, endHour: 24, days: [0,1,2,3,4,5,6] });
    expect(w.startHour).toBe(SEND_WINDOW_FLOOR.startHour); // 8
    expect(w.endHour).toBe(SEND_WINDOW_FLOOR.endHour); // 20
  });
  it("honors a NARROWER configured window (9–19)", () => {
    const w = effectiveSendWindow({ enabled: true, startHour: 9, endHour: 19, days: [1,2,3,4,5] });
    expect(w.startHour).toBe(9);
    expect(w.endHour).toBe(19);
    expect(w.days).toEqual([1,2,3,4,5]);
  });
  it("falls back to all-7 days on an empty days list", () => {
    expect(effectiveSendWindow({ enabled: true, startHour: 8, endHour: 20, days: [] }).days).toEqual(DEFAULT_WORKING_HOURS.days);
  });
});

describe("evaluateSendWindow — the universal pre-send guard", () => {
  // Texas property; 10am Central is INSIDE, 11pm Central is OUTSIDE.
  const tenAmCentral = new Date("2026-06-09T15:00:00Z"); // 10:00 CDT
  const elevenPmCentral = new Date("2026-06-10T04:00:00Z"); // 23:00 CDT

  it("allows a send at 10am local", () => {
    expect(evaluateSendWindow("TX", tenAmCentral, {} as NodeJS.ProcessEnv).inside).toBe(true);
  });
  it("BLOCKS a send at 11pm local", () => {
    expect(evaluateSendWindow("TX", elevenPmCentral, {} as NodeJS.ProcessEnv).inside).toBe(false);
  });
  it("BLOCKS at 11pm EVEN when env tries to disable the guard", () => {
    const r = evaluateSendWindow("TX", elevenPmCentral, { H2_WORKING_HOURS_ENABLED: "false" } as unknown as NodeJS.ProcessEnv);
    expect(r.inside).toBe(false); // the floor ignores the disable flag
  });
  it("BLOCKS at 11pm EVEN when env tries to widen to 24h", () => {
    const r = evaluateSendWindow("TX", elevenPmCentral, { H2_WORKING_HOURS_START: "0", H2_WORKING_HOURS_END: "24" } as unknown as NodeJS.ProcessEnv);
    expect(r.inside).toBe(false); // clamped back to 8–20
  });
  it("uses the property's own timezone (MI = Eastern)", () => {
    // 8:30pm Eastern = OUTSIDE for a Michigan property...
    const eightThirtyPmEastern = new Date("2026-06-10T00:30:00Z");
    expect(evaluateSendWindow("MI", eightThirtyPmEastern, {} as NodeJS.ProcessEnv).inside).toBe(false);
  });
});
