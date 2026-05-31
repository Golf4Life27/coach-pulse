import { describe, it, expect } from "vitest";
import { parseZipApprovalReply } from "./reply-parser";

describe("parseZipApprovalReply", () => {
  it("parses canonical YES [ZIP]", () => {
    expect(parseZipApprovalReply("YES 78201")).toEqual({ decision: "approve", zip: "78201" });
  });

  it("parses canonical NO [ZIP]", () => {
    expect(parseZipApprovalReply("NO 78201")).toEqual({ decision: "reject", zip: "78201" });
  });

  it("is case-insensitive and whitespace-tolerant", () => {
    expect(parseZipApprovalReply("  yes   38109  ")).toEqual({ decision: "approve", zip: "38109" });
    expect(parseZipApprovalReply("no\t75216")).toEqual({ decision: "reject", zip: "75216" });
  });

  it("accepts single-letter Y/N tokens", () => {
    expect(parseZipApprovalReply("Y 77021")).toEqual({ decision: "approve", zip: "77021" });
    expect(parseZipApprovalReply("N 77021")).toEqual({ decision: "reject", zip: "77021" });
  });

  it("accepts approve/reject verbs", () => {
    expect(parseZipApprovalReply("approve 78207")).toEqual({ decision: "approve", zip: "78207" });
    expect(parseZipApprovalReply("reject 78207")).toEqual({ decision: "reject", zip: "78207" });
  });

  it("tolerates surrounding chatter as long as one decision + zip is present", () => {
    expect(parseZipApprovalReply("yes go ahead with 78210 please")).toEqual({
      decision: "approve",
      zip: "78210",
    });
  });

  it("tolerates zip-first ordering", () => {
    expect(parseZipApprovalReply("78210 yes")).toEqual({ decision: "approve", zip: "78210" });
  });

  it("returns null with no ZIP", () => {
    expect(parseZipApprovalReply("yes")).toBeNull();
    expect(parseZipApprovalReply("sure go for it")).toBeNull();
  });

  it("returns null when both YES and NO tokens appear (ambiguous)", () => {
    expect(parseZipApprovalReply("yes no 78201")).toBeNull();
  });

  it("returns null when no decision token appears", () => {
    expect(parseZipApprovalReply("78201")).toBeNull();
    expect(parseZipApprovalReply("what about 78201?")).toBeNull();
  });

  it("returns null on empty / non-string input", () => {
    expect(parseZipApprovalReply("")).toBeNull();
    expect(parseZipApprovalReply("   ")).toBeNull();
    // @ts-expect-error exercising defensive runtime guard
    expect(parseZipApprovalReply(null)).toBeNull();
  });

  it("does not treat a 5-digit fragment of a longer number as a ZIP", () => {
    // 9-digit string has no standalone 5-digit word boundary match start/end
    expect(parseZipApprovalReply("yes 782015551")).toBeNull();
  });
});
