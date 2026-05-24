// Phase 14.6 / Q.2 — family-time classifier tests.

import { describe, it, expect } from "vitest";
import {
  classifyFamilyTime,
  readClock,
  readFamilyTimeRules,
  type FamilyTimeRules,
} from "./family-time";

const DEFAULT_RULES: FamilyTimeRules = {
  weekday_end_hour: 18,
  weekday_start_hour: 7,
  weekends_family: true,
  timezone: "America/Chicago",
};

describe("readFamilyTimeRules", () => {
  it("defaults when env unset", () => {
    expect(readFamilyTimeRules({})).toEqual(DEFAULT_RULES);
  });

  it("respects MAVERICK_FAMILY_END_HOUR override", () => {
    expect(readFamilyTimeRules({ MAVERICK_FAMILY_END_HOUR: "20" }).weekday_end_hour).toBe(20);
  });

  it("respects MAVERICK_TZ override", () => {
    expect(readFamilyTimeRules({ MAVERICK_TZ: "America/Los_Angeles" }).timezone).toBe(
      "America/Los_Angeles",
    );
  });

  it("disables weekend-family when MAVERICK_WEEKENDS_FAMILY=false", () => {
    expect(
      readFamilyTimeRules({ MAVERICK_WEEKENDS_FAMILY: "false" }).weekends_family,
    ).toBe(false);
  });

  it("ignores invalid hour values", () => {
    expect(readFamilyTimeRules({ MAVERICK_FAMILY_END_HOUR: "99" }).weekday_end_hour).toBe(18);
    expect(readFamilyTimeRules({ MAVERICK_FAMILY_END_HOUR: "-1" }).weekday_end_hour).toBe(18);
    expect(readFamilyTimeRules({ MAVERICK_FAMILY_END_HOUR: "abc" }).weekday_end_hour).toBe(18);
  });
});

describe("readClock", () => {
  it("returns weekday + hour in operator timezone", () => {
    // 2026-05-19 03:00:00Z = Tue 22:00 CDT (UTC-5) on May 18
    const at = new Date("2026-05-19T03:00:00Z");
    const c = readClock(at, "America/Chicago");
    expect(c.weekday).toBe(1); // Monday in Chicago
    expect(c.hour).toBe(22);
  });

  it("handles UTC timezone correctly", () => {
    const at = new Date("2026-05-19T15:00:00Z");
    const c = readClock(at, "UTC");
    expect(c.hour).toBe(15);
  });
});

describe("classifyFamilyTime", () => {
  it("weekend → family-time (with default rules)", () => {
    // 2026-05-23 = Saturday
    const at = new Date("2026-05-23T15:00:00Z");
    const result = classifyFamilyTime(at, DEFAULT_RULES);
    expect(result.is_family_time).toBe(true);
    expect(result.reason).toBe("weekend");
  });

  it("weekday after 6pm → family-time", () => {
    // 2026-05-20 = Wednesday; 23:00 UTC = 18:00 CDT
    const at = new Date("2026-05-20T23:00:00Z");
    const result = classifyFamilyTime(at, DEFAULT_RULES);
    expect(result.is_family_time).toBe(true);
    expect(result.reason).toBe("after_hours");
  });

  it("weekday before 7am → family-time", () => {
    // 2026-05-20 = Wednesday; 09:00 UTC = 04:00 CDT
    const at = new Date("2026-05-20T09:00:00Z");
    const result = classifyFamilyTime(at, DEFAULT_RULES);
    expect(result.is_family_time).toBe(true);
    expect(result.reason).toBe("before_hours");
  });

  it("weekday work hours → work-time", () => {
    // 2026-05-20 = Wednesday; 15:00 UTC = 10:00 CDT
    const at = new Date("2026-05-20T15:00:00Z");
    const result = classifyFamilyTime(at, DEFAULT_RULES);
    expect(result.is_family_time).toBe(false);
    expect(result.reason).toBe("work_hours");
  });

  it("weekends_family=false → weekend treated as work-time", () => {
    const at = new Date("2026-05-23T15:00:00Z"); // Saturday 10am CDT
    const result = classifyFamilyTime(at, { ...DEFAULT_RULES, weekends_family: false });
    expect(result.is_family_time).toBe(false);
    expect(result.reason).toBe("work_hours");
  });
});
