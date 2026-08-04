import { describe, it, expect } from "vitest";
import {
  selectLastSeenWrites,
  LAST_SEEN_REFRESH_HOURS,
  LAST_SEEN_MAX_WRITES_PER_RUN,
} from "./last-seen";

const NOW = new Date("2026-08-04T23:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

describe("selectLastSeenWrites", () => {
  it("stamps a record the feed returned that has never been stamped", () => {
    expect(selectLastSeenWrites([{ id: "rec1", lastSeen: null }], NOW)).toEqual(["rec1"]);
    expect(selectLastSeenWrites([{ id: "rec1" }], NOW)).toEqual(["rec1"]);
  });

  it("skips a record stamped within the refresh window", () => {
    expect(selectLastSeenWrites([{ id: "rec1", lastSeen: hoursAgo(1) }], NOW)).toEqual([]);
    expect(selectLastSeenWrites([{ id: "rec1", lastSeen: hoursAgo(LAST_SEEN_REFRESH_HOURS - 1) }], NOW)).toEqual([]);
  });

  it("re-stamps once the record goes stale", () => {
    expect(selectLastSeenWrites([{ id: "rec1", lastSeen: hoursAgo(LAST_SEEN_REFRESH_HOURS + 1) }], NOW)).toEqual(["rec1"]);
  });

  it("treats an unparseable stamp as stale rather than stranding the row", () => {
    expect(selectLastSeenWrites([{ id: "rec1", lastSeen: "not-a-date" }], NOW)).toEqual(["rec1"]);
  });

  it("de-duplicates a record matched by more than one candidate", () => {
    const rows = [{ id: "rec1", lastSeen: null }, { id: "rec1", lastSeen: null }];
    expect(selectLastSeenWrites(rows, NOW)).toEqual(["rec1"]);
  });

  it("caps writes so one run cannot fire hundreds of PATCHes", () => {
    const many = Array.from({ length: LAST_SEEN_MAX_WRITES_PER_RUN + 50 }, (_, i) => ({
      id: `rec${i}`,
      lastSeen: null,
    }));
    expect(selectLastSeenWrites(many, NOW)).toHaveLength(LAST_SEEN_MAX_WRITES_PER_RUN);
  });

  it("in steady state writes almost nothing", () => {
    // The realistic shape: a ZIP re-crawled 10 minutes after the last run.
    const rows = Array.from({ length: 200 }, (_, i) => ({ id: `rec${i}`, lastSeen: hoursAgo(0.2) }));
    expect(selectLastSeenWrites(rows, NOW)).toEqual([]);
  });

  it("ignores rows with no record id", () => {
    expect(selectLastSeenWrites([{ id: "", lastSeen: null }], NOW)).toEqual([]);
  });
});
