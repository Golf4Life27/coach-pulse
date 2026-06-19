// InvestorBase ingest → durable buyer-transaction store. CONVEYOR M5 Part 1.
// @agent: appraiser/data_federation
//
// Parse → dedupe (entity + property address + most-recent date) → merge into
// the existing set. IDEMPOTENT: re-running the same export does not
// double-count. The PURE pipeline (parse/dedupe/merge) is what the median
// layer consumes and what the tests cover.
//
// DURABLE STORE: the buyer-transaction rows (with contacts) live in the
// Airtable `Buyer_Transactions` table — the same store a later dispo milestone
// queries for buyers(zip, track) with contacts (on-deck; not built here). The
// store WRITE is behind BUYER_MEDIAN_LIVE (default OFF). This milestone is
// watched-run first: it parses + computes + reports and writes NOTHING. The
// persistence flip is a separate, operator-reviewed step.

import { isBuyerMedianLive } from "./buyer-median";
import { parseInvestorBaseCsv, type BuyerTransaction } from "./csv-parse";

/** Airtable durable store for buyer transactions (contacts + acquisition +
 *  resale). Created/written only on the live flip; documented here as the
 *  one-table target so ingestion and the future dispo query share it. */
export const BUYER_TRANSACTIONS_TABLE = "Buyer_Transactions";

/** Pure: collapse duplicate rows by dedupKey (idempotency within one file).
 *  Last-write-wins on a collision (a re-export of the same buyer/property/date
 *  carries the freshest contacts). */
export function dedupeTransactions(txns: BuyerTransaction[]): BuyerTransaction[] {
  const byKey = new Map<string, BuyerTransaction>();
  for (const t of txns) byKey.set(t.dedupKey, t);
  return [...byKey.values()];
}

/** Pure: merge an incoming export into the existing store set, idempotently —
 *  existing rows are kept, new dedupKeys are appended, repeated keys do NOT
 *  double-count. */
export function mergeTransactions(
  existing: BuyerTransaction[],
  incoming: BuyerTransaction[],
): { merged: BuyerTransaction[]; added: number; duplicates: number } {
  const byKey = new Map<string, BuyerTransaction>();
  for (const t of existing) byKey.set(t.dedupKey, t);
  let added = 0;
  let duplicates = 0;
  for (const t of dedupeTransactions(incoming)) {
    if (byKey.has(t.dedupKey)) duplicates++;
    else {
      byKey.set(t.dedupKey, t);
      added++;
    }
  }
  return { merged: [...byKey.values()], added, duplicates };
}

export interface IngestSummary {
  parsedRows: number;
  uniqueTransactions: number;
  withAcquisitionPrice: number;
  byTrack: { landlord: number; flipper: number; untracked: number };
  zips: number;
  written: number;
  watched: boolean;
}

/** Pure-ish: parse + dedupe one InvestorBase CSV against an existing set, and
 *  summarize. WATCHED by default — `written` is 0 and nothing is persisted
 *  unless BUYER_MEDIAN_LIVE is set (the live flip is out of this milestone). */
export function ingestInvestorBaseCsv(
  csvText: string,
  existing: BuyerTransaction[] = [],
): { transactions: BuyerTransaction[]; summary: IngestSummary } {
  const parsed = parseInvestorBaseCsv(csvText);
  const { merged, added } = mergeTransactions(existing, parsed);
  const live = isBuyerMedianLive();
  const summary: IngestSummary = {
    parsedRows: parsed.length,
    uniqueTransactions: merged.length,
    withAcquisitionPrice: merged.filter((t) => t.acquisitionPrice != null).length,
    byTrack: {
      landlord: merged.filter((t) => t.buyerType === "landlord").length,
      flipper: merged.filter((t) => t.buyerType === "flipper").length,
      untracked: merged.filter((t) => t.buyerType == null).length,
    },
    zips: new Set(merged.map((t) => t.propertyZip).filter((z) => z !== "")).size,
    // WATCHED: this milestone never writes. The Airtable Buyer_Transactions
    // upsert (idempotent on dedupKey) runs only behind the live flip.
    written: 0,
    watched: !live,
  };
  return { transactions: merged, summary };
}
