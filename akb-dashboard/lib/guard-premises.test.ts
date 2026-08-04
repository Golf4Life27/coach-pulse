// GUARD PREMISES — the anti-rot check (2026-08-04).
//
// Two of the three defects found on 2026-08-04 were the SAME failure, and it
// is not a coding mistake:
//
//   - backfillPaid24hCeiling = 60 was correct when the sweep fired every 5
//     minutes (288 runs/day). Cadence later moved to */30 (48 runs/day). The
//     ceiling stayed and silently locked the sweep out for 24h+.
//   - INACTIVE_MARKERS dropped "off market"/"sold on" because the scan was
//     FULL-PAGE and matched comps boilerplate. scopeStatusText later started
//     stripping comps + history. The exclusion stayed and let a delisted
//     house get a $35,250 offer.
//
// In both cases a guard encoded a CONSTANT that was right for a CONDITION,
// the condition moved, and nothing tied the two together. The existing tests
// made it worse, not better: they assert the constant (`expect(ceiling)
// .toBe(60)`), so the suite actively defends the stale value. A green suite
// is not evidence a guard is still correct — it is evidence nobody wrote
// down WHY the number was chosen.
//
// This file asserts PREMISES, not values. Change a constant deliberately and
// these still pass; let the world drift out from under one and they fail with
// the reason attached. Add an entry here whenever a guard's justification is
// a fact about something else in the system.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { backfillPaid24hCeiling } from "@/app/api/admin/appraiser-backfill/route";
import { detectStillActive } from "@/lib/crawler/sources/firecrawl";
import { scopeStatusText } from "@/lib/crawler/sources/listing-text-scope";

function cronSchedules(path: string): string[] {
  const vercel = JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8")) as {
    crons?: Array<{ path: string; schedule: string }>;
  };
  return (vercel.crons ?? []).filter((c) => c.path.startsWith(path)).map((c) => c.schedule);
}

/** Runs per day implied by the subset of cron syntax this repo actually uses:
 *  "m h * * *" (daily), "m/N * * * *" or "*\/N * * * *" (every N minutes),
 *  "m *\/N * * *" (every N hours), "m * * * *" (hourly). */
function runsPerDay(schedule: string): number {
  const [min, hour] = schedule.split(/\s+/);
  const perHour = min.startsWith("*/") ? 60 / Number(min.slice(2)) : 1;
  if (hour === "*") return perHour * 24;
  if (hour.startsWith("*/")) return perHour * (24 / Number(hour.slice(2)));
  return perHour;
}

describe("GUARD PREMISE — appraiser-backfill paid-call ceiling", () => {
  // The ceiling exists to stop a runaway. Its SIZE was chosen against a
  // specific cadence. If the cadence drops but the ceiling doesn't, the sweep
  // stops being throttled and starts being BLOCKED — which is what happened.
  it("the ceiling still admits at least one full run of the current cadence", () => {
    const schedules = cronSchedules("/api/admin/appraiser-backfill");
    expect(schedules.length).toBeGreaterThan(0);

    const limit = 3; // the `limit=` in the cron URL below
    const worstCaseCallsPerRecord = 4; // up to 3 RentCast (2 photo + 1 rent) + 1 ATTOM
    const perRun = limit * worstCaseCallsPerRecord;

    // A ceiling below one run's worth means the sweep can never do useful
    // work once anything else on the shared meter has spent.
    expect(
      backfillPaid24hCeiling(),
      "backfill ceiling is below a single run's worst-case spend — the sweep can only ever no-op",
    ).toBeGreaterThanOrEqual(perRun);
  });

  it("the cron URL still carries the limit this premise assumes", () => {
    const vercel = JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8")) as {
      crons?: Array<{ path: string }>;
    };
    const p = (vercel.crons ?? []).find((c) => c.path.startsWith("/api/admin/appraiser-backfill"));
    expect(p?.path, "appraiser-backfill cron lost its limit= param; the ceiling premise above is now unanchored").toContain("limit=");
  });

  it("records the cadence the ceiling was sized against (fails loudly if it moves)", () => {
    const runs = cronSchedules("/api/admin/appraiser-backfill").map(runsPerDay);
    // 2026-07-29 the ceiling of 60 was set against 288 runs/day (*/5).
    // 2026-08-04 the cadence is 48/day (*/30). If this changes again, re-derive
    // the ceiling rather than inheriting a number sized for another world.
    expect(runs.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(48);
  });
});

describe("GUARD PREMISE — off-market marker scan is no longer full-page", () => {
  // Bare "off market"/"sold on" were excluded because a FULL-PAGE scan matched
  // comps boilerplate. That exclusion is only justified while the scan is
  // full-page. scopeStatusText now strips comps + history, so the premise for
  // the exclusion is gone — this pins that the stripping actually works, which
  // is the precondition for ever re-adding the bare phrases.
  const PAGE = [
    "# 123 Main St",
    "For sale $89,000",
    "## Nearby similar homes",
    "456 Other St — off market",
    "## Sale & Tax History",
    "05/12/2019 Sold $41,000",
  ].join("\n");

  it("comps and sale-history text are stripped from the status scan", () => {
    const scoped = scopeStatusText(PAGE);
    expect(scoped).not.toContain("456 Other St");
    expect(scoped).not.toContain("Sold $41,000");
    expect(scoped).toContain("For sale");
  });

  it("a live listing carrying off-market comps is still ACTIVE", () => {
    expect(detectStillActive(scopeStatusText(PAGE))).toBe(true);
  });

  it("subject-scoped markers survive the scoping (they are the real signal)", () => {
    const dead = "# 123 Main St\nThis home is not currently listed for sale.\n## Sale & Tax History\n05/12/2019 Sold $41,000";
    expect(detectStillActive(scopeStatusText(dead))).toBe(false);
  });
});
