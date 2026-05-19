// Phase 13.3 + 13.5 + 13.6 / Q.7 — Crawler architectural types.
//
// Adapter pattern so Sentinel can pull from multiple intake sources
// (PropStream MLS, off-market signals like probate / tax delinquency
// / code violations) through one pipeline. Each source returns a
// CrawlerCandidate shape that the intake gates (lib/intake/
// quality-gates) classify before the candidate is written to
// Listings_V1.
//
// Live integration requires external credentials per source. The
// framework ships pre-credential — operator wires creds, the live
// scan runs.

export type CrawlerSourceId =
  | "propstream"            // on-market MLS (Phase 13.5)
  | "probate"               // off-market: estate cases (13.6)
  | "tax_delinquency"       // off-market: tax-delinquent (13.6)
  | "code_violations";      // off-market: code-violation list (13.6)

export interface CrawlerCandidate {
  /** Source-side identifier (PropStream listing ID, court case
   *  number, etc.) — used for dedupe at intake time. */
  source_id: string;
  source: CrawlerSourceId;
  address: string;
  city: string | null;
  state: string | null;
  zip: string | null;
  list_price: number | null;
  /** Free-text body the quality gates regex-match against. */
  body: string | null;
  agent_name: string | null;
  agent_phone: string | null;
  agent_email: string | null;
  /** ISO timestamp when the source emitted this candidate. */
  emitted_at: string;
  /** Raw source payload preserved for audit — debug + future
   *  enrichment. */
  raw?: Record<string, unknown>;
}

export interface CrawlerScanArgs {
  /** Source-specific filter (zip, state, etc.). Sources interpret. */
  filter?: Record<string, unknown>;
  /** Cap on returned candidates per scan. */
  limit?: number;
}

export interface CrawlerScanResult {
  source: CrawlerSourceId;
  candidates: CrawlerCandidate[];
  /** Source health surfaced for the operator + Pulse. */
  source_health: "ok" | "degraded" | "down" | "uncredentialed";
  /** Operator-facing error message when source_health !== "ok". */
  error?: string;
  /** Diagnostic: API call count, scrape page count, etc. */
  diagnostics?: Record<string, unknown>;
}

/** Source adapter interface. Each concrete adapter implements scan(). */
export interface CrawlerSource {
  id: CrawlerSourceId;
  /** Human-readable name for UI + audit. */
  display_name: string;
  /** Whether the adapter has been wired with live credentials. False
   *  → adapter returns empty results + source_health "uncredentialed";
   *  not an error condition — just a "needs setup" signal. */
  is_credentialed: () => boolean;
  scan: (args: CrawlerScanArgs) => Promise<CrawlerScanResult>;
}
