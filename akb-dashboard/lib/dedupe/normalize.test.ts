// Sprint R / Phase B.5 — Dedupe normalization + pipeline tests.
//
// Covers the six required test cases from the sprint brief:
//   1. exact match removal
//   2. punctuation variance match removal
//   3. directional variance ("N" vs "NORTH")
//   4. zip-only collision (different streets, same zip — NOT a match)
//   5. empty CSV
//   6. Airtable API failure (degrade gracefully — return raw CSV
//      with warning, do NOT block export)
//
// Plus a few boundary cases that surfaced while writing (empty
// inputs, whitespace, unit numbers).

import { describe, it, expect } from "vitest";
import {
  buildAddressKey,
  dedupeRows,
  normalizeAddress,
  readDedupeWindowDays,
  runDedupePipeline,
  type PropStreamRow,
} from "./normalize";

function row(street: string, zip: string): PropStreamRow {
  return { raw: { street, zip }, street, zip };
}

describe("normalizeAddress", () => {
  it("lowercases + collapses whitespace", () => {
    expect(normalizeAddress("  1219 E HIGHLAND BLVD  ")).toBe("1219 e highland blvd");
    expect(normalizeAddress("100\tMain  Street")).toBe("100 main street");
  });

  it("strips punctuation", () => {
    expect(normalizeAddress("1219 E. Highland Blvd.")).toBe("1219 e highland blvd");
    expect(normalizeAddress("100 Main St., Apt #4")).toBe("100 main st apt 4");
    expect(normalizeAddress("123 O'Brien St")).toBe("123 obrien st");
  });

  it('normalizes directionals ("NORTH" → "n", "EAST" → "e", etc.)', () => {
    expect(normalizeAddress("100 NORTH Main")).toBe("100 n main");
    expect(normalizeAddress("100 North Main")).toBe("100 n main");
    expect(normalizeAddress("100 N Main")).toBe("100 n main");
    expect(normalizeAddress("100 Northwest 5th")).toBe("100 nw 5th");
    expect(normalizeAddress("100 NORTHWEST 5th")).toBe("100 nw 5th");
  });

  it("preserves hyphens (unit numbers like 1219-A)", () => {
    expect(normalizeAddress("1219-A Main St")).toBe("1219-a main st");
  });

  it("empty / null inputs return empty string", () => {
    expect(normalizeAddress("")).toBe("");
    expect(normalizeAddress(null)).toBe("");
    expect(normalizeAddress(undefined)).toBe("");
    expect(normalizeAddress("   ")).toBe("");
  });
});

describe("buildAddressKey", () => {
  it("joins normalized street + zip with pipe", () => {
    expect(buildAddressKey("1219 E Highland Blvd", "78210")).toBe(
      "1219 e highland blvd|78210",
    );
  });

  it("treats directional variance as equivalent", () => {
    // The 1219 E Highland anchor — long form + short form produce
    // the same key.
    const a = buildAddressKey("1219 E Highland Blvd", "78210");
    const b = buildAddressKey("1219 EAST HIGHLAND BLVD", "78210");
    expect(a).toBe(b);
  });

  it("treats punctuation variance as equivalent", () => {
    const a = buildAddressKey("100 Main St.", "78210");
    const b = buildAddressKey("100 Main St", "78210");
    expect(a).toBe(b);
  });

  it("empty street or zip returns empty key", () => {
    expect(buildAddressKey("", "78210")).toBe("");
    expect(buildAddressKey("100 Main", "")).toBe("");
    expect(buildAddressKey(null, null)).toBe("");
  });
});

