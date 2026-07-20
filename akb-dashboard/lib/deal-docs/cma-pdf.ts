// PropStream CMA PDF parsing — the other half of the ingestion lane.
// @agent: appraiser
//
// Extracts the decision-bearing numbers from a dropped PropStream CMA:
// comp average, comp count, estimated value, the seller's open mortgage
// balance and last purchase — the exact intel that decoded Canfield's
// "double it" (2026-07-20). Parsed values are STORED AS EVIDENCE with
// provenance (KV + Property_Intel owner/mortgage fields + a listing note);
// they never silently overwrite system-derived numbers — the dossier's
// Operator-CMA override flow remains the operator's explicit act.
//
// Regexes target PropStream's stable summary labels. A missing label maps
// to null — partial extraction is fine, fabrication is not.

export interface CmaExtract {
  avgSalePrice: number | null;
  compCount: number | null;
  estimatedValue: number | null;
  mortgageBalance: number | null;
  estimatedEquity: number | null;
  lastSalePrice: number | null;
  lastSaleDate: string | null;
  ownerName: string | null;
  monthlyRent: number | null;
  /** Labels that parsed successfully — provenance for the note. */
  extracted: string[];
}

function grabMoney(text: string, label: RegExp): number | null {
  const m = text.match(label);
  if (!m) return null;
  const n = Number(m[1].replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}
function grabInt(text: string, label: RegExp): number | null {
  const m = text.match(label);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function grabStr(text: string, label: RegExp): string | null {
  const m = text.match(label);
  return m ? m[1].trim() : null;
}

/** Sniff: is this a PropStream CMA? */
export function looksLikeCmaPdf(text: string): boolean {
  return /Comparative Market Analysis/i.test(text);
}

/** Pure: extracted PDF text → the CMA evidence numbers. */
export function parseCmaText(text: string): CmaExtract {
  const out: CmaExtract = {
    avgSalePrice: grabMoney(text, /Avg\.?\s*Sale Price:?\s*\$?([\d,]+)/i),
    compCount: grabInt(text, /Properties:?\s*(\d+)/i),
    estimatedValue: grabMoney(text, /Estimated Value:?\s*\$?([\d,]+)/i),
    mortgageBalance: grabMoney(text, /Mortgage Balance:?\s*\$?([\d,]+)/i),
    estimatedEquity: grabMoney(text, /Estimated Equity:?\s*\$?([\d,]+)/i),
    // Line-anchored: "Avg. Sale Price" / "Prior Sale Date" must never match.
    lastSalePrice: grabMoney(text, /^Sale Price:?\s*\$?([\d,]+)/im),
    lastSaleDate: grabStr(text, /^Sale Date:?\s*([\d/]+)/im),
    ownerName: grabStr(text, /Owner Name:?\s*([A-Z0-9 &.,'-]+?)(?:\n|Mailing|$)/i),
    monthlyRent: grabMoney(text, /Monthly Rent:?\s*\$?([\d,]+)/i),
    extracted: [],
  };
  out.extracted = (Object.keys(out) as Array<keyof CmaExtract>)
    .filter((k) => k !== "extracted" && out[k] != null)
    .map(String);
  return out;
}
