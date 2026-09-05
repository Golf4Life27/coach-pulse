// SOLD-FOR FEEDBACK LOOP — turn "sold for $163,250" replies into pricing data.
// @agent: sentinel
//
// Operator 2026-09-05 (Spine recSPi62i3U3vgJVe): a decline that carries the
// price the house actually sold or went under contract for is the one input
// the pricing doctrine never had — a real closed price on a house we already
// hold sqft / zip / list price for (MLS-grade in non-disclosure states), the
// list-to-sale ratio for that zip, and the gap between our opener and what
// the market paid. Today those replies land as UNCLASSIFIED / ESCALATE noise.
//
// Three pure pieces, all tested in lib/sold-feedback.test.ts:
//   detectReportedSale   — reply body → { price, kind } or null
//   reportedSaleFields   — the Airtable write for a detected sale
//   computeSoldFeedback  — listings → per-zip / per-price-band ratios
//   suggestedAnchorPct   — advisory opener pct for a zip (never below /
//                          above the operator's 60-65% band)
//
// Nothing here sends, prices, or changes status. The capture hook stamps two
// fields; the daily roll-up reports; the opener hook is flag-gated and
// advisory inside the ruling's band.

import { detectL3DollarAmounts } from "@/lib/outreach/l3-amount-detector";

export type ReportedSaleKind = "sold" | "under_contract";

export interface ReportedSale {
  price: number;
  kind: ReportedSaleKind;
  /** The regex that matched, for the audit trail. */
  matchedPattern: string;
}

// "sold for $163,250" / "it sold at 160k" / "closed at $150,000" /
// "went for 145k" / "we got $170k for it" / "under contract at $155k" /
// "accepted an offer of $160,000". The price is parsed by the shared L3
// detector so "$163,250", "163k", "$1.2M" all read the same way; the
// pattern only decides that a sale/contract VERB sits near the number.
const SOLD_PATTERNS: RegExp[] = [
  /\b(?:sold|closed|went)\s+(?:it\s+|the\s+(?:house|property|home)\s+)?(?:for|at)\s+\$?\s?\d/i,
  /\b(?:sold|closed)\s+(?:last\s+\w+\s+|yesterday\s+|recently\s+|already\s+)?(?:for|at)\s+\$?\s?\d/i,
  /\b(?:we|they|seller|it)\s+(?:got|received|netted)\s+\$?\s?\d[\d,.]*\s?[kKmM]?\s+(?:for|on)\s+(?:it|the\s+(?:house|property|home))\b/i,
  /\bsale\s+price\s+(?:was|of|is)\s+\$?\s?\d/i,
  /\bsold\b[^.?!]{0,40}\bfor\s+\$?\s?\d/i,
];
const UNDER_CONTRACT_PATTERNS: RegExp[] = [
  /\b(?:under\s+contract|pending|in\s+escrow)\b[^.?!]{0,40}\b(?:at|for)\s+\$?\s?\d/i,
  /\b(?:accepted|took)\s+(?:an?\s+)?(?:offer|contract)\s+(?:of|at|for)\s+\$?\s?\d/i,
  /\bcontract\s+(?:price|amount)\s+(?:is|was|of)\s+\$?\s?\d/i,
];

/** Pure: does this reply report the price a house sold / went under contract
 *  for? Returns the FIRST dollar amount in the reply (the detector's order is
 *  source order) — a "sold for $163,250, you offered $102,250" reply reports
 *  the sale first by construction of every pattern above. Null when there is
 *  no sale verb next to a number, or no parseable amount ≥ $10,000 (guards
 *  against "sold for 5 years" style false positives). */
export function detectReportedSale(body: string | null | undefined): ReportedSale | null {
  const text = (body ?? "").trim();
  if (!text) return null;
  const kind: ReportedSaleKind | null = SOLD_PATTERNS.some((p) => p.test(text))
    ? "sold"
    : UNDER_CONTRACT_PATTERNS.some((p) => p.test(text))
      ? "under_contract"
      : null;
  if (!kind) return null;
  const matched = (kind === "sold" ? SOLD_PATTERNS : UNDER_CONTRACT_PATTERNS).find((p) => p.test(text))!;
  const amounts = detectL3DollarAmounts(text).amounts;
  // The sale price is the first amount AT or AFTER the sale verb ("sold for
  // $163,250 — you offered $102,250" must not read our own number back);
  // fall back to the first amount in the reply.
  const m = matched.exec(text);
  const byPosition = [...amounts]
    .map((a) => ({ a, at: text.indexOf(a.token) }))
    .filter((x) => x.at >= 0)
    .sort((x, y) => x.at - y.at);
  const afterVerb = m ? byPosition.find((x) => x.at >= m.index)?.a : undefined;
  const pick = afterVerb ?? byPosition[0]?.a ?? amounts[0];
  if (!pick || pick.amountUsd < 10_000) return null;
  return { price: Math.round(pick.amountUsd), kind, matchedPattern: matched.source };
}

