import { describe, it, expect } from "vitest";
import { fixNoteTimestamp } from "./timeline-fixups";

describe("fixNoteTimestamp", () => {
  it("prefers the embedded sync-metadata ts= (the Ivy Bend class)", () => {
    const entry = {
      text: "Seller is not interested [Quo inbound msg MSGsynthetic0001 ts=2026-05-12T18:10:28.212Z src=quo_hist_sweep ingested_at=2026-06-07T22:49:14.905Z]",
      timestamp: "2001-05-12T00:00:00.000Z", // the year-less "5/12" parse artifact
    };
    expect(fixNoteTimestamp(entry)).toBe("2026-05-12T18:10:28.212Z");
  });

  it("nulls fabricated pre-2015 parses — undated beats a false date", () => {
    expect(fixNoteTimestamp({ text: "5/12 — called agent, no answer", timestamp: "2001-05-12T00:00:00.000Z" })).toBeNull();
    expect(fixNoteTimestamp({ text: "junk", timestamp: "not-a-date" })).toBeNull();
  });

  it("passes plausible timestamps through untouched", () => {
    expect(fixNoteTimestamp({ text: "note without metadata", timestamp: "2026-07-08T14:00:00Z" })).toBe("2026-07-08T14:00:00Z");
    expect(fixNoteTimestamp({ text: "no ts anywhere", timestamp: null })).toBeNull();
  });
});
