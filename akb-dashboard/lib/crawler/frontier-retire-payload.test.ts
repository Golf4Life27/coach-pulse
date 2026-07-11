import { describe, it, expect } from "vitest";
import { parseFrontierRetirePayload } from "./frontier-governor";

describe("parseFrontierRetirePayload", () => {
  it("parses the payload the frontier-rotation pass writes", () => {
    const raw = JSON.stringify({
      recordId: "recCQVABrlJrpGFvp",
      action: "frontier_retire",
      zip: "77051",
    });
    expect(parseFrontierRetirePayload(raw)).toEqual({
      recordId: "recCQVABrlJrpGFvp",
      zip: "77051",
    });
  });

  it("refuses other actions, malformed ids/zips, and junk (fail closed)", () => {
    expect(
      parseFrontierRetirePayload(JSON.stringify({ recordId: "recCQVABrlJrpGFvp", action: "h2_opener_hold", zip: "77051" })),
    ).toBeNull();
    expect(
      parseFrontierRetirePayload(JSON.stringify({ recordId: "not-a-rec", action: "frontier_retire", zip: "77051" })),
    ).toBeNull();
    expect(
      parseFrontierRetirePayload(JSON.stringify({ recordId: "recCQVABrlJrpGFvp", action: "frontier_retire", zip: "7705" })),
    ).toBeNull();
    expect(parseFrontierRetirePayload("{broken")).toBeNull();
    expect(parseFrontierRetirePayload(null)).toBeNull();
    expect(parseFrontierRetirePayload("")).toBeNull();
  });
});
