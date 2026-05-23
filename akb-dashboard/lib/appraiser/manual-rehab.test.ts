// INV-005 — Manual rehab pure-helper tests.

import { describe, it, expect } from "vitest";
import {
  validateManualRehabPayload,
  buildManualRehabAirtableFields,
  buildManualRehabNoteLine,
  isManualRehabSource,
  MANUAL_REHAB_CONFIDENCE_SCORE,
} from "./manual-rehab";

describe("validateManualRehabPayload", () => {
  it("accepts mid + source with low/high auto-banded", () => {
    const r = validateManualRehabPayload({
      rehab_mid: 25000,
      source: "manual_operator",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.rehabMid).toBe(25000);
    expect(r.value.rehabLow).toBe(20000); // 25000 * 0.8
    expect(r.value.rehabHigh).toBe(30000); // 25000 * 1.2
    expect(r.value.source).toBe("manual_operator");
  });

  it("accepts explicit low + high overriding auto-band", () => {
    const r = validateManualRehabPayload({
      rehab_mid: 25000,
      rehab_low: 15000,
      rehab_high: 40000,
      source: "manual_partner",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.rehabLow).toBe(15000);
    expect(r.value.rehabHigh).toBe(40000);
  });

  it("coerces numeric strings (form-input shape)", () => {
    const r = validateManualRehabPayload({
      rehab_mid: "25000",
      source: "manual_operator",
    });
    expect(r.ok).toBe(true);
  });

  it("rejects missing rehab_mid", () => {
    const r = validateManualRehabPayload({
      rehab_mid: undefined,
      source: "manual_operator",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.error).toBe("missing_rehab_mid");
  });

  it("rejects negative rehab_mid", () => {
    const r = validateManualRehabPayload({
      rehab_mid: -100,
      source: "manual_operator",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.error).toBe("invalid_rehab_mid");
  });

  it("rejects zero rehab_mid", () => {
    const r = validateManualRehabPayload({
      rehab_mid: 0,
      source: "manual_operator",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects non-numeric rehab_mid", () => {
    const r = validateManualRehabPayload({
      rehab_mid: "not-a-number",
      source: "manual_operator",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.error).toBe("invalid_rehab_mid");
  });

  it("rejects low > mid", () => {
    const r = validateManualRehabPayload({
      rehab_mid: 20000,
      rehab_low: 25000,
      source: "manual_operator",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.error).toBe("invalid_rehab_band");
  });

  it("rejects high < mid", () => {
    const r = validateManualRehabPayload({
      rehab_mid: 30000,
      rehab_high: 25000,
      source: "manual_operator",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.error).toBe("invalid_rehab_band");
  });

  it("rejects missing source", () => {
    const r = validateManualRehabPayload({
      rehab_mid: 25000,
      source: undefined,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.error).toBe("missing_source");
  });

  it("rejects invalid source values (no 'vision' on manual route)", () => {
    const r = validateManualRehabPayload({
      rehab_mid: 25000,
      source: "vision",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.error).toBe("invalid_source");
  });

  it("rejects bogus source strings", () => {
    const r = validateManualRehabPayload({
      rehab_mid: 25000,
      source: "manual_alien",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.error).toBe("invalid_source");
  });
});

describe("isManualRehabSource", () => {
  it("recognizes the two manual source values", () => {
    expect(isManualRehabSource("manual_operator")).toBe(true);
    expect(isManualRehabSource("manual_partner")).toBe(true);
  });

  it("excludes the vision-only source value", () => {
    expect(isManualRehabSource("vision")).toBe(false);
  });
});

describe("buildManualRehabAirtableFields", () => {
  it("writes Est_Rehab + Mid/Low/High + Rehab_Source + manual confidence", () => {
    const fields = buildManualRehabAirtableFields(
      {
        rehabMid: 25000,
        rehabLow: 20000,
        rehabHigh: 30000,
        source: "manual_operator",
      },
      "2026-05-23T12:00:00.000Z",
    );
    expect(fields.Est_Rehab).toBe(25000);
    expect(fields.Est_Rehab_Mid).toBe(25000);
    expect(fields.Est_Rehab_Low).toBe(20000);
    expect(fields.Est_Rehab_High).toBe(30000);
    expect(fields.Rehab_Source).toBe("manual_operator");
    expect(fields.Rehab_Confidence_Score).toBe(MANUAL_REHAB_CONFIDENCE_SCORE);
    expect(fields.Rehab_Estimated_At).toBe("2026-05-23T12:00:00.000Z");
    expect(fields.Rehab_Red_Flags).toBe("");
  });

  it("encodes minimal manual envelope in Rehab_Line_Items_JSON", () => {
    const fields = buildManualRehabAirtableFields(
      {
        rehabMid: 25000,
        rehabLow: 20000,
        rehabHigh: 30000,
        source: "manual_partner",
      },
      "2026-05-23T12:00:00.000Z",
    );
    const parsed = JSON.parse(fields.Rehab_Line_Items_JSON as string);
    expect(parsed.source).toBe("manual");
    expect(parsed.entered_by).toBe("manual_partner");
    expect(parsed.rehab_mid).toBe(25000);
  });
});

describe("buildManualRehabNoteLine", () => {
  it("emits a Notes line with INV-005 marker + source + mid", () => {
    const line = buildManualRehabNoteLine(new Date("2026-05-23T18:30:00Z"), {
      rehabMid: 25000,
      rehabLow: 20000,
      rehabHigh: 30000,
      source: "manual_operator",
    });
    expect(line).toContain("INV-005");
    expect(line).toContain("manual_operator");
    expect(line).toContain("25,000");
  });
});
