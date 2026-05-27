// Listing-text scoping (Phase 2 rebalance — pure, testable).
// @agent: scout
//
// Carves the SUBJECT listing's own text out of raw Firecrawl portal markdown,
// dropping cross-listing noise that drove the 0%-accept false rejects. Three
// independent line-strippers, composed into the two scope views verifyListing
// scans:
//   scopeSubjectText (reno / wholesaler / distress) = comps + empty-facts rows
//   scopeStatusText  (inactive markers)             = comps + sale/tax history
//
// Why scope, per live ?debug=true forensics on 78201 (P0 Phase 1):
//   - a $790K "NEW CONSTRUCTION" comp in the "Nearby similar homes" sidebar
//     matched renovation keywords against a $140K distress subject.
//   - Redfin's "Year Renovated: —" facts row (em-dash = NOT renovated) matched
//     the bare word "renovated".
//   - "Listing Removed" rows in "Sale & Tax History" (prior-year events)
//     matched inactive markers against a still-active subject.
//
// Direction of caution: comps + history always render AFTER the subject's own
// description/status on Redfin/Zillow, so dropping from those section
// boundaries onward can only shed cross-listing noise — never the subject's
// distress copy (which is the unrecoverable false-reject cost).

/** Section headers that begin the cross-listing comps block. Matched per-line
 *  against the normalized header text (startsWith). */
const COMPS_HEADERS: readonly string[] = [
  "nearby similar homes",
  "similar homes",
  "nearby homes",
  "homes for sale near",
  "homes near you",
  "homes near",
  "recently sold",
  "nearby recently sold",
  "comparable sales",
  "comparable homes",
];

/** Section headers that begin the sale/tax/price history block. */
const HISTORY_HEADERS: readonly string[] = [
  "sale & tax history",
  "sale and tax history",
  "property history",
  "price history",
  "tax history",
  "listing history",
];

/** Placeholder values that mean a facts-table field is EMPTY (the em-dash
 *  trick). A row whose value is one of these carries no real signal — only the
 *  bare label word, which must not match a keyword. */
const EMPTY_FACTS_VALUE = /^(—|–|-{1,2}|n\/?a|none|null|tbd)$/i;

/** Pure: strip leading markdown heading/bullet/table markers + trailing
 *  emphasis, lowercased — so "## Nearby similar homes" → "nearby similar
 *  homes". */
function normalizeHeaderLine(line: string): string {
  return line
    .replace(/^[\s>#*_•|]+/, "")
    .replace(/[*_#|]+\s*$/, "")
    .trim()
    .toLowerCase();
}

/** Pure: a markdown ATX heading line (`#`..`######` + text). */
function isSectionHeading(line: string): boolean {
  return /^\s{0,3}#{1,6}\s+\S/.test(line);
}

function isCompsHeader(line: string): boolean {
  const n = normalizeHeaderLine(line);
  if (!n) return false;
  return COMPS_HEADERS.some((h) => n.startsWith(h));
}

function isHistoryHeader(line: string): boolean {
  const n = normalizeHeaderLine(line);
  if (!n) return false;
  return HISTORY_HEADERS.some((h) => n.startsWith(h));
}

/** Pure: a short facts-table label (letters/spaces/&()/-), not a sentence. */
function isLabelish(s: string): boolean {
  const t = s.replace(/^[#>*_\s-]+/, "").trim();
  return t.length > 0 && t.length <= 30 && /^[A-Za-z][A-Za-z0-9 /&()'.-]*$/.test(t) && !/[.!?]$/.test(t);
}

/** Pure: a facts-table row whose VALUE is an empty placeholder, e.g.
 *  "Year Renovated: —", "| Year Renovated | — |", "Year Renovated —". */
export function isEmptyFactsRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  // Markdown table row: drop empty edge cells → [label, value].
  if (trimmed.includes("|")) {
    const cells = trimmed.split("|").map((c) => c.trim()).filter((c) => c.length > 0);
    if (cells.length === 2 && isLabelish(cells[0]) && EMPTY_FACTS_VALUE.test(cells[1])) return true;
  }
  // "Label: <empty>" form.
  const colon = trimmed.match(/^(.+?)\s*:\s*(.+)$/);
  if (colon && isLabelish(colon[1]) && EMPTY_FACTS_VALUE.test(colon[2].trim())) return true;
  // "Label —" form (lone em/en-dash value, no colon).
  const dash = trimmed.match(/^(.+?)\s+(—|–)$/);
  if (dash && isLabelish(dash[1])) return true;
  return false;
}

/** Pure: drop the comps sidebar — everything from the first comps-section
 *  header onward. */
export function stripCompsSection(md: string): string {
  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (isCompsHeader(lines[i])) return lines.slice(0, i).join("\n");
  }
  return md;
}

/** Pure: drop facts-table rows whose value is an empty placeholder. */
export function stripEmptyFactsRows(md: string): string {
  return md
    .split("\n")
    .filter((line) => !isEmptyFactsRow(line))
    .join("\n");
}

/** Pure: remove an INLINE empty "Year renovated —" facts token (em/en-dash or
 *  bare hyphen = NOT renovated) so the bare word "renovated" can't match. The
 *  row-based stripper misses this because Redfin renders the whole facts table
 *  as one multi-field line: "… Lot size 7,560 Sq. Ft. Year renovated —
 *  Finished Sq. Ft. 1,044 …". A populated "Year renovated 2015" is left intact
 *  (a real renovation signal) via the no-following-digit lookahead. */
export function stripInlineEmptyReno(md: string): string {
  return md.replace(/\byear\s+renovated\s*[—–-]+(?!\s*\d)/gi, " ");
}

/** Pure: remove a "New construction: No" facts token (Zillow's "Facts &
 *  Features" row, e.g. "… Pre-Owned - New construction: No - Year built: 1949")
 *  so the phrase "new construction" can't match as renovation evidence on a
 *  listing that explicitly states it is NOT new construction. "New
 *  construction: Yes" is left intact — that's a real positive signal. */
export function stripInlineNewConstructionNo(md: string): string {
  return md.replace(/\bnew\s+construction\s*:\s*no\b/gi, " ");
}

/** Pure: drop sale/tax/price history blocks — from a history-section header
 *  until the next (non-history) section heading or comps header. Top-of-page
 *  status (header / "OFF MARKET" banner) is preserved, so a genuinely inactive
 *  subject still trips the inactive markers; prior-year history rows do not. */
export function stripHistorySection(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let inHistory = false;
  for (const line of lines) {
    if (isHistoryHeader(line)) {
      inHistory = true;
      continue;
    }
    if (inHistory) {
      if (isCompsHeader(line) || isSectionHeading(line)) {
        inHistory = false;
        out.push(line);
      }
      continue; // drop history rows
    }
    out.push(line);
  }
  return out.join("\n");
}

/** Pure: text scanned for renovation / wholesaler / distress keywords —
 *  comps sidebar + empty facts rows removed. */
export function scopeSubjectText(md: string | null | undefined): string {
  if (!md) return "";
  return stripInlineNewConstructionNo(stripInlineEmptyReno(stripEmptyFactsRows(stripCompsSection(md))));
}

/** Pure: text scanned for inactive markers — comps sidebar + sale/tax history
 *  removed (so only current status indicators remain). */
export function scopeStatusText(md: string | null | undefined): string {
  if (!md) return "";
  return stripHistorySection(stripCompsSection(md));
}
