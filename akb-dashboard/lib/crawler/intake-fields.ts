// Intake field assembly (pure) — extracted from app/api/cron/listings-intake so
// the candidate → Airtable-fields mapping is unit-testable. @agent: scout
//
// REGRESSION GUARD (operator 2026-06-21): the MLS_Date_Raw write silently
// regressed once — RentCast's listedDate was parsed into IntakeCandidate.
// listedDate but never written, so every crawler record short-circuited to
// "Data Issue: Missing MLS Date" → Manual Review (fixed in PR #32). This pure
// builder makes that mapping (and the rest of the intake field assembly)
// assertable in a unit test so it can't silently drop again.
//
// PURE. No I/O — the caller POSTs the returned fields to Airtable.

import type { IntakeCandidate } from "@/lib/crawler/intake-filter";
import { SOURCE_VERSION_FIELD_NAME, SOURCE_VERSION_V2 } from "@/lib/source-version";

export interface IntakeFieldsOpts {
  /** ISO timestamp for Verification_Notes / Last_Verified. */
  iso: string;
  /** promote → H2-ready (Outreach_Status empty + Auto Proceed + Active);
   *  !promote → Review queue. */
  promote: boolean;
  /** Resolved portal-detail URL from the Firecrawl verify step, or null. */
  firecrawlUrl: string | null;
  portfolioDetected?: boolean;
  matchedPortfolioKeywords?: string[];
  underwrittenMao?: number | null;
  underwrittenMaoTrack?: string | null;
  opener?: { amount: number | null; basis: string; reseed: boolean } | null;
}

const posNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** Pure: build the Airtable `fields` object for a new intake listing. Mirrors
 *  the live createIntakeListing assembly; every field is set only when present
 *  (never synthesized). */
export function buildIntakeListingFields(c: IntakeCandidate, opts: IntakeFieldsOpts): Record<string, unknown> {
  const { iso, promote, firecrawlUrl } = opts;
  const fields: Record<string, unknown> = {
    Address: c.address ?? "",
    City: c.city ?? "",
    State: c.state ?? "",
    Zip: c.zip ?? "",
    [SOURCE_VERSION_FIELD_NAME]: SOURCE_VERSION_V2,
  };
  if (firecrawlUrl) {
    fields["Verification_URL"] = firecrawlUrl;
    fields["Verification_Source"] = "firecrawl_intake";
    fields["Last_Verified"] = iso;
  }
  if (c.propertyType) fields["Property_Type"] = c.propertyType;
  if (c.beds != null) fields["Bedrooms"] = c.beds;
  if (c.listPrice != null) fields["List_Price"] = c.listPrice;
  // MLS list date — the field that regressed. Only set when present.
  if (c.listedDate) fields["MLS_Date_Raw"] = c.listedDate;
  if (c.bathrooms != null) fields["Bathrooms"] = c.bathrooms;
  if (c.squareFootage != null) fields["Building_SqFt"] = c.squareFootage;
  if (c.yearBuilt != null) fields["Year_Built"] = c.yearBuilt;
  if (c.agentName) fields["Agent_Name"] = c.agentName;
  if (c.agentPhone) fields["Agent_Phone"] = c.agentPhone;
  if (c.agentEmail) fields["Agent_Email"] = c.agentEmail;
  if (promote) {
    fields["Outreach_Status"] = ""; // empty → H2 eligibility filter picks it up
    fields["Execution_Path"] = "Auto Proceed";
    fields["Live_Status"] = "Active";
    fields["Do_Not_Text"] = false;
    fields["Verification_Notes"] =
      `[${iso}] RentCast auto-intake (${c.sourceId}) — auto-promoted to Auto Proceed (clean agent phone + math gate passed).`;
  } else {
    fields["Outreach_Status"] = "Review";
    fields["Verification_Notes"] =
      `[${iso}] RentCast auto-intake (${c.sourceId}) — queued for Review.`;
  }
  if (opts.portfolioDetected) {
    fields["Portfolio_Detected"] = true;
    fields["Verification_Notes"] =
      `${fields["Verification_Notes"] ?? ""}\n[${iso}] PORTFOLIO_DETECTED: ${(opts.matchedPortfolioKeywords ?? []).slice(0, 6).join(", ")}.`;
  }
  if (posNum(opts.underwrittenMao)) {
    fields["Underwritten_MAO"] = opts.underwrittenMao;
  }
  if (opts.underwrittenMaoTrack === "landlord" || opts.underwrittenMaoTrack === "flipper") {
    fields["Underwritten_MAO_Track"] = opts.underwrittenMaoTrack;
  }
  if (opts.opener) {
    if (posNum(opts.opener.amount)) {
      fields["Rough_Opener_Amount"] = opts.opener.amount;
    }
    fields["Opener_Basis"] = opts.opener.basis;
    if (opts.opener.reseed) fields["Opener_Reseed_Flag"] = true;
  }
  return fields;
}
