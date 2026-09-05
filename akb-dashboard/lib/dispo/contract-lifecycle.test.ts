import { describe, it, expect } from "vitest";
import { contractExecutedFields } from "./contract-lifecycle";

const NOW = new Date("2026-09-05T15:00:00Z");

describe("contractExecutedFields", () => {
  it("computes every clock from the executed date with defaults", () => {
    const r = contractExecutedFields({ contractPrice: 57_750, executedAt: "2026-09-05" }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fields).toEqual({
      Contract_Executed_At: "2026-09-05",
      Option_Deadline: "2026-09-15",
      EMD_Due_At: "2026-09-08",
      Close_Date: "2026-09-26",
      Contract_Offer_Price: 57_750,
      Assignment_Price: 67_750,
    });
    expect(r.summary).toContain("$57,750");
  });

  it("defaults executedAt to now and honors explicit option/close days + assignment", () => {
    const r = contractExecutedFields(
      { contractPrice: 105_000, assignmentPrice: 121_000, optionDays: 7, closeDays: 30 },
      NOW,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fields.Contract_Executed_At).toBe("2026-09-05");
    expect(r.fields.Option_Deadline).toBe("2026-09-12");
    expect(r.fields.Close_Date).toBe("2026-10-05");
    expect(r.fields.Assignment_Price).toBe(121_000);
  });

  it("does not drift a bare date across timezones or month ends", () => {
    const r = contractExecutedFields({ contractPrice: 50_000, executedAt: "2026-09-28" }, new Date("2026-09-28T03:00:00Z"));
    expect(r.ok && r.fields.Option_Deadline).toBe("2026-10-08");
  });

  it("refuses bad inputs", () => {
    expect(contractExecutedFields({ contractPrice: 0 }, NOW).ok).toBe(false);
    expect(contractExecutedFields({ contractPrice: null }, NOW).ok).toBe(false);
    expect(contractExecutedFields({ contractPrice: 50_000, executedAt: "nope" }, NOW).ok).toBe(false);
    expect(contractExecutedFields({ contractPrice: 50_000, executedAt: "2026-10-01" }, NOW).ok).toBe(false);
    expect(contractExecutedFields({ contractPrice: 50_000, optionDays: 90 }, NOW).ok).toBe(false);
    expect(contractExecutedFields({ contractPrice: 50_000, optionDays: 15, closeDays: 10 }, NOW).ok).toBe(false);
    expect(contractExecutedFields({ contractPrice: 50_000, assignmentPrice: 50_000 }, NOW).ok).toBe(false);
    expect(contractExecutedFields({ contractPrice: 50_000, assignmentPrice: -1 }, NOW).ok).toBe(false);
  });
});
