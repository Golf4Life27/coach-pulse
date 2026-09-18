import { describe, it, expect } from "vitest";
import { formatDateOnly } from "./dates";

describe("formatDateOnly", () => {
  it("renders a date-only string without a timezone-induced day shift", () => {
    expect(formatDateOnly("2026-09-14")).toBe("Sep 14, 2026");
  });

  it("renders a full ISO datetime by its UTC calendar date", () => {
    expect(formatDateOnly("2026-09-14T03:00:00.000Z")).toBe("Sep 14, 2026");
  });

  it("returns 'not recorded' for null", () => {
    expect(formatDateOnly(null)).toBe("not recorded");
  });

  it("returns the raw string for unparseable input", () => {
    expect(formatDateOnly("not-a-date")).toBe("not-a-date");
  });
});
