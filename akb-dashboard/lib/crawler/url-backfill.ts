// Firecrawl URL-backfill — strict address↔URL confirmation (2026-06-05).
//
// The intake-time Firecrawl verify resolves a portal-detail URL by
// address search, but its internal picker (pickListingResult) accepts a
// result when only the STREET NUMBER token is present — loose enough to
// occasionally latch onto a neighbor / comp on the same block. For the
// URL backfill the operator's bar is higher: "address-confirmed AND
// still-on-market-confirmed, NOT a loose address matcher. Records that
// can't be confirmed come back empty, never fabricated."
//
// So before we persist a resolved URL onto a record, we re-confirm it
// here: the resolved URL's slug must contain BOTH the subject's street
// number AND at least one significant street-name token. Portal URLs
// embed the address in the path (e.g. Redfin
// /TX/Dallas/924-Sunnyside-Ave-75211/home/32118136), so this is a
// reliable, deterministic confirmation. No match → leave the record
// URL-less.
//
// Pure + unit-tested; the route does the I/O.

/** Street-type suffixes + directionals that are too common to count as
 *  a distinguishing street-name token (every block has an "Ave"). */
const ADDRESS_STOPWORDS = new Set([
  "ave", "avenue", "st", "street", "rd", "road", "dr", "drive", "ln", "lane",
  "blvd", "boulevard", "ct", "court", "cir", "circle", "pl", "place", "way",
  "ter", "terrace", "trl", "trail", "pkwy", "parkway", "hwy", "highway",
  "n", "s", "e", "w", "ne", "nw", "se", "sw", "north", "south", "east", "west",
  "apt", "unit", "ste", "suite", "no", "lot",
]);

export interface StrictAddressMatch {
  matched: boolean;
  streetNumber: string | null;
  /** Distinguishing street-name tokens parsed from the subject address. */
  nameTokens: string[];
  /** The name token that matched in the URL (first hit), or null. */
  matchedToken: string | null;
  /** Whether the street number was present in the URL slug. */
  numberInUrl: boolean;
  reason:
    | "matched"
    | "no_street_number"
    | "number_absent_from_url"
    | "no_name_token_match"
    | "no_distinguishing_tokens"
    | "empty_url";
}

/** Pure: normalize any string to a space-delimited lowercase
 *  alphanumeric token stream (slug-friendly). */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Pure: does `url`'s slug confirm it is THIS subject address?
 *  Requires the street number AND ≥1 distinguishing street-name token. */
export function strictAddressUrlMatch(address: string, url: string | null): StrictAddressMatch {
  const base: StrictAddressMatch = {
    matched: false,
    streetNumber: null,
    nameTokens: [],
    matchedToken: null,
    numberInUrl: false,
    reason: "empty_url",
  };
  if (!url || url.trim() === "") return base;

  const addrNorm = normalize(address);
  const streetNumber = addrNorm.match(/^(\d+)\b/)?.[1] ?? null;
  base.streetNumber = streetNumber;
  if (!streetNumber) return { ...base, reason: "no_street_number" };

  // Distinguishing tokens: alphabetic, length ≥ 3, not a street-type /
  // directional stopword. (Numbers other than the street number — e.g.
  // a zip — aren't used as name tokens.)
  const nameTokens = addrNorm
    .split(" ")
    .filter((t) => /^[a-z]+$/.test(t) && t.length >= 3 && !ADDRESS_STOPWORDS.has(t));
  base.nameTokens = nameTokens;
  if (nameTokens.length === 0) {
    // Can't strictly confirm a purely-numeric / stopword-only street
    // name. Conservative: require number + at least one token, so this
    // is a no-confirm.
    return { ...base, reason: "no_distinguishing_tokens" };
  }

  const urlNorm = normalize(url);
  const urlTokens = new Set(urlNorm.split(" "));
  const numberInUrl = urlTokens.has(streetNumber);
  base.numberInUrl = numberInUrl;
  if (!numberInUrl) return { ...base, reason: "number_absent_from_url" };

  const matchedToken = nameTokens.find((t) => urlTokens.has(t)) ?? null;
  base.matchedToken = matchedToken;
  if (!matchedToken) return { ...base, reason: "no_name_token_match" };

  return { ...base, matched: true, reason: "matched" };
}

/** Pure: build the formatted address string Firecrawl searches on. */
export function formatSubjectAddress(input: {
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}): string {
  const line1 = (input.address ?? "").trim();
  const cityStateZip = [input.city, input.state, input.zip]
    .map((s) => (s ?? "").trim())
    .filter(Boolean)
    .join(" ");
  return [line1, cityStateZip].filter(Boolean).join(", ");
}
