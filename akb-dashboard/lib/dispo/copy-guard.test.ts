import { describe, it, expect } from "vitest";
import { findBannedCopy, stripBannedCopy, guardBuyerCopy } from "./copy-guard";

describe("findBannedCopy", () => {
  it("detects off-market in every casing and separator form", () => {
    expect(findBannedCopy("This is Off-Market.")).toEqual(["Off-Market"]);
    expect(findBannedCopy("this is off market")).toEqual(["off market"]);
    expect(findBannedCopy("OFFMARKET deal")).toEqual(["OFFMARKET"]);
    expect(findBannedCopy("check out #offmarket for more")).toEqual(["offmarket"]);
  });

  it("detects 'not on the MLS' case-insensitively", () => {
    expect(findBannedCopy("It's not on the MLS.")).toEqual(["not on the MLS"]);
    expect(findBannedCopy("NOT ON THE MLS")).toEqual(["NOT ON THE MLS"]);
  });

  it("detects 'exclusive' as a whole word but not 'exclusively'", () => {
    expect(findBannedCopy("An exclusive deal")).toEqual(["exclusive"]);
    expect(findBannedCopy("EXCLUSIVE access")).toEqual(["EXCLUSIVE"]);
    expect(findBannedCopy("Handled exclusively by us")).toEqual([]);
  });

  it("detects 'you won't find this' with straight or curly apostrophe, or 'wont'", () => {
    expect(findBannedCopy("You won't find this anywhere else.")).toEqual(["You won't find this"]);
    expect(findBannedCopy("You won’t find this anywhere else.")).toEqual(["You won’t find this"]);
    expect(findBannedCopy("You wont find this anywhere else.")).toEqual(["You wont find this"]);
  });

  it("returns empty for clean text", () => {
    expect(findBannedCopy("Under contract, cash, as-is.")).toEqual([]);
  });

  it("finds multiple distinct hits in one string", () => {
    const hits = findBannedCopy("This off-market deal is exclusive and you won't find this elsewhere.");
    expect(hits).toEqual(["off-market", "exclusive", "you won't find this"]);
  });
});

describe("stripBannedCopy", () => {
  it("removes the match and leaves no double spaces", () => {
    const { text, hits } = stripBannedCopy("This exclusive deal won't last.");
    expect(hits).toEqual(["exclusive"]);
    expect(text).not.toMatch(/ {2,}/);
    expect(text).not.toContain("exclusive");
  });

  it("removes a trailing phrase before punctuation without leaving a stray space", () => {
    const { text } = stripBannedCopy("It's available off-market.");
    expect(text).not.toMatch(/ +[.,]/);
    expect(text.toLowerCase()).not.toContain("off-market");
    expect(text.toLowerCase()).not.toContain("off market");
  });

  it("returns the original text and empty hits when nothing is banned", () => {
    const input = "Cash, as-is, ready to close.";
    const result = stripBannedCopy(input);
    expect(result.hits).toEqual([]);
    expect(result.text).toBe(input);
  });

  it("collapses a blank line left behind by a removed phrase-only line", () => {
    const { text } = stripBannedCopy("Line one.\noff-market\nLine two.");
    expect(text.toLowerCase()).not.toContain("off-market");
    expect(text).not.toMatch(/\n{3,}/);
  });
});

describe("guardBuyerCopy", () => {
  it("throws under test env with the surface name in the message", () => {
    expect(() => guardBuyerCopy("This is off-market.", "public_deal.headline")).toThrow(
      /banned buyer copy on public_deal\.headline/,
    );
  });

  it("includes the matched hits in the thrown message", () => {
    expect(() => guardBuyerCopy("An exclusive off market deal.", "package.sms")).toThrow(/exclusive|off market/);
  });

  it("passes clean text through unchanged", () => {
    const clean = "Under contract, cash, as-is.";
    expect(guardBuyerCopy(clean, "public_deal.headline")).toBe(clean);
  });
});
