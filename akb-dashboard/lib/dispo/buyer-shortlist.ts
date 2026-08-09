// DISPO — manual buyer shortlist. @agent: scout
//
// WHY THIS IS DELIBERATELY MANUAL (2026-08-09, operator instruction).
// The whole point of shipping dispo by hand first is that a human desk
// working five names beats a perfect blast engine that ships next quarter.
// This module therefore RANKS AND EXPLAINS. It never sends, never writes,
// and never scores in a way the operator cannot audit on the phone.
//
// THE POSTURE INVERSION, stated because it contradicts the rest of the
// system. Send gates fail CLOSED — an unknown means do not text. This is a
// CALL LIST: nothing leaves the building, so a false positive costs one
// wasted phone call while a false negative silently hides the buyer who
// would have closed the deal. So unknowns are INCLUDED and LABELLED, never
// dropped. The ranking carries the doubt; the filter does not.
//
// WHAT THE DATA ACTUALLY SUPPORTS (measured 2026-08-09 against the 77-row
// Buyers table, not assumed): state is populated on most rows, ZIP on ~10
// and usually as prose, a price box on 5, a rating on ~25. That is enough
// to order a call list honestly and NOT enough for automated scoring — so
// every result carries its evidence and no result claims a precision the
// row cannot support.

import type { Buyer } from "@/lib/types";

/** How the buyer's geography lined up with the subject. Ordered by strength. */
export type GeoEvidence =
  | "zip_confirmed"    // deal ZIP appears in the buyer's ZIP list
  | "zip_unconfirmed"  // ZIP appears, but the operator annotated it as unconfirmed
  | "state"            // state matched; no usable ZIP data
  | "no_match"         // buyer HAS stated geography and this deal is outside it
  | "none";            // no geographic data on the buyer at all
//
// "no_match" and "none" must stay distinct. A buyer who told us they buy in
// Michigan and is being shown a Memphis deal is a screened-out buyer; a buyer
// with an empty profile is an unscreened one who may well take it. Collapsing
// them would report the second as evidence and hide how thin the rolodex is.

/** How the deal price sat against the buyer's stated box. */
export type PriceEvidence =
  | "in_box"     // within [min, max]
  | "unknown"    // no price box on record — the common case
  | "below_min"  // under the buyer's stated floor
  | "over_max";  // above the buyer's stated ceiling

export type NormalizedRating = "A" | "B" | "C" | null;

export interface ShortlistBuyer {
  buyerId: string;
  name: string;
  company: string | null;
  phone: string | null;
  email: string | null;
  score: number;
  geo: GeoEvidence;
  price: PriceEvidence;
  rating: NormalizedRating;
  cashBuyer: boolean;
  pofUsable: boolean;
  /** Days since last contact, or null when never contacted / unparseable.
   *  Surfaced rather than scored — the operator decides what counts as
   *  pestering, and a stale number should not silently reorder the list. */
  daysSinceContact: number | null;
  /** Outside the buyer's own stated box. Still returned — a self-reported
   *  ceiling from months ago is not authority to hide a cash buyer — but
   *  separated so the top of the list stays clean. */
  outsideStatedBox: boolean;
  /** Plain-language why, in rank order. This is the product: the operator
   *  reads these on the phone. */
  reasons: string[];
}

export interface ShortlistSubject {
  recordId: string;
  address: string;
  zip: string | null;
  state: string | null;
  city: string | null;
  /** The number we would actually assign at. Null is allowed — price
   *  matching simply degrades to "unknown" rather than guessing. */
  price: number | null;
}

export interface ShortlistResult {
  subject: ShortlistSubject;
  /** Top slice, callable-first, outsideStatedBox excluded. */
  top: ShortlistBuyer[];
  /** Everything scored, ranked, including outsideStatedBox rows. */
  ranked: ShortlistBuyer[];
  /** Counts the operator needs to judge whether the list is thin because
   *  the rolodex is thin or because the matching is wrong. */
  coverage: {
    buyersConsidered: number;
    /** Attributed to the FIRST matching exclusion reason — a row that is both
     *  a delete artifact and Inactive counts once, as a test record. */
    excludedInactive: number;
    excludedTestRecords: number;
    withZipMatch: number;
    withStateMatch: number;
    /** Screened OUT by their own stated geography. */
    withGeoMismatch: number;
    /** No geography on file at all — unscreened, not rejected. */
    withNoGeoData: number;
    withPhone: number;
    outsideStatedBox: number;
  };
}