/** Pure: the Airtable fields to stamp for a detected sale. Date is the
 *  inbound's own timestamp (YYYY-MM-DD) — the day the agent told us. */
export function reportedSaleFields(sale: ReportedSale, receivedAtIso: string): Record<string, unknown> {
  const day = /^\d{4}-\d{2}-\d{2}/.exec(receivedAtIso)?.[0] ?? new Date(receivedAtIso).toISOString().slice(0, 10);
  return { Reported_Sale_Price: sale.price, Reported_Sale_Date: day };
}

// ── Roll-up ──────────────────────────────────────────────────────────────

export interface SoldFeedbackRow {
  id: string;
  zip?: string | null;
  state?: string | null;
  listPrice?: number | null;
  /** The opener we texted (sticky), if any. */
  openerUsd?: number | null;
  reportedSalePrice?: number | null;
  reportedSaleDate?: string | null;
  buildingSqFt?: number | null;
  lastOutreachDate?: string | null;
  address?: string | null;
}

export interface SoldFeedbackBucket {
  key: string;
  n: number;
  /** median(sale ÷ list) — how close to ask this bucket actually clears. */
  listToSaleMedian: number | null;
  /** median(opener ÷ sale) — how far under the real price our opener sat. */
  openerToSaleMedian: number | null;
  /** median $/sqft of the reported sales that carry sqft. */
  salePerSqftMedian: number | null;
  /** median days from our last outreach to the reported sale date. */
  daysOpenerToSaleMedian: number | null;
  /** Advisory opener pct for this bucket (see suggestedAnchorPct). */
  suggestedAnchorPct: number;
  /** True when this bucket clears at or near list — no distress here. */
  saturated: boolean;
}

export interface SoldFeedbackReport {
  computedAt: string;
  sampleSize: number;
  byZip: Record<string, SoldFeedbackBucket>;
  byPriceBand: Record<string, SoldFeedbackBucket>;
  /** Every reported sale as a comp-shaped row for the appraiser. */
  reportedSales: Array<{
    id: string;
    address: string | null;
    zip: string | null;
    state: string | null;
    sqft: number | null;
    salePrice: number;
    perSqft: number | null;
    listPrice: number | null;
    openerUsd: number | null;
    saleDate: string | null;
  }>;
}

const SATURATED_LIST_TO_SALE = 0.97;
const SOFT_LIST_TO_SALE = 0.93;
const MIN_SAMPLE = 3;
export const ANCHOR_PCT_MIN = 0.6;
export const ANCHOR_PCT_MAX = 0.65;
export const ANCHOR_PCT_DEFAULT = 0.62;

