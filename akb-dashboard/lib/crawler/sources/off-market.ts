// Phase 13.6 / Q.7 — Off-market motivated-seller adapters.
//
// Three distinct adapters for the off-market intake sources:
//   - probate: county-court estate filings + heir contacts
//   - tax_delinquency: county tax-assessor delinquent-list pulls
//   - code_violations: city code-enforcement violation lists
//
// All three are county/city-specific — no single API covers them.
// Live integration would compose: (a) per-county scraper /
// public-records-API per source, (b) county-list config naming
// which counties are in-scope per market (TX/TN/MI), (c) PII
// handling discipline for personal phone/email enrichment.
//
// Pre-credential scaffolds today. Real implementation gated on
// Crawler 1.0 (Phase 13.5) shipping first, then market selection
// (Phase 13.4 geographic expansion logic), then per-county source
// onboarding.

import type {
  CrawlerScanArgs,
  CrawlerScanResult,
  CrawlerSource,
  CrawlerSourceId,
} from "../types";

function pendingSource(id: CrawlerSourceId, displayName: string): CrawlerSource {
  return {
    id,
    display_name: displayName,
    is_credentialed: () => false, // never until per-county adapters land
    async scan(_args: CrawlerScanArgs): Promise<CrawlerScanResult> {
      return {
        source: id,
        candidates: [],
        source_health: "uncredentialed",
        error: `${displayName} source not yet implemented. Per-county integration gated on Crawler 1.0 + market selection. See lib/crawler/sources/off-market.ts header.`,
      };
    },
  };
}

export const probateSource = pendingSource("probate", "Probate filings");
export const taxDelinquencySource = pendingSource(
  "tax_delinquency",
  "Tax delinquency lists",
);
export const codeViolationsSource = pendingSource(
  "code_violations",
  "Code violations",
);
