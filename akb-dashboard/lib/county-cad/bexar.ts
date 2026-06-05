// Bexar CAD (Bexar County Appraisal District) tax re-source — 2026-06-05.
// @agent: appraiser
//
// RentCast's /properties.propertyTaxes for Bexar County records returns
// the COUNTY portion only — e.g. $555/yr on 5435 Callaghan, which is
// impossible for TX (combined rates run 2.2-2.5% of value across county
// + school district + city + utility districts). Using that number
// understates landlord opex and inflates MAO.
//
// This module re-sources annual property taxes from Bexar CAD's public
// search via Firecrawl. The CAD page exposes the assessed value + the
// taxing-unit breakdown; we extract the most-recent year's TOTAL.
//
// Returns a REPORT object — never throws, never writes Airtable. When
// extraction can't pin a single confident number, it surfaces:
//   - the assessed value (used as a fallback basis for the operator)
//   - the raw markdown excerpt for visual confirmation
//   - a derived-tax estimate from a sourced county-wide effective rate
//     (clearly labeled "derived, not direct"), surfaced for operator
//     review.
//
// The operator confirms before any number drives offer math.

const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;
const FIRECRAWL_SEARCH_URL = "https://api.firecrawl.dev/v2/search";

/** Bexar County combined effective property-tax rate, fraction of
 *  assessed value. Sourced from the operator-confirmed "1.5-2%+" range
 *  (combined county + school + city + utility districts; Bexar is on
 *  the lower end of TX metros). Used ONLY as a DERIVED fallback when
 *  the CAD scrape can't pin a direct tax total — clearly labeled in
 *  provenance. Operator-tunable via env without a deploy. */
export const BEXAR_EFFECTIVE_TAX_RATE = Number(
  process.env.BEXAR_EFFECTIVE_TAX_RATE ?? "0.023",
);

export interface BexarCadTaxResource {
  /** Direct annual tax total from the CAD scrape, or null if not pinned. */
  directAnnualTaxes: number | null;
  /** Assessed value pulled from the CAD page, or null. */
  assessedValue: number | null;
  /** Derived estimate when direct extraction failed:
   *  assessedValue × BEXAR_EFFECTIVE_TAX_RATE. Surfaced for operator
   *  review — NEVER auto-substituted into offer math. */
  derivedAnnualTaxes: number | null;
  /** Operator-recommended number to use, pending confirmation:
   *  prefer direct; else derived; else null (HOLD). */
  recommendedAnnualTaxes: number | null;
  source: "bexar_cad_firecrawl_direct" | "bexar_cad_firecrawl_derived" | null;
  /** Provenance for Maverick / operator confirmation. */
  provenance: string;
  /** First ~500 chars of the scraped markdown around the tax/value
   *  context — operator can eyeball it. */
  rawExcerpt: string | null;
  /** URL we scraped (or attempted to). */
  url: string | null;
  /** Diagnostic. */
  firecrawlStatus: number | null;
  error: string | null;
}

/** Pure: extract the most likely "annual property tax total" from a
 *  CAD-page markdown body. Looks for $-amounts in proximity to
 *  tax-context phrases. Returns the highest-confidence single number,
 *  or null. */
export function extractAnnualTaxesFromCadMarkdown(markdown: string): {
  total: number | null;
  matchContext: string | null;
} {
  if (!markdown) return { total: null, matchContext: null };
  // Bexar CAD detail pages typically render a "Estimated Taxes" or
  // "Total Tax Levy" row in a taxing-unit summary. Look for those
  // phrases followed by a $N,NNN amount within ~80 chars.
  const PHRASES = [
    "total tax levy",
    "estimated taxes",
    "total estimated taxes",
    "total taxes",
    "tax due",
    "estimated tax",
    "annual tax",
    "total tax",
  ];
  const lc = markdown.toLowerCase();
  let bestAmount: number | null = null;
  let bestContext: string | null = null;
  for (const phrase of PHRASES) {
    let idx = lc.indexOf(phrase);
    while (idx !== -1) {
      const window = markdown.slice(idx, Math.min(markdown.length, idx + 200));
      const m = window.match(/\$\s*([\d,]+(?:\.\d{1,2})?)/);
      if (m) {
        const n = Number(m[1].replace(/,/g, ""));
        if (Number.isFinite(n) && n > 100 && n < 200_000) {
          // Prefer the FIRST match per phrase priority order.
          if (bestAmount == null) {
            bestAmount = Math.round(n);
            bestContext = window.replace(/\s+/g, " ").slice(0, 180);
          }
        }
      }
      idx = lc.indexOf(phrase, idx + phrase.length);
    }
    if (bestAmount != null) break;
  }
  return { total: bestAmount, matchContext: bestContext };
}

/** Pure: extract an assessed/market value from CAD markdown. Looks for
 *  the typical "Market Value", "Appraised Value", or "Assessed Value"
 *  rows. Conservative — picks the highest of the three to be safe (CAD
 *  values are usually low vs market; assumes the page exposes the most
 *  recent year). */
