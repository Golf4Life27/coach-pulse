// InvestorBase CSV parsing — the upload half of the credential-free
// ingestion lane (operator GO 2026-07-20: "1 and 2 is a good step
// forward"). @agent: appraiser
//
// The operator exports a subject's buyer list from InvestorBase (manual,
// 3 minutes, ToS-clean) and drops the CSV on the deal page. This module
// turns it into the evidence the gates need, under the RULED MODEL
// (operator principle_amendment 2026-07-20, spine reczqg6SorHCL3PWb):
//
//   1. Buyer evidence = the buyer's AS-IS ACQUISITION price, per track.
//      THE TRAP (same rule as lib/buyer-intel/csv-parse.ts): "Most Recent
//      Sale Price" means OPPOSITE things by Buyer Type —
//        landlord → their ACQUISITION (they hold). Usable.
//        flipper  → their RENOVATED RESALE (ARV exit). Their acquisition
//                   is "Prior Sale Price". Most-Recent is NEVER counted.
//   2. Evidence is expressed as $/SQFT (price ÷ purchased property sqft)
//      so a 900-sqft buy and a 1,800-sqft buy stop pretending to be the
//      same number — the route applies the median $/sqft to the SUBJECT's
//      sqft, exactly how the ARV lane already works (SYSTEM_FACTS §9).
//   3. PER-TRACK, never blended (the pool is bimodal; a blended median is
//      refused by lib/buyer-median-input, and rightly so).
//
// The stamp flow stays operator-in-the-loop: this module only COMPUTES;
// the operator taps "Stamp" per track, which writes through the existing
// validated γ-path (source=investorbase_manual + export date).
//
// Evidence window: acquisitions in the last 18 months, $10k–$250k — below
// $10k is nominal-transfer noise (the same class the ATTOM comp floor
// kills), above $250k is renovated-exit stock, not as-is buying. Rows
// need sqft > MIN_EVIDENCE_SQFT to produce a $/sqft (no sqft → excluded
// from the median, still parsed as a contact).

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
  sqft: number | null;
  /** As-is acquisition per the ruled model: flipper → Prior Sale,
   *  landlord → Most Recent Sale. null = no usable acquisition. */
  acquisitionPrice: number | null;
  acquisitionDate: string | null;
  /** Flipper renovated resale (their Most Recent Sale) — ARV evidence,
   *  NEVER an acquisition. null for landlords. */
  resalePrice: number | null;
}

export interface TrackEvidence {
  track: "flipper" | "landlord";
  /** Rows backing the $/sqft median (in-window acquisitions with sqft). */
  n: number;
  /** Median acquisition $/sqft — the ruled unit of buyer evidence. */
  medianPsf: number | null;
  minPsf: number | null;
  maxPsf: number | null;
  /** Flat median of the same in-window acquisitions — context only,
   *  NEVER the stamped value (flat dollars negate size; ruled out). */
  flatMedian: number | null;
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
export const MIN_EVIDENCE_SQFT = 200; // below this a $/sqft is noise

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
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Pure: CSV text → buyers + per-track as-is acquisition $/sqft evidence.
 *  `nowMs` injected for testability. */
export function parseInvestorBaseCsv(csvText: string, nowMs: number): InvestorBaseParse {
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
  });
  const cutoffMs = nowMs - EVIDENCE_WINDOW_DAYS * 86_400_000;

  const buyers: InvestorBaseBuyer[] = parsed.data.map((r) => {
    const t = (r["Buyer Type"] ?? "").trim().toLowerCase();
    const buyerType = t === "flipper" || t === "landlord" ? t : null;
    const mostRecentPrice = num(r["Most Recent Sale Price"]);
    const mostRecentDate = str(r["Most Recent Sale Date"]);
    const priorPrice = num(r["Prior Sale Price"]);
    const priorDate = str(r["Prior Sale Date"]);
    // THE TRAP, applied: flipper acquisition = Prior; landlord = Most Recent.
    const acquisitionPrice =
      buyerType === "landlord" ? mostRecentPrice : buyerType === "flipper" ? priorPrice : null;
    const acquisitionDate =
      buyerType === "landlord" ? mostRecentDate : buyerType === "flipper" ? priorDate : null;
    return {
      entityName: str(r["Entity Name"]),
      firstName: str(r["First Name"]),
      lastName: str(r["Last Name"]),
      buyerType,
      propertyType: str(r["Property Type"]),
      phone: str(r["Wireless 1"]) ?? str(r["Wireless 2"]) ?? str(r["Landline 1"]),
      email: str(r["Beta: Possible Email"]),
      address: str(r["Address"]),
      sqft: num(r["Sqft"]),
      acquisitionPrice,
      acquisitionDate,
      resalePrice: buyerType === "flipper" ? mostRecentPrice : null,
    };
  });

  const evidence: TrackEvidence[] = (["flipper", "landlord"] as const).map((track) => {
    const rows = buyers
      .filter((b) => b.buyerType === track)
      .filter((b) => b.acquisitionPrice != null && b.acquisitionDate != null)
      .filter((b) => {
        const t = Date.parse(b.acquisitionDate!);
        return (
          Number.isFinite(t) &&
          t >= cutoffMs &&
          b.acquisitionPrice! >= EVIDENCE_MIN_PRICE &&
          b.acquisitionPrice! <= EVIDENCE_MAX_PRICE
        );
      });
    const psfRows = rows.filter((b) => b.sqft != null && b.sqft > MIN_EVIDENCE_SQFT);
    const psf = psfRows.map((b) => b.acquisitionPrice! / b.sqft!);
    const flat = rows.map((b) => b.acquisitionPrice!);
    const medPsf = median(psf);
    return {
      track,
      n: psfRows.length,
      medianPsf: medPsf != null ? Math.round(medPsf * 100) / 100 : null,
      minPsf: psf.length ? Math.round(Math.min(...psf) * 100) / 100 : null,
      maxPsf: psf.length ? Math.round(Math.max(...psf) * 100) / 100 : null,
      flatMedian: flat.length ? Math.round(median(flat)!) : null,
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

/** Pure: apply a track's median acquisition $/sqft to the subject's sqft —
 *  the dollar value the Stamp button writes. null when either leg is
 *  missing (never fabricated). */
export function applyEvidenceToSubject(
  e: TrackEvidence,
  subjectSqft: number | null | undefined,
): number | null {
  if (e.medianPsf == null) return null;
  if (subjectSqft == null || !Number.isFinite(subjectSqft) || subjectSqft <= MIN_EVIDENCE_SQFT) return null;
  return Math.round(e.medianPsf * subjectSqft);
}