function median(xs: number[]): number | null {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** Pure: advisory opener pct for a bucket, ALWAYS inside the operator's
 *  60-65% band (ruling 2026-08-30). Thin samples (< MIN_SAMPLE) return the
 *  default. A saturated bucket (houses clear ≥97% of list) gets the top of
 *  the band — a 62% opener there is noise; a soft bucket (≤93%) stays at the
 *  bottom. The map never decides to SKIP a listing; that stays with the
 *  operator. */
export function suggestedAnchorPct(listToSaleMedian: number | null, n: number): number {
  if (listToSaleMedian == null || n < MIN_SAMPLE) return ANCHOR_PCT_DEFAULT;
  if (listToSaleMedian >= SATURATED_LIST_TO_SALE) return ANCHOR_PCT_MAX;
  if (listToSaleMedian <= SOFT_LIST_TO_SALE) return ANCHOR_PCT_MIN;
  return ANCHOR_PCT_DEFAULT;
}

export function priceBand(listPrice: number | null | undefined): string {
  if (!(typeof listPrice === "number" && listPrice > 0)) return "unknown";
  if (listPrice < 75_000) return "<75k";
  if (listPrice < 150_000) return "75-150k";
  if (listPrice < 250_000) return "150-250k";
  if (listPrice < 400_000) return "250-400k";
  return "400k+";
}

function bucketize(key: string, rows: SoldFeedbackRow[]): SoldFeedbackBucket {
  const l2s: number[] = [];
  const o2s: number[] = [];
  const psf: number[] = [];
  const days: number[] = [];
  for (const r of rows) {
    const sale = r.reportedSalePrice ?? 0;
    if (r.listPrice && r.listPrice > 0) l2s.push(sale / r.listPrice);
    if (r.openerUsd && r.openerUsd > 0) o2s.push(r.openerUsd / sale);
    if (r.buildingSqFt && r.buildingSqFt > 0) psf.push(sale / r.buildingSqFt);
    if (r.lastOutreachDate && r.reportedSaleDate) {
      const d = (Date.parse(r.reportedSaleDate) - Date.parse(r.lastOutreachDate)) / 86_400_000;
      if (Number.isFinite(d) && d >= 0) days.push(Math.round(d));
    }
  }
  const listToSaleMedian = median(l2s);
  return {
    key,
    n: rows.length,
    listToSaleMedian,
    openerToSaleMedian: median(o2s),
    salePerSqftMedian: median(psf),
    daysOpenerToSaleMedian: median(days),
    suggestedAnchorPct: suggestedAnchorPct(listToSaleMedian, rows.length),
    saturated: rows.length >= MIN_SAMPLE && (listToSaleMedian ?? 0) >= SATURATED_LIST_TO_SALE,
  };
}

/** Pure: aggregate every listing that carries a reported sale into per-zip
 *  and per-price-band buckets plus a comp-shaped list. Rows without a
 *  positive reported price are ignored. */
export function computeSoldFeedback(
  rows: SoldFeedbackRow[],
  now: () => Date = () => new Date(),
): SoldFeedbackReport {
  const withSale = rows.filter((r) => typeof r.reportedSalePrice === "number" && r.reportedSalePrice! > 0);
  const byZipRows = new Map<string, SoldFeedbackRow[]>();
  const byBandRows = new Map<string, SoldFeedbackRow[]>();
  for (const r of withSale) {
    const zip = (r.zip ?? "").toString().trim().slice(0, 5) || "unknown";
    byZipRows.set(zip, [...(byZipRows.get(zip) ?? []), r]);
    const band = priceBand(r.listPrice);
    byBandRows.set(band, [...(byBandRows.get(band) ?? []), r]);
  }
  const byZip: Record<string, SoldFeedbackBucket> = {};
  for (const [k, v] of byZipRows) byZip[k] = bucketize(k, v);
  const byPriceBand: Record<string, SoldFeedbackBucket> = {};
  for (const [k, v] of byBandRows) byPriceBand[k] = bucketize(k, v);
  return {
    computedAt: now().toISOString(),
    sampleSize: withSale.length,
    byZip,
    byPriceBand,
    reportedSales: withSale.map((r) => ({
      id: r.id,
      address: r.address ?? null,
      zip: r.zip ?? null,
      state: r.state ?? null,
      sqft: r.buildingSqFt ?? null,
      salePrice: r.reportedSalePrice as number,
      perSqft: r.buildingSqFt && r.buildingSqFt > 0 ? Math.round((r.reportedSalePrice as number) / r.buildingSqFt) : null,
      listPrice: r.listPrice ?? null,
      openerUsd: r.openerUsd ?? null,
      saleDate: r.reportedSaleDate ?? null,
    })),
  };
}

/** KV key the daily roll-up writes and the (flag-gated) opener hook reads. */
export const SOLD_FEEDBACK_KV_KEY = "sold_feedback:latest";

/** Pure: opener pct for a zip from a stored report — default when the flag
 *  is off, the report is missing, or the zip is unknown. Clamped to the band
 *  no matter what the stored JSON says. */
export function anchorPctForZip(
  zip: string | null | undefined,
  report: SoldFeedbackReport | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { pct: number; source: "default" | "sold_feedback_map"; bucket: SoldFeedbackBucket | null } {
  const on = (env.H2_SOLD_FEEDBACK_MAP ?? "").trim() === "1";
  const key = (zip ?? "").toString().trim().slice(0, 5);
  const bucket = on && report && key ? report.byZip[key] ?? null : null;
  if (!bucket || bucket.n < MIN_SAMPLE) return { pct: ANCHOR_PCT_DEFAULT, source: "default", bucket: null };
  const pct = Math.min(ANCHOR_PCT_MAX, Math.max(ANCHOR_PCT_MIN, bucket.suggestedAnchorPct));
  return { pct, source: "sold_feedback_map", bucket };
}

// ── Backfill reader ──────────────────────────────────────────────────────

/** The inbound blocks quo-sync / the webhook write: "L3 INBOUND: <CLASS>. Body: <text>"
 *  followed by a "[Quo inbound msg AC... ts=<iso> ...]" receipt. */
const INBOUND_BLOCK_RE = /L3 INBOUND:[^\n]*?Body:\s*([\s\S]*?)\n\[Quo inbound msg AC[0-9a-f]+ ts=([0-9T:.\-Z]+)/gi;

/** Pure: the LATEST reported sale inside a notes blob — the backfill reader
 *  for replies that landed before the capture hook existed. */
export function scanNotesForReportedSale(notes: string | null | undefined): { price: number; kind: string; ts: string } | null {
  if (!notes) return null;
  const re = new RegExp(INBOUND_BLOCK_RE.source, INBOUND_BLOCK_RE.flags);
  let m: RegExpExecArray | null;
  let latest: { price: number; kind: string; ts: string } | null = null;
  while ((m = re.exec(notes)) != null) {
    const sale = detectReportedSale(m[1]);
    if (sale) latest = { price: sale.price, kind: sale.kind, ts: m[2] };
  }
  return latest;
}
