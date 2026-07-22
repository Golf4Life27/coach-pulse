// Pure tests for H2 queue re-verification planning.

import { describe, it, expect } from "vitest";
import { planRequalification, requalWriteFields, buildRequalNote } from "./reverify-queue";
import type { VerifiedOutcome } from "@/lib/crawler/sources/firecrawl";

const reject = (reason: string): VerifiedOutcome => ({ outcome: "reject", reason });
const accept: VerifiedOutcome = { outcome: "accept", outreachStatus: "", acceptBasis: "condition_signal" };
const review: VerifiedOutcome = { outcome: "review", reason: "condition_signal_missing_flagged", outreachStatus: "Review" };

describe("planRequalification", () => {
  it("keeps a clean-distress accept on Auto-Proceed (no demotion)", () => {
    expect(planRequalification(accept)).toEqual({ action: "keep", reason: "clean_distress" });
  });

  it("demotes renovated / new-construction / wholesaler → Review", () => {
    for (const r of ["firecrawl_renovated", "new_construction_excluded", "wholesaler_excluded"]) {
      expect(planRequalification(reject(r))).toEqual({ action: "demote_review", reason: r });
    }
  });

  it("demotes a condition-signal-missing review → Review", () => {
    expect(planRequalification(review)).toEqual({ action: "demote_review", reason: "condition_signal_missing_flagged" });
  });

  it("demotes an inactive listing → Dead/Off Market", () => {
    expect(planRequalification(reject("firecrawl_inactive"))).toEqual({ action: "demote_dead", reason: "firecrawl_inactive" });
  });

  // The safety invariant: an INFRA failure must never demote a listing.
  it("NEVER demotes on a Firecrawl infra failure (no creds / rate limit / error / unresolved URL)", () => {
    for (const r of ["firecrawl_not_configured", "firecrawl_rate_limited", "firecrawl_error", "firecrawl_url_unresolved"]) {
      const a = planRequalification(reject(r));
      expect(a.action).toBe("skip_unverified");
      expect(requalWriteFields(a)).toBeNull(); // and therefore writes nothing
    }
  });
});

describe("requalWriteFields", () => {
  it("maps demote_review → Outreach_Status Review, demote_dead → Live_Status Off Market", () => {
    expect(requalWriteFields({ action: "demote_review", reason: "x" })).toEqual({ Outreach_Status: "Review" });
    expect(requalWriteFields({ action: "demote_dead", reason: "x" })).toEqual({ Live_Status: "Off Market" });
  });
  it("writes nothing for keep / skip_unverified", () => {
    expect(requalWriteFields({ action: "keep", reason: "clean_distress" })).toBeNull();
    expect(requalWriteFields({ action: "skip_unverified", reason: "firecrawl_error" })).toBeNull();
  });
});

describe("buildRequalNote", () => {
  it("appends to existing notes, preserving prior provenance", () => {
    const note = buildRequalNote("prior intake note", "2026-05-28", { action: "demote_review", reason: "firecrawl_renovated" });
    expect(note).toContain("prior intake note");
    expect(note).toContain("→ Review");
    expect(note).toContain("firecrawl_renovated");
  });
  it("stands alone when there are no prior notes", () => {
    const note = buildRequalNote(null, "2026-05-28", { action: "demote_dead", reason: "firecrawl_inactive" });
    expect(note.startsWith("[2026-05-28]")).toBe(true);
    expect(note).toContain("Off Market (inactive)");
  });
});
