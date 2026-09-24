import { describe, expect, it, vi, beforeEach } from "vitest";

const updateListingRecordMock = vi.fn(async (..._args: [string, Record<string, unknown>]) => [] as unknown[]);
const getListingMock = vi.fn(async (..._args: [string]) => null as unknown);

vi.mock("@/lib/airtable", () => ({
  updateListingRecord: (...args: [string, Record<string, unknown>]) => updateListingRecordMock(...args),
  getListing: (...args: [string]) => getListingMock(...args),
}));

import { markRecordDead } from "./mark-dead";

const NOW = new Date("2026-09-24T12:00:00.000Z");

describe("markRecordDead", () => {
  beforeEach(() => {
    updateListingRecordMock.mockClear();
    getListingMock.mockClear();
  });

  it("refuses and writes nothing when the record has Contract_Executed_At set", async () => {
    const result = await markRecordDead("recExecuted1", "14+ days silent", {
      now: NOW,
      record: { notes: "some notes", contractExecutedAt: "2026-08-01" },
    });
    expect(result).toEqual({
      ok: false,
      refused: true,
      reason: expect.stringContaining("contract_executed_at_set"),
    });
    expect(updateListingRecordMock).not.toHaveBeenCalled();
  });

  it("writes Outreach_Status=Dead and appends a dated reason line when unsigned", async () => {
    const result = await markRecordDead("recUnsigned1", "14+ days silent (Last_Inbound_At)", {
      now: NOW,
      record: { notes: "2026-09-01 — first contact", contractExecutedAt: null },
    });
    expect(result).toEqual({ ok: true });
    expect(updateListingRecordMock).toHaveBeenCalledTimes(1);
    const [recordId, fields] = updateListingRecordMock.mock.calls[0]!;
    expect(recordId).toBe("recUnsigned1");
    expect(fields).toMatchObject({ Outreach_Status: "Dead" });
    expect(fields!.Verification_Notes).toBe(
      "2026-09-01 — first contact\n2026-09-24 — Death rule: 14+ days silent (Last_Inbound_At)",
    );
  });

  it("starts fresh notes (no leading newline) when Verification_Notes was empty", async () => {
    await markRecordDead("recUnsigned2", "silent", {
      now: NOW,
      record: { notes: null, contractExecutedAt: null },
    });
    const [, fields] = updateListingRecordMock.mock.calls[0]!;
    expect(fields!.Verification_Notes).toBe("2026-09-24 — Death rule: silent");
  });

  it("refuses when the record cannot be found (no opts.record, live fetch returns null)", async () => {
    getListingMock.mockResolvedValueOnce(null);
    const result = await markRecordDead("recMissing", "silent", { now: NOW });
    expect(result).toEqual({ ok: false, refused: true, reason: "record_not_found" });
    expect(updateListingRecordMock).not.toHaveBeenCalled();
  });

  it("falls back to a live getListing fetch when opts.record is omitted", async () => {
    getListingMock.mockResolvedValueOnce({ notes: "x", contractExecutedAt: null });
    const result = await markRecordDead("recLive", "silent", { now: NOW });
    expect(getListingMock).toHaveBeenCalledWith("recLive");
    expect(result).toEqual({ ok: true });
  });
});