export function extractAssessedValueFromCadMarkdown(markdown: string): number | null {
  if (!markdown) return null;
  const PHRASES = ["market value", "appraised value", "assessed value", "total value", "value (market)"];
  const lc = markdown.toLowerCase();
  let best: number | null = null;
  for (const phrase of PHRASES) {
    let idx = lc.indexOf(phrase);
    while (idx !== -1) {
      const window = markdown.slice(idx, Math.min(markdown.length, idx + 200));
      const m = window.match(/\$\s*([\d,]+)/);
      if (m) {
        const n = Number(m[1].replace(/,/g, ""));
        if (Number.isFinite(n) && n > 10_000 && n < 5_000_000) {
          if (best == null || n > best) best = Math.round(n);
        }
      }
      idx = lc.indexOf(phrase, idx + phrase.length);
    }
  }
  return best;
}

/** Pure: format the Bexar CAD search query Firecrawl will resolve. */
export function buildBexarCadQuery(input: { address: string; city: string; zip: string }): string {
  return `${input.address} ${input.city} ${input.zip} Bexar Appraisal District property tax`.trim();
}

/** I/O wrapper. Never throws. Returns nulls on any failure → operator
 *  HOLDs and reads the rawExcerpt to confirm manually. */
export async function fetchBexarCadTaxes(input: {
  address: string;
  city: string;
  zip: string;
}): Promise<BexarCadTaxResource> {
  const base: BexarCadTaxResource = {
    directAnnualTaxes: null,
    assessedValue: null,
    derivedAnnualTaxes: null,
    recommendedAnnualTaxes: null,
    source: null,
    provenance: "",
    rawExcerpt: null,
    url: null,
    firecrawlStatus: null,
    error: null,
  };
  if (!FIRECRAWL_API_KEY) {
    return { ...base, error: "FIRECRAWL_API_KEY not set" };
  }

  const query = buildBexarCadQuery(input);
  try {
    const res = await fetch(FIRECRAWL_SEARCH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        limit: 5,
        scrapeOptions: { formats: [{ type: "markdown" }] },
      }),
      cache: "no-store",
    });
    base.firecrawlStatus = res.status;
    if (!res.ok) {
      return { ...base, error: `Firecrawl search ${res.status}` };
    }
    const body = (await res.json()) as {
      data?: { web?: Array<{ url?: string; title?: string; markdown?: string }> };
    };
    const candidates = body.data?.web ?? [];
    // Prefer a bcad.org result; else first with a non-empty markdown.
    const pick =
      candidates.find((r) => (r.url ?? "").includes("bcad.org") && r.markdown) ??
      candidates.find((r) => r.markdown);
    if (!pick) {
      return { ...base, error: "no bcad.org / no markdown in Firecrawl result" };
    }
    base.url = pick.url ?? null;
    const md = pick.markdown ?? "";

    const { total, matchContext } = extractAnnualTaxesFromCadMarkdown(md);
    const assessed = extractAssessedValueFromCadMarkdown(md);
    base.directAnnualTaxes = total;
    base.assessedValue = assessed;
    base.rawExcerpt = matchContext ?? md.replace(/\s+/g, " ").slice(0, 500);

    if (total != null) {
      base.recommendedAnnualTaxes = total;
      base.source = "bexar_cad_firecrawl_direct";
      base.provenance =
        `Bexar CAD via Firecrawl (${pick.url ?? "unknown URL"}): extracted direct annual tax total $${total.toLocaleString()} from "${(matchContext ?? "").slice(0, 80)}…". CONFIRM by reading the bcad.org page.`;
      return base;
    }
    if (assessed != null) {
      const derived = Math.round(assessed * BEXAR_EFFECTIVE_TAX_RATE);
      base.derivedAnnualTaxes = derived;
      base.recommendedAnnualTaxes = derived;
      base.source = "bexar_cad_firecrawl_derived";
      base.provenance =
        `Bexar CAD via Firecrawl (${pick.url ?? "unknown URL"}): no direct tax total extracted — DERIVED from assessed value $${assessed.toLocaleString()} × Bexar combined effective rate ${(BEXAR_EFFECTIVE_TAX_RATE * 100).toFixed(2)}% = $${derived.toLocaleString()}/yr. This is a DERIVED estimate, not a direct CAD number; CONFIRM against the actual taxing-unit breakdown on bcad.org before driving any offer.`;
      return base;
    }
    return {
      ...base,
      error: "could not extract a tax total or assessed value from Firecrawl markdown",
      provenance: `Bexar CAD via Firecrawl (${pick.url ?? "unknown URL"}): scrape returned markdown but extraction patterns matched no usable number. Operator: read rawExcerpt.`,
    };
  } catch (err) {
    return { ...base, error: String(err).slice(0, 300) };
  }
}
