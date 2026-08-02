import { describe, it, expect } from "vitest";
import {
  judgeSubjectPrint,
  SUBJECT_PRINT_GUARD_PCT,
  SUBJECT_PRINT_WINDOW_MONTHS,
} from "./subject-history";

describe("9360 Cheyenne — the receipt this gate exists for", () => {
  it("fires RECENT PRINT CONFLICT on the exact numbers the operator caught by hand", () => {
    // Sold $45,000 on 2026-02-05 (public record). Our accepted $42,499 =
    // 94% of the freshest as-is print — the assignment spread could not
    // exist. Judged as of the day the opener was accepted.
    const v = judgeSubjectPrint({
      offerUsd: 42_499,
      listUsd: 49_999,
      saleUsd: 45_000,
      saleDateIso: "2026-02-05",
      asOfIso: "2026-07-12T15:00:49Z",
    });
    expect(v.kind).toBe("recent_print_conflict");
    expect(v.alert).toBe(true);
    expect(v.detail).toMatch(/94%/);
    expect(v.detail).toMatch(/9360 Cheyenne class/);
  });

  it("stays quiet when the offer sits honestly below the guard", () => {
    const justUnder = Math.floor(45_000 * SUBJECT_PRINT_GUARD_PCT) - 1;
    const v = judgeSubjectPrint({
      offerUsd: justUnder, // $38,249 at the default 0.85 guard
      listUsd: 49_999,
      saleUsd: 45_000,
      saleDateIso: "2026-02-05",
      asOfIso: "2026-07-12T15:00:49Z",
    });
    expect(v.kind).toBe("ok");
    expect(v.alert).toBe(false);
  });
});

describe("seller-underwater read", () => {
  it("flags an ask below the seller's own recent basis as a failing exit", () => {
    // A seller asking less than they paid five months ago is capitulating
    // in public — motivation signal, and the ask is not value evidence.
    const v = judgeSubjectPrint({
      offerUsd: 30_000, // well under the guard, so the conflict branch stays out of the way
      listUsd: 42_000,
      saleUsd: 45_000,
      saleDateIso: "2026-02-05",
      asOfIso: "2026-07-12T00:00:00Z",
    });
    expect(v.kind).toBe("seller_underwater");
    expect(v.alert).toBe(true);
    expect(v.detail).toMatch(/BELOW their own/);
  });
});

describe("honest boundaries", () => {
  it("a print outside the window is context, not a gate", () => {
    const monthsBeyond = SUBJECT_PRINT_WINDOW_MONTHS + 6;
    const old = new Date(Date.parse("2026-07-12") - monthsBeyond * 30.44 * 86_400_000).toISOString();
    const v = judgeSubjectPrint({
      offerUsd: 42_499,
      listUsd: 49_999,
      saleUsd: 45_000,
      saleDateIso: old,
      asOfIso: "2026-07-12T00:00:00Z",
    });
    expect(v.kind).toBe("ok");
    expect(v.alert).toBe(false);
    expect(v.detail).toMatch(/outside/);
  });

  it("reports no_history — never guesses — when the deed print is absent or malformed", () => {
    for (const [saleUsd, saleDateIso] of [
      [null, null],
      [45_000, null],
      [null, "2026-02-05"],
      [0, "2026-02-05"],
    ] as Array<[number | null, string | null]>) {
      const v = judgeSubjectPrint({
        offerUsd: 42_499,
        listUsd: 49_999,
        saleUsd,
        saleDateIso,
        asOfIso: "2026-07-12T00:00:00Z",
      });
      expect(v.kind).toBe("no_history");
      expect(v.alert).toBe(false);
      expect(v.detail).toMatch(/unverified/);
    }
  });

  it("a null offer with a fresh print still surfaces the underwater read, not a crash", () => {
    const v = judgeSubjectPrint({
      offerUsd: null,
      listUsd: 42_000,
      saleUsd: 45_000,
      saleDateIso: "2026-02-05",
      asOfIso: "2026-07-12T00:00:00Z",
    });
    expect(v.kind).toBe("seller_underwater");
  });
});