describe("dedupeRows (sprint brief test cases)", () => {
  it("1. exact-match removal — single duplicate dedupes", () => {
    const existing = new Set(["1219 e highland blvd|78210"]);
    const rows = [row("1219 E Highland Blvd", "78210")];
    const out = dedupeRows(rows, existing);
    expect(out.passed).toHaveLength(0);
    expect(out.duplicates).toHaveLength(1);
    expect(out.duplicates[0].street).toBe("1219 E Highland Blvd");
  });

  it("2. punctuation-variance removal", () => {
    const existing = new Set(["100 main st|78210"]);
    const rows = [row("100 Main St.", "78210"), row("100 MAIN ST", "78210")];
    const out = dedupeRows(rows, existing);
    expect(out.passed).toHaveLength(0);
    expect(out.duplicates).toHaveLength(2);
  });

  it("3. directional-variance removal (N vs NORTH)", () => {
    const existing = new Set(["100 n elm|75201"]);
    const rows = [
      row("100 N Elm", "75201"),
      row("100 NORTH ELM", "75201"),
      row("100 north elm", "75201"),
    ];
    const out = dedupeRows(rows, existing);
    expect(out.passed).toHaveLength(0);
    expect(out.duplicates).toHaveLength(3);
  });

  it("4. zip-only collision is NOT a match (different streets, same zip)", () => {
    const existing = new Set(["100 main st|78210"]);
    const rows = [
      row("200 Oak Ln", "78210"), // different street, same zip
      row("300 Pine Ave", "78210"), // different street, same zip
    ];
    const out = dedupeRows(rows, existing);
    expect(out.passed).toHaveLength(2);
    expect(out.duplicates).toHaveLength(0);
  });

  it("5. empty rows array → empty result", () => {
    expect(dedupeRows([], new Set())).toEqual({
      passed: [],
      duplicates: [],
      unusable: [],
    });
  });

  it("rows with empty street/zip → unusable (preserved separately for audit)", () => {
    const rows = [row("", "78210"), row("100 Main", "")];
    const out = dedupeRows(rows, new Set());
    expect(out.passed).toHaveLength(0);
    expect(out.duplicates).toHaveLength(0);
    expect(out.unusable).toHaveLength(2);
  });

  it("different zip on same street is NOT a match (cross-state same address)", () => {
    const existing = new Set(["100 main st|78210"]);
    const rows = [row("100 Main St", "38103")];
    const out = dedupeRows(rows, existing);
    expect(out.passed).toHaveLength(1);
    expect(out.duplicates).toHaveLength(0);
  });

  it("rerun against itself — anchor: 1219 E Highland dedupes after first run", () => {
    // Done When: "1219 E Highland 78210 dedupes against itself if rerun"
    const firstRun = dedupeRows([row("1219 E Highland Blvd", "78210")], new Set());
    expect(firstRun.passed).toHaveLength(1);

    // Operator commits to Airtable; existing keys now includes it.
    const existing = new Set([
      buildAddressKey(firstRun.passed[0].street, firstRun.passed[0].zip),
    ]);
    const rerun = dedupeRows([row("1219 E Highland Blvd", "78210")], existing);
    expect(rerun.passed).toHaveLength(0);
    expect(rerun.duplicates).toHaveLength(1);
  });
});

describe("runDedupePipeline — pipeline composition", () => {
  it("happy path: fetcher returns keys, rows dedupe correctly", async () => {
    const out = await runDedupePipeline(
      [row("100 Main", "78210"), row("200 Oak", "78210")],
      {
        fetchExistingKeys: async () => new Set(["100 main|78210"]),
      },
    );
    expect(out.status).toBe("ok");
    expect(out.passed).toHaveLength(1);
    expect(out.duplicates).toHaveLength(1);
    expect(out.warning).toBeUndefined();
  });

  it("6. Airtable API failure → soft-fail, all rows pass through with warning", async () => {
    const out = await runDedupePipeline(
      [row("100 Main", "78210"), row("200 Oak", "78210")],
      {
        fetchExistingKeys: async () => {
          throw new Error("airtable 500");
        },
      },
    );
    expect(out.status).toBe("soft_failed_airtable");
    expect(out.passed).toHaveLength(2); // ALL rows passed through unfiltered
    expect(out.duplicates).toHaveLength(0);
    expect(out.warning).toContain("airtable 500");
  });

  it("empty input → empty result regardless of fetcher", async () => {
    const out = await runDedupePipeline([], {
      fetchExistingKeys: async () => new Set(["100 main|78210"]),
    });
    expect(out.passed).toEqual([]);
    expect(out.duplicates).toEqual([]);
  });
});

describe("readDedupeWindowDays", () => {
  it("defaults to 90 when env unset", () => {
    expect(readDedupeWindowDays({})).toBe(90);
  });

  it("respects DEDUPE_WINDOW_DAYS env override", () => {
    expect(readDedupeWindowDays({ DEDUPE_WINDOW_DAYS: "30" })).toBe(30);
    expect(readDedupeWindowDays({ DEDUPE_WINDOW_DAYS: "180" })).toBe(180);
  });

  it("ignores invalid values, falls back to default", () => {
    expect(readDedupeWindowDays({ DEDUPE_WINDOW_DAYS: "abc" })).toBe(90);
    expect(readDedupeWindowDays({ DEDUPE_WINDOW_DAYS: "-1" })).toBe(90);
    expect(readDedupeWindowDays({ DEDUPE_WINDOW_DAYS: "0" })).toBe(90);
  });
});