// ── Scoring weights ───────────────────────────────────────────────────
// Deliberately small integers that add up in the head. A competitor's
// "Investor Score" is an unexplained number; this one is meant to be
// re-derivable by the operator from the reasons list alone.
const W = {
  zipConfirmed: 50,
  zipUnconfirmed: 32,
  state: 20,
  // A buyer who TOLD us where they buy, where this deal is not, is weaker
  // evidence than a blank profile — the blank one might take anything, this
  // one already said no. Found live on 2026-08-09: without this penalty a
  // Memphis/Mississippi buyer outranked the only Ohio buyer on a Cleveland
  // deal, purely on price-box and rating points. Geography is the strongest
  // signal in dispo and a zero here let the weaker signals overturn it.
  geoMismatch: -25,
  priceInBox: 25,
  priceUnknown: 8,
  ratingA: 20,
  ratingB: 12,
  ratingC: 4,
  cashBuyer: 5,
  pofUsable: 5,
  recentBuyer: 8,
  hasPhone: 10,
} as const;

/** Ratings arrived in two vocabularies — bare "A"/"B" from the March import
 *  and emoji-prefixed "🟢 A - Top Buyer" / "⚪ C - Cold buyer" from April's.
 *  Both are live in the table right now. Read the first standalone A/B/C
 *  letter rather than matching either vocabulary, so a third one does not
 *  silently score as null. ("🟡 B - Workflow contact" is a contact, not a
 *  buyer grade, but it self-describes as B and we take it at its word.) */
export function normalizeRating(raw: string | null | undefined): NormalizedRating {
  if (!raw) return null;
  const m = raw.match(/\b([ABC])\b/);
  return m ? (m[1] as NormalizedRating) : null;
}

/** Pull 5-digit ZIPs out of an operator-written free-text field. Requires
 *  exact 5-digit runs so street numbers and highway names ("East of HWY 51")
 *  do not register. */
export function parseZips(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return Array.from(raw.matchAll(/(?<!\d)(\d{5})(?!\d)/g)).map((m) => m[1]);
}

/** Two-letter state codes from "TN, MS" / "TX" / "TN, AR". */
export function parseStates(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return Array.from(raw.toUpperCase().matchAll(/\b([A-Z]{2})\b/g)).map((m) => m[1]);
}

/** The operator writes their own confidence into the ZIP field — "78245
 *  (unconfirmed — contacted once)". That is real signal and outranks any
 *  inference we could make, so a ZIP hit on a field carrying doubt scores
 *  below a clean one. */
export function zipFieldIsUnconfirmed(raw: string | null | undefined): boolean {
  return !!raw && /\bunconfirmed\b/i.test(raw);
}

/** Obvious non-buyers that must never reach a call list. Narrow and literal
 *  on purpose — a broad heuristic here would silently drop real buyers. */
export function looksLikeTestRecord(name: string | null | undefined): boolean {
  if (!name) return false;
  return /\(TEST\)|^\s*\[DELETE\]/i.test(name);
}

function daysBetween(fromIso: string | null | undefined, now: Date): number | null {
  if (!fromIso) return null;
  const t = Date.parse(fromIso);
  if (Number.isNaN(t)) return null;
  return Math.floor((now.getTime() - t) / 86_400_000);
}

/** POF is only worth credit if it is on file AND not expired. An expired
 *  proof of funds is not a weaker yes, it is a no — treat it as absent. */
function pofIsUsable(b: Buyer, now: Date): boolean {
  if (!b.proofOfFundsOnFile) return false;
  if (!b.pofExpiryDate) return true; // on file, no expiry recorded
  const t = Date.parse(b.pofExpiryDate);
  if (Number.isNaN(t)) return true;
  return t >= now.getTime();
}

