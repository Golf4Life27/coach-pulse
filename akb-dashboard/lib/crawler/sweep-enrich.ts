// SWEEP → RECORD — turn a qualified URL into a textable lead.
// @agent: scout
//
// The sweep proved a ZIP-level search returns real listing pages (2026-08-05:
// 10 qualifiers across 3 legs, 38 Firecrawl credits, ZERO RentCast calls). But
// a qualifier is a URL, and a URL cannot be texted. The gap between "10
// qualified" and "10 contacts" is one field: Agent_Phone. Without it a record
// fails isH2Eligible and never reaches the send lane.
//
// SO THIS IS WHERE THE SCARCE CALL GETS SPENT — and only here. One RentCast
// listings/sale lookup per QUALIFIER, never per scanned property. The old
// intake belt spent a call to scan a whole ZIP blind and discarded ~97% of what
// came back; this spends a call only on a property that already passed the buy
// box, the distress test and every hard veto.
//
// Reuses mapListingToCandidate and buildIntakeListingFields rather than
// inventing a parallel record shape — a swept lead and an intake lead must be
// the same thing downstream, or every gate has to learn about two kinds.

/** Pure: pull a street address out of a portal listing URL.
 *
 *  Zillow:  /homedetails/1234-Elm-St-Detroit-MI-48228/12345_zpid/
 *  Redfin:  /MI/Detroit/1234-Elm-St-48228/home/12345
 *
 *  Returns null rather than a partial guess — a wrong address would spend a
 *  RentCast call on the wrong house and could put a real offer on it. */
export interface ParsedUrlAddress {
  street: string;
  city: string | null;
  state: string | null;
  zip: string;
  /** "1234 Elm St, Detroit, MI 48228" — the form RentCast's address param wants. */
  formatted: string;
}

const STATE_RE = /^[A-Z]{2}$/;
const ZIP_RE = /^\d{5}$/;

function titleFromSlug(slug: string): string {
  return slug.replace(/-/g, " ").trim();
}

export function parseAddressFromListingUrl(url: string | null | undefined): ParsedUrlAddress | null {
  const u = (url ?? "").trim();
  if (!u) return null;

  let path: string;
  try {
    path = new URL(u).pathname;
  } catch {
    return null;
  }
  const segs = path.split("/").filter(Boolean);

  // ── Zillow: homedetails/<street-city-ST-zip>/<id>_zpid
  const hdIdx = segs.indexOf("homedetails");
  if (hdIdx >= 0 && segs[hdIdx + 1]) {
    const parts = segs[hdIdx + 1].split("-");
    if (parts.length < 4) return null;
    const zip = parts[parts.length - 1];
    const state = parts[parts.length - 2]?.toUpperCase() ?? "";
    if (!ZIP_RE.test(zip) || !STATE_RE.test(state)) return null;
    // City is one or more slugs before the state; street is everything before
    // that. Single-token city is the overwhelmingly common case, and a
    // mis-split here only mislabels the city — the street + zip still resolve.
    const city = titleFromSlug(parts[parts.length - 3] ?? "");
    const street = titleFromSlug(parts.slice(0, parts.length - 3).join("-"));
    if (!street) return null;
    return { street, city: city || null, state, zip, formatted: `${street}, ${city}, ${state} ${zip}` };
  }

  // ── Redfin: /<ST>/<City>/<street-zip>/home/<id>
  const homeIdx = segs.indexOf("home");
  if (homeIdx >= 3) {
    const state = segs[homeIdx - 3]?.toUpperCase() ?? "";
    const city = titleFromSlug(segs[homeIdx - 2] ?? "");
    const parts = (segs[homeIdx - 1] ?? "").split("-");
    const zip = parts[parts.length - 1];
    if (!STATE_RE.test(state) || !ZIP_RE.test(zip)) return null;
    const street = titleFromSlug(parts.slice(0, -1).join("-"));
    if (!street || !city) return null;
    return { street, city, state, zip, formatted: `${street}, ${city}, ${state} ${zip}` };
  }

  return null;
}

// ── ADDRESS MATCHING (2026-08-06 fix) ──────────────────────────────────────
//
// The first enrichment run wrote ZERO records: 4 of 5 qualifiers came back
// `no_rentcast_match`. The cause was the SHAPE of the lookup, not a bug — it
// queried RentCast per-property with `?address=<exact string>&status=Active`,
// which is brittle twice over. Portal URL slugs abbreviate ("Elm-St" vs the
// feed's "Elm Street"), so an exact string match fails on formatting alone;
// and filtering on status=Active asks RentCast to CONFIRM inventory Firecrawl
// found, which is partly circular — a listing the feed classifies differently
// simply vanishes.
//
// The fix is the hybrid shape: ONE ZIP fetch per ZIP-with-qualifiers (the call
// already returns ~100 listings WITH agent phones), then match locally. That
// is strictly cheaper — 5 qualifiers in one ZIP cost 1 call instead of 5 — and
// robust to formatting, because matching happens on parsed components rather
// than on a string the vendor has to reproduce exactly.

