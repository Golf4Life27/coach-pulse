// InvestorBase CSV parsing — the upload half of the credential-free
// ingestion lane (operator GO 2026-07-20: "1 and 2 is a good step
// forward"). @agent: appraiser
//
// The operator exports a subject's buyer list from InvestorBase (manual,
// 3 minutes, ToS-clean) and drops the CSV on the deal page. This module
// turns it into the evidence the gates need:
//   - PER-TRACK medians (flipper / landlord) of recent as-is acquisitions —
//     NEVER blended (the pool is bimodal; a blended median is refused by
//     lib/buyer-median-input, and rightly so).
//   - The stamp flow stays operator-in-the-loop: this module only COMPUTES;
//     the operator taps "Stamp" per track, which writes through the
//     existing validated γ-path (source=investorbase_manual + export date).
//
// Evidence window: recorded purchases in the last 18 months, $10k–$250k —
// below $10k is nominal-transfer noise (the same class the ATTOM comp
// floor kills), above $250k is renovated-exit stock, not as-is buying.

import Papa from "papaparse";

export interface InvestorBaseBuyer {
  entityName: string | null;
  firstName: string | null;
  lastName: string | null;
  buyerType: "flipper" | "landlord" | null;
  propertyType: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  lastSalePrice: number | null;
  lastSaleDate: string | null;
}

export interface TrackEvidence {
  track: "flipper" | "landlord";
  n: number;
  median: number | null;
  mean: number | null;
  min: number | null;
  max: number | null;
}

export interface InvestorBaseParse {
  buyers: InvestorBaseBuyer[];
  totalRows: number;
  flipperCount: number;
  landlordCount: number;
  evidence: TrackEvidence[];
  /** Rows inside the evidence window across both tracks. */
  evidenceRows: number;
}

export const EVIDENCE_MIN_PRICE = 10_000;
export const EVIDENCE_MAX_PRICE = 250_000;
export const EVIDENCE_WINDOW_DAYS = 548; // 18 months

const REQUIRED_HEADERS = ["Buyer Type", "Most Recent Sale Price", "Most Recent Sale Date"];

/** Sniff: is this an InvestorBase buyers export? */
export function looksLikeInvestorBaseCsv(headerLine: string): boolean {
  return REQUIRED_HEADERS.every((h) => headerLine.includes(h));
}

function num(v: string | undefined): number | null {
  if (!v || !v.trim()) return null;
  const n = Number(v.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}
function str(v: string | undefined): string | null {
  return v && v.trim() ? v.trim() : null;
}
function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/** Pure: CSV text → buyers + per-track as-is acquisition evidence.
 *  `nowMs` injected for testability. */
export function parseInvestorBaseCsv(csvText: string, nowMs: number): InvestorBaseParse {
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
  });
  const cutoffMs = nowMs - EVIDENCE_WINDOW_DAYS * 86_400_000;

  const buyers: InvestorBaseBuyer[] = parsed.data.map((r) => {
    const t = (r["Buyer Type"] ?? "").trim().toLowerCase();
    return {
      entityName: str(r["Entity Name"]),
      firstName: str(r["First Name"]),
      lastName: str(r["Last Name"]),
      buyerType: t === "flipper" || t === "landlord" ? t : null,
      propertyType: str(r["Property Type"]),
      phone: str(r["Wireless 1"]) ?? str(r["Wireless 2"]) ?? str(r["Landline 1"]),
      email: str(r["Beta: Possible Email"]),
      address: str(r["Address"]),
      lastSalePrice: num(r["Most Recent Sale Price"]),
      lastSaleDate: str(r["Most Recent Sale Date"]),
    };
  });

  const evidence: TrackEvidence[] = (["flipper", "landlord"] as const).map((track) => {
    const prices = buyers
      .filter((b) => b.buyerType === track)
      .filter((b) => b.lastSalePrice != null && b.lastSaleDate != null)
      .filter((b) => {
        const t = Date.parse(b.lastSaleDate!);
        return (
          Number.isFinite(t) &&
          t >= cutoffMs &&
          b.lastSalePrice! >= EVIDENCE_MIN_PRICE &&
          b.lastSalePrice! <= EVIDENCE_MAX_PRICE
        );
      })
      .map((b) => b.lastSalePrice!);
    return {
      track,
      n: prices.length,
      median: median(prices),
      mean: prices.length ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : null,
      min: prices.length ? Math.min(...prices) : null,
      max: prices.length ? Math.max(...prices) : null,
    };
  });

  return {
    buyers,
    totalRows: buyers.length,
    flipperCount: buyers.filter((b) => b.buyerType === "flipper").length,
    landlordCount: buyers.filter((b) => b.buyerType === "landlord").length,
    evidence,
    evidenceRows: evidence.reduce((a, e) => a + e.n, 0),
  };
}
