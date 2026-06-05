// Redfin "Public Facts" tax extractor — 2026-06-05.
// @agent: appraiser
//
// Redfin's listing-detail pages render a "Public Facts" / "Tax History"
// section sourced directly from the county appraisal district (Bexar CAD
// for SA records). We already hold the Redfin URL in Verification_URL on
// every Active record, so scraping it gives a CAD-grounded annual tax
// total WITHOUT having to crack TrueAutomation's PropAccess search.
//
// Pure extractor + injectable Firecrawl I/O wrapper.

const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;
const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape";

export interface RedfinTaxExtraction {
  /** Most-recent year's "Taxes" $ amount from the Tax History table. */
  annualTaxes: number | null;
  year: number | null;
  /** Most-recent assessed/total value from the same table, when present. */
  assessedValue: number | null;
  matchContext: string | null;
}

/** Pure: pull the most-recent annual taxes + assessed value from Redfin
 *  markdown. Redfin's Tax History table renders as repeated rows like
 *  `Year | Property Taxes | Land Value | Improvements | Total Assessment`
 *  or, in markdown, `| 2024 | $4,287 (+5.2%) | $35,000 | $158,400 | $193,400 |`.
 *  We grab the highest year with a parseable tax amount. */
export function extractRedfinTaxHistory(markdown: string): RedfinTaxExtraction {
  if (!markdown) return { annualTaxes: null, year: null, assessedValue: null, matchContext: null };
  // Markdown table rows that start with a 4-digit year and contain $-
  // amounts. Be permissive about column count + percent annotations.
  const ROW = /\|\s*(\d{4})\s*\|\s*\$\s*([\d,]+)(?:[^\|]*)\|(?:\s*\$\s*([\d,]+)\s*\|)?\s*(?:\$\s*([\d,]+)\s*\|)?\s*\$?\s*([\d,]*)\s*\|/g;
  let bestYear = -Infinity;
  let bestTaxes: number | null = null;
  let bestAssessed: number | null = null;
  let context: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = ROW.exec(markdown)) !== null) {
    const year = Number(m[1]);
    const taxes = Number((m[2] ?? "").replace(/,/g, ""));
    const totalAssessed = Number((m[5] ?? "").replace(/,/g, ""));
    if (
      Number.isFinite(year) && year >= 1990 && year <= 2030 &&
      Number.isFinite(taxes) && taxes > 100 && taxes < 200_000 &&
      year > bestYear
    ) {
      bestYear = year;
      bestTaxes = Math.round(taxes);
      bestAssessed = Number.isFinite(totalAssessed) && totalAssessed > 1000 ? Math.round(totalAssessed) : null;
      context = m[0].replace(/\s+/g, " ").slice(0, 180);
    }
  }
  // Fallback for non-table renderings: look for "Annual Tax Amount $N"
  // (literal annual phrasing). DELIBERATELY EXCLUDES the bare "Property
  // Taxes $N" pattern because Redfin's mortgage-calculator widget renders
  // exactly that with a MONTHLY estimate (e.g. "Property taxes $375"
  // = $375/month), not the annual. Pattern-matching that as annual on
  // 5435 Callaghan returned $375 — which is the monthly tax estimate; the
  // true annual is ~$4,500 (verified against RentCast assessedValue ×
  // Bexar effective rate). Tax-history table extraction (above) remains
  // the authoritative path.
  if (bestTaxes == null) {
    const FALLBACK = /annual tax(?:\s+amount)?[^\$]*\$\s*([\d,]+)/i;
    const fm = markdown.match(FALLBACK);
    if (fm) {
      const n = Number(fm[1].replace(/,/g, ""));
      if (Number.isFinite(n) && n > 100 && n < 200_000) {
        bestTaxes = Math.round(n);
        context = fm[0].replace(/\s+/g, " ").slice(0, 180);
      }
    }
  }
  return {
    annualTaxes: bestTaxes,
    year: bestYear > -Infinity ? bestYear : null,
    assessedValue: bestAssessed,
    matchContext: context,
  };
}

export interface RedfinTaxResource {
  annualTaxes: number | null;
  year: number | null;
  assessedValue: number | null;
  source: "redfin_public_facts" | null;
  provenance: string;
  rawExcerpt: string | null;
  url: string | null;
  firecrawlStatus: number | null;
  error: string | null;
}

export async function fetchRedfinPublicTaxes(verificationUrl: string): Promise<RedfinTaxResource> {
  const base: RedfinTaxResource = {
    annualTaxes: null,
    year: null,
    assessedValue: null,
    source: null,
    provenance: "",
    rawExcerpt: null,
    url: verificationUrl,
    firecrawlStatus: null,
    error: null,
  };
  if (!FIRECRAWL_API_KEY) return { ...base, error: "FIRECRAWL_API_KEY not set" };
  if (!verificationUrl || !verificationUrl.includes("redfin.com")) {
    return { ...base, error: "verificationUrl is not a redfin.com URL" };
  }
  try {
    const res = await fetch(FIRECRAWL_SCRAPE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: verificationUrl, formats: ["markdown"] }),
      cache: "no-store",
    });
    base.firecrawlStatus = res.status;
    if (!res.ok) return { ...base, error: `Firecrawl ${res.status}` };
    const body = (await res.json()) as { data?: { markdown?: string } };
    const md = body.data?.markdown ?? "";
    if (!md) return { ...base, error: "Firecrawl returned no markdown" };
    const e = extractRedfinTaxHistory(md);
    base.annualTaxes = e.annualTaxes;
    base.year = e.year;
    base.assessedValue = e.assessedValue;
    base.rawExcerpt = e.matchContext;
    if (e.annualTaxes != null) {
      base.source = "redfin_public_facts";
      base.provenance =
        `Redfin Public Facts (sourced from Bexar CAD) at ${verificationUrl}: ${e.year} annual taxes $${e.annualTaxes.toLocaleString()}` +
        (e.assessedValue != null ? `, total assessed $${e.assessedValue.toLocaleString()}` : "") +
        `. Confirm against bcad.org before driving any offer.`;
    } else {
      base.error = "Redfin markdown returned but extraction patterns matched no usable tax number";
    }
    return base;
  } catch (err) {
    return { ...base, error: String(err).slice(0, 300) };
  }
}