function scoreOne(b: Buyer, subject: ShortlistSubject, now: Date): ShortlistBuyer {
  const reasons: string[] = [];
  let score = 0;

  // ── Geography ───────────────────────────────────────────────────────
  const zips = parseZips(b.preferredZipCodes);
  const states = parseStates(b.preferredStates);
  const subjZip = subject.zip?.trim() ?? null;
  const subjState = subject.state?.trim().toUpperCase() ?? null;

  let geo: GeoEvidence = "none";
  if (subjZip && zips.includes(subjZip)) {
    if (zipFieldIsUnconfirmed(b.preferredZipCodes)) {
      geo = "zip_unconfirmed";
      score += W.zipUnconfirmed;
      reasons.push(`ZIP ${subjZip} listed but marked unconfirmed`);
    } else {
      geo = "zip_confirmed";
      score += W.zipConfirmed;
      reasons.push(`Buys in ${subjZip}`);
    }
  } else if (subjState && states.includes(subjState)) {
    geo = "state";
    score += W.state;
    reasons.push(`Buys in ${subjState}, no ZIP detail on file`);
  } else if (states.length === 0 && zips.length === 0) {
    geo = "none";
    reasons.push("No geography on file — unscreened");
  } else {
    // Has geo data and the subject matched none of it. Scores nothing, but
    // is NOT filtered — a stated buy box goes stale and a cash buyer will
    // cross a line they wrote months ago for the right number.
    geo = "no_match";
    score += W.geoMismatch;
    reasons.push(
      `Stated area (${[...states, ...zips].slice(0, 4).join(", ")}) does not include this deal`,
    );
  }

  // ── Price box ───────────────────────────────────────────────────────
  let price: PriceEvidence = "unknown";
  const p = subject.price;
  const hasMin = typeof b.minPrice === "number" && b.minPrice > 0;
  const hasMax = typeof b.maxPrice === "number" && b.maxPrice > 0;
  if (p == null || (!hasMin && !hasMax)) {
    price = "unknown";
    score += W.priceUnknown;
    if (hasMin || hasMax) reasons.push("No deal price to test against their box");
    else reasons.push("No price box on file");
  } else if (hasMax && p > (b.maxPrice as number)) {
    price = "over_max";
    reasons.push(`Above their stated max of $${(b.maxPrice as number).toLocaleString()}`);
  } else if (hasMin && p < (b.minPrice as number)) {
    price = "below_min";
    reasons.push(`Below their stated min of $${(b.minPrice as number).toLocaleString()}`);
  } else {
    price = "in_box";
    score += W.priceInBox;
    reasons.push("Inside their stated price box");
  }

  // ── Credibility ─────────────────────────────────────────────────────
  const rating = normalizeRating(b.buyerRating);
  if (rating === "A") { score += W.ratingA; reasons.push("Rated A"); }
  else if (rating === "B") { score += W.ratingB; reasons.push("Rated B"); }
  else if (rating === "C") { score += W.ratingC; reasons.push("Rated C — cold"); }

  if (b.cashBuyer) { score += W.cashBuyer; reasons.push("Cash buyer"); }

  const pofUsable = pofIsUsable(b, now);
  if (pofUsable) { score += W.pofUsable; reasons.push("Proof of funds on file"); }
  else if (b.proofOfFundsOnFile) reasons.push("Proof of funds on file but EXPIRED");

  const recent = b.dealsPurchasedLast12Months?.trim();
  if (recent && !/^0\b|\bnone\b/i.test(recent)) {
    score += W.recentBuyer;
    reasons.push(`Bought in last 12mo: ${recent}`);
  }

  // ── Reachability ────────────────────────────────────────────────────
  const phone = b.buyerPhone?.trim() || null;
  if (phone) { score += W.hasPhone; }
  else reasons.push("No phone on file — email only");

  const daysSinceContact = daysBetween(b.lastContactedAt, now);
  if (daysSinceContact != null && daysSinceContact <= 7) {
    reasons.push(`Contacted ${daysSinceContact}d ago`);
  }

  return {
    buyerId: b.id,
    name: b.buyerName,
    company: b.companyName ?? null,
    phone,
    email: b.buyerEmail ?? null,
    score,
    geo,
    price,
    rating,
    cashBuyer: b.cashBuyer,
    pofUsable,
    daysSinceContact,
    outsideStatedBox: price === "over_max" || price === "below_min",
    reasons,
  };
}

export interface BuildShortlistOpts {
  subject: ShortlistSubject;
  buyers: Buyer[];
  /** How many to put in `top`. The manual desk works five. */
  topN?: number;
  now?: Date;
}

/**
 * Pure. Rank the rolodex against one deal and explain every placement.
 *
 * Buyers with NO geographic overlap are still ranked (they may simply have
 * an empty profile), but they sink on score rather than being filtered —
 * see the posture note at the top of this file.
 */
export function buildBuyerShortlist(opts: BuildShortlistOpts): ShortlistResult {
  const { subject, buyers } = opts;
  const topN = opts.topN ?? 5;
  const now = opts.now ?? new Date();

  let excludedInactive = 0;
  let excludedTestRecords = 0;
  const eligible: Buyer[] = [];
  for (const b of buyers) {
    if (looksLikeTestRecord(b.buyerName)) { excludedTestRecords++; continue; }
    if ((b.buyerStatus ?? "").toLowerCase() === "inactive") { excludedInactive++; continue; }
    eligible.push(b);
  }

  const scored = eligible.map((b) => scoreOne(b, subject, now));
  // Score desc, then reachable-first, then name for a stable order.
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      Number(!!b.phone) - Number(!!a.phone) ||
      a.name.localeCompare(b.name),
  );

  const top = scored.filter((s) => !s.outsideStatedBox).slice(0, topN);

  return {
    subject,
    top,
    ranked: scored,
    coverage: {
      buyersConsidered: eligible.length,
      excludedInactive,
      excludedTestRecords,
      withZipMatch: scored.filter((s) => s.geo === "zip_confirmed" || s.geo === "zip_unconfirmed").length,
      withStateMatch: scored.filter((s) => s.geo === "state").length,
      withGeoMismatch: scored.filter((s) => s.geo === "no_match").length,
      withNoGeoData: scored.filter((s) => s.geo === "none").length,
      withPhone: scored.filter((s) => !!s.phone).length,
      outsideStatedBox: scored.filter((s) => s.outsideStatedBox).length,
    },
  };
}
