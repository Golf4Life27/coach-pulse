import { describe, it, expect } from "vitest";
import {
  buildReplyClassificationFields,
  buildReplyClassificationFieldsById,
  isClassificationMissing,
  REPLY_CLASSIFICATION_FIELD_IDS,
} from "./reply-classification";

const triage = { classification: "counter" as const, decisionKind: "pricing" as const };

describe("buildReplyClassificationFields", () => {
  it("stamps the INBOUND's own time, not now — a backfill must not relabel history", () => {
    const f = buildReplyClassificationFields(triage, "2026-06-01T12:00:00.000Z");
    expect(f.Reply_Classification).toBe("counter");
    expect(f.Reply_Decision_Kind).toBe("pricing");
    expect(f.Reply_Classified_At).toBe("2026-06-01T12:00:00.000Z");
  });

  it("falls back to now rather than refusing to record the label", () => {
    for (const bad of [null, undefined, "", "not-a-date"]) {
      const f = buildReplyClassificationFields(triage, bad);
      expect(f.Reply_Classification).toBe("counter");
      expect(Number.isFinite(Date.parse(f.Reply_Classified_At))).toBe(true);
    }
  });

  it("the id-keyed variant carries the same three values", () => {
    const byId = buildReplyClassificationFieldsById(triage, "2026-06-01T12:00:00.000Z");
    expect(byId[REPLY_CLASSIFICATION_FIELD_IDS.classification]).toBe("counter");
    expect(byId[REPLY_CLASSIFICATION_FIELD_IDS.decisionKind]).toBe("pricing");
    expect(byId[REPLY_CLASSIFICATION_FIELD_IDS.classifiedAt]).toBe("2026-06-01T12:00:00.000Z");
  });
});

describe("isClassificationMissing", () => {
  it("flags exactly the 2026-07-31 hole: a reply with no persisted label", () => {
    expect(isClassificationMissing({ lastInboundAt: "2026-06-01", replyClassification: null })).toBe(true);
  });
  it("does not flag a classified reply, or a record that never replied", () => {
    expect(isClassificationMissing({ lastInboundAt: "2026-06-01", replyClassification: "interest" })).toBe(false);
    expect(isClassificationMissing({ lastInboundAt: null, replyClassification: null })).toBe(false);
  });
});