/** Street-type suffixes normalized to a canonical token so "St" and "Street"
 *  compare equal. Anything unlisted is left as-is. */
const SUFFIX_CANON: Record<string, string> = {
  st: "st", street: "st",
  ave: "ave", av: "ave", avenue: "ave",
  rd: "rd", road: "rd",
  dr: "dr", drive: "dr",
  blvd: "blvd", boulevard: "blvd",
  ln: "ln", lane: "ln",
  ct: "ct", court: "ct",
  pl: "pl", place: "pl",
  cir: "cir", circle: "cir",
  ter: "ter", terrace: "ter",
  pkwy: "pkwy", parkway: "pkwy",
  hwy: "hwy", highway: "hwy",
  way: "way", trl: "trl", trail: "trl",
};

export interface StreetKey {
  /** Leading house number — must match exactly. */
  number: string;
  /** Street name with directionals and suffix removed, lowercased. */
  name: string;
  /** Canonical suffix, or "" when the address carries none. */
  suffix: string;
}

/** Pure: break a street address into comparable parts. Returns null when there
 *  is no leading house number — without one there is nothing safe to match on,
 *  and a wrong match would put a real offer on the wrong house. */
export function streetKey(address: string | null | undefined): StreetKey | null {
  const raw = (address ?? "").split(",")[0]?.trim() ?? "";
  if (!raw) return null;
  const cleaned = raw.toLowerCase().replace(/[.,#]/g, " ").replace(/\s+/g, " ").trim();
  const tokens = cleaned.split(" ").filter(Boolean);
  if (tokens.length < 2) return null;
  const number = tokens[0];
  if (!/^\d+[a-z]?$/.test(number)) return null;

  let rest = tokens.slice(1);
  // Drop a leading directional ("N Elm St" and "Elm St" are the same street in
  // most feeds' formatting variance).
  if (rest.length > 1 && /^(n|s|e|w|ne|nw|se|sw|north|south|east|west)$/.test(rest[0])) {
    rest = rest.slice(1);
  }
  let suffix = "";
  const last = rest[rest.length - 1];
  if (rest.length > 1 && last && SUFFIX_CANON[last]) {
    suffix = SUFFIX_CANON[last];
    rest = rest.slice(0, -1);
  }
  const name = rest.join(" ").trim();
  if (!name) return null;
  return { number, name, suffix };
}

/** Pure: do two addresses refer to the same property?
 *
 *  House number and street name must match. The suffix must match only when
 *  BOTH sides carry one — a feed that omits "St" should not fail an otherwise
 *  identical address, but "1234 Elm St" must never match "1234 Elm Ave". */
export function addressesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = streetKey(a);
  const kb = streetKey(b);
  if (!ka || !kb) return false;
  if (ka.number !== kb.number || ka.name !== kb.name) return false;
  if (ka.suffix && kb.suffix && ka.suffix !== kb.suffix) return false;
  return true;
}

/** Pure: find the feed listing that matches a swept address, or null. */
export function findMatchingListing<T extends { address: string | null }>(
  target: string | null | undefined,
  listings: readonly T[],
): T | null {
  for (const l of listings) {
    if (addressesMatch(target, l.address)) return l;
  }
  return null;
}

/** Pure: is this enriched listing actually textable? The single question that
 *  decides whether a qualifier becomes a lead or stays a URL. A record without
 *  a normalizable agent phone fails isH2Eligible, so writing one just grows the
 *  pile the operator already complained about. */
export function isTextable(agentPhone: string | null | undefined): boolean {
  const p = (agentPhone ?? "").replace(/\D/g, "");
  // 10 digits, or 11 starting with 1 — the shapes normalizePhone accepts.
  return p.length === 10 || (p.length === 11 && p.startsWith("1"));
}

export type EnrichSkipReason =
  | "url_unparseable"
  | "no_rentcast_match"
  | "no_agent_phone"
  | "record_write_failed"
  | "enrich_budget_reached";

export interface EnrichOutcome {
  url: string;
  address: string | null;
  recordId: string | null;
  skipped: EnrichSkipReason | null;
}

/** Pure: roll enrichment outcomes into the run summary. Names WHY qualifiers
 *  did not become leads — the number that decides whether this lane works. */
export function summarizeEnrichment(outcomes: EnrichOutcome[]): {
  attempted: number;
  written: number;
  by_skip: Record<string, number>;
} {
  const by_skip: Record<string, number> = {};
  let written = 0;
  for (const o of outcomes) {
    if (o.recordId) written++;
    else if (o.skipped) by_skip[o.skipped] = (by_skip[o.skipped] ?? 0) + 1;
  }
  return { attempted: outcomes.length, written, by_skip };
}
