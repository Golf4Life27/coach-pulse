// Phase 13.3 + 13.5 / Q.7 — PropStream MLS adapter.
//
// On-market MLS automation — the wife-retirement intake source.
// Pre-credential scaffold today; live integration unlocks when
// PROPSTREAM_API_KEY env lands.
//
// Why this is scaffolded vs implemented:
//   PropStream's API access is gated behind business-tier subscription
//   + an API access request. Once Alex provisions, this adapter
//   becomes a thin fetch wrapper around their /listings endpoint.
//   The framework + composition + intake-quality-gates wire-up are
//   the harder part; that's all in place.
//
// Wire-up checklist (Phase 21 backlog → operator-fire):
//   1. PropStream → upgrade to API-capable plan ($299/mo as of 5/19).
//   2. Generate API key, set PROPSTREAM_API_KEY env in Vercel.
//   3. (optional) Set PROPSTREAM_DEFAULT_FILTER_ZIP="78210" or similar.
//   4. Replace the placeholder scan() body with real fetch calls;
//      map PropStream response shape into CrawlerCandidate.
//   5. Run /api/agents/sentinel/crawler/scan?source=propstream to verify.
//   6. Move from manual CSV upload to this scan as the canonical
//      intake source.

import type {
  CrawlerScanArgs,
  CrawlerScanResult,
  CrawlerSource,
} from "../types";

const PROPSTREAM_API_KEY = process.env.PROPSTREAM_API_KEY;
const PROPSTREAM_API_URL = "https://api.propstream.com/v1"; // placeholder

export const propstreamSource: CrawlerSource = {
  id: "propstream",
  display_name: "PropStream MLS",
  is_credentialed: () => Boolean(PROPSTREAM_API_KEY),
  async scan(_args: CrawlerScanArgs): Promise<CrawlerScanResult> {
    if (!PROPSTREAM_API_KEY) {
      return {
        source: "propstream",
        candidates: [],
        source_health: "uncredentialed",
        error: "PROPSTREAM_API_KEY env not set. See lib/crawler/sources/propstream.ts header for wire-up steps.",
        diagnostics: { api_url: PROPSTREAM_API_URL },
      };
    }
    // ── LIVE INTEGRATION PLACEHOLDER ────────────────────────────────
    // When PROPSTREAM_API_KEY lands, this is where the real fetch +
    // mapping goes. The intake pipeline doesn't need to change —
    // it consumes CrawlerCandidate[] regardless of source.
    return {
      source: "propstream",
      candidates: [],
      source_health: "degraded",
      error: "PropStream live integration not yet implemented — API key present but adapter scan() is placeholder. See lib/crawler/sources/propstream.ts header.",
      diagnostics: { api_url: PROPSTREAM_API_URL },
    };
  },
};
