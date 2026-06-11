// Known test-artifact Listings_V1 records.
//
// THE INCIDENT (operator 2026-06-11): three debug crons were found in
// vercel.json all pointed at the SAME hardcoded record — used as a lab
// rat for end-to-end smoke tests of the Bexar tax pipeline, the
// landlord-MAO report, and the rehab vision pipeline. The crons billed
// RentCast 404s + Anthropic vision calls every */10-30 against that one
// record for an unknown duration before the morning audit caught it.
//
// The values written to that record (ARV, MAO, rehab estimate, taxes)
// are SCAFFOLDING RESIDUE — they were computed by debug crons, not by
// the production underwriting path on a live deal. Rendering them in the
// deal panels as analysis numbers is dishonest: the operator might
// reference them, and the lineage doesn't justify them.
//
// This set is the single source of truth. Surfaces (AppraiserArvPanel,
// AppraiserRehabPanel, future Pipeline list) check isTestArtifact() and
// render a "TEST ARTIFACT — scaffolding residue, not production
// underwriting" banner that relabels the math display.

export interface TestArtifactRecord {
  /** Why this record was used by debug crons. Surfaced in the panel
   *  banner so the operator knows the provenance. */
  reason: string;
}

export const TEST_ARTIFACT_RECORDS: ReadonlyMap<string, TestArtifactRecord> = new Map([
  [
    "recG4GNM2sa0ZYj7p",
    {
      reason:
        "5435 Callaghan Rd was the lab rat for three debug crons " +
        "(bexar-taxes */10, landlord-mao */30, appraiser/rehab */10) before " +
        "the 2026-06-11 cron audit killed them. Its ARV, MAO, rehab, and " +
        "tax fields carry residue from the smoke tests, not production " +
        "underwriting.",
    },
  ],
]);

export function isTestArtifact(recordId: string | null | undefined): boolean {
  return !!recordId && TEST_ARTIFACT_RECORDS.has(recordId);
}

export function testArtifactReason(recordId: string | null | undefined): string | null {
  if (!recordId) return null;
  return TEST_ARTIFACT_RECORDS.get(recordId)?.reason ?? null;
}
