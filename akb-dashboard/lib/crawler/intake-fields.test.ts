// Intake field assembly — regression guard for the MLS_Date_Raw write (and the
// rest of the candidate→fields mapping).

import { describe, it, expect } from "vitest";
import type { IntakeCandidate } from "@/lib/crawler/intake-filter";
import { SOURCE_VERSION_FIELD_NAME, SOURCE_VERSION_V2 } from "@/lib/source-version";
import { buildIntakeListingFields } from "./intake-fields";

const candidate = (over: Partial<IntakeCandidate> = {}): IntakeCandidate => ({
  sourceId: "rentcast:test-1",
  address: "4357 W Philadelphia St, Detroit, MI 48204",
  city: "Detroit",
  state: "MI",
  zip: "48204",
  propertyType: "Single Family",
  beds: 3,
  listPrice: 120000,
  listedDate: "2026-03-15T00:00:00.000Z",
  agentName: "Jane Agent",
  agentPhone: "3135550100",
  agentEmail: "jane@example.com",
  brokerageName: "Acme Realty",
  daysOnMarket: 40,
  priceReduced: false,
  squareFootage: 1200,
  bathrooms: 2,
  yearBuilt: 1950,
  ...over,
});

const OPTS = { iso: "2026-06-21T00:00:00.000Z", promote: false, firecrawlUrl: null };

describe("buildIntakeListingFields — MLS_Date_Raw regression guard", () => {
  it("writes MLS_Date_Raw from candidate.listedDate when present", () => {
    const f = buildIntakeListingFields(candidate({ listedDate: "2026-03-15T00:00:00.000Z" }), OPTS);
    expect(f["MLS_Date_Raw"]).toBe("2026-03-15T00:00:00.000Z");
  });

  it("OMITS MLS_Date_Raw when listedDate is absent (never synthesized)", () => {
    const f = buildIntakeListingFields(candidate({ listedDate: null }), OPTS);
    expect("MLS_Date_Raw" in f).toBe(false);
  });

  it("stamps the v2 source-version + core fields", () => {
    const f = buildIntakeListingFields(candidate(), OPTS);
    expect(f[SOURCE_VERSION_FIELD_NAME]).toBe(SOURCE_VERSION_V2);
    expect(f["List_Price"]).toBe(120000);
    expect(f["Agent_Phone"]).toBe("3135550100");
  });

  it("writes Price_Drop_Count=1 when a reduction was detected (distress-score coherence)", () => {
    const f = buildIntakeListingFields(candidate({ priceReduced: true }), OPTS);
    expect(f["Price_Drop_Count"]).toBe(1);
  });

  it("OMITS Price_Drop_Count when no reduction (never synthesized)", () => {
    expect("Price_Drop_Count" in buildIntakeListingFields(candidate({ priceReduced: false }), OPTS)).toBe(false);
    expect("Price_Drop_Count" in buildIntakeListingFields(candidate({ priceReduced: undefined }), OPTS)).toBe(false);
  });

  it("promote=true → H2-ready (Outreach_Status empty + Auto Proceed + Active)", () => {
    const f = buildIntakeListingFields(candidate(), { ...OPTS, promote: true });
    expect(f["Outreach_Status"]).toBe("");
    expect(f["Execution_Path"]).toBe("Auto Proceed");
    expect(f["Live_Status"]).toBe("Active");
  });

  it("promote=false → Review queue (no Live_Status)", () => {
    const f = buildIntakeListingFields(candidate(), { ...OPTS, promote: false });
    expect(f["Outreach_Status"]).toBe("Review");
    expect("Live_Status" in f).toBe(false);
  });
});

// The 20179 Russell St gap (2026-07-30): intake's Firecrawl verify computed
// hasRenovatedLanguage but the write dropped it — freshness-reverify was the
// ONLY Renovated_Language writer, so a record was textable in the window
// between creation and its first reverify pass (Russell St: 9 minutes).
// These tests pin the intake write so the send-gate veto sees the flag from
// the record's first minute.
describe("buildIntakeListingFields — Renovated_Language persists from intake verify", () => {
  it("writes Renovated_Language + a keywords note line when detected", () => {
    const f = buildIntakeListingFields(candidate(), {
      ...OPTS,
      renovatedLanguage: true,
      matchedRenovationKeywords: ["fully renovated", "turnkey"],
    });
    expect(f["Renovated_Language"]).toBe(true);
    expect(String(f["Verification_Notes"])).toContain("RENOVATED_LANGUAGE at intake: fully renovated, turnkey");
  });

  it("OMITS Renovated_Language when not detected (absence = never classified, false is not written)", () => {
    expect("Renovated_Language" in buildIntakeListingFields(candidate(), OPTS)).toBe(false);
    expect("Renovated_Language" in buildIntakeListingFields(candidate(), { ...OPTS, renovatedLanguage: false })).toBe(false);
  });

  it("keywords note tolerates an empty match list (flag can outlive its keywords)", () => {
    const f = buildIntakeListingFields(candidate(), { ...OPTS, renovatedLanguage: true });
    expect(f["Renovated_Language"]).toBe(true);
    expect(String(f["Verification_Notes"])).toContain("RENOVATED_LANGUAGE at intake:");
  });
});
