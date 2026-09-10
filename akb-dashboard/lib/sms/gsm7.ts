// GSM-7 normalization + segment estimation for outbound SMS.
//
// WHY THIS EXISTS: a "smart" character a word processor or a model likes to
// use — an em-dash, a curly apostrophe, an ellipsis — falls outside the
// GSM-7 alphabet (the 7-bit default SMS charset). ONE such character in an
// otherwise-plain message forces the carrier to encode the WHOLE message as
// UCS-2 (16-bit), which roughly HALVES the characters that fit in a segment
// (160 -> 70 single-segment, 153 -> 67 per concatenated segment) and can
// double the billed segment count. Verified example (the identity-question
// standing answer, lib/standing-answers.ts): the 273-character v1 draft with
// one em-dash billed 5 segments as UCS-2; the 361-character v2 with the
// em-dash replaced by a plain hyphen bills 3 segments as GSM-7 — MORE text,
// FEWER segments, because it stayed in the 7-bit alphabet.
//
// normalizeForGsm7 maps the common smart-character offenders to their
// GSM-7-safe equivalents so a stray em-dash never silently doubles a
// message's cost. estimateSmsSegments reports what a body will actually
// bill, for tests and admin tooling that want to see the number.

/** Smart-character -> GSM-7-safe replacement. Order doesn't matter — every
 *  match is a single literal character, none overlap. */
const REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  // em dash, en dash, figure dash -> plain hyphen.
  [/[—–‒]/g, "-"],
  // curly single quotes / apostrophe -> straight apostrophe.
  [/[‘’]/g, "'"],
  // curly double quotes -> straight double quote.
  [/[“”]/g, '"'],
  // ellipsis -> three periods.
  [/…/g, "..."],
  // non-breaking space / narrow no-break space -> regular space.
  [/[  ]/g, " "],
  // middle dot (used as a separator) -> plain hyphen.
  [/·/g, "-"],
  // rightwards arrow (used in scope/ceiling lines) -> ASCII arrow.
  [/→/g, "->"],
];

/** Pure: replace smart-character offenders with their GSM-7-safe
 *  equivalents. Everything else is left untouched — this is normalization,
 *  never a wording change. */
export function normalizeForGsm7(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REPLACEMENTS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

// GSM 03.38 default alphabet (basic set) — 1 unit per character.
const GSM7_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅå" +
  "Δ_ΦΓΛΩΠΨΣΘΞ" +
  "ÆæßÉ" +
  " !\"#¤%&'()*+,-./0123456789:;<=>?" +
  "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§" +
  "¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM7_BASIC_SET = new Set(GSM7_BASIC);

// GSM 03.38 extension table — requires an ESC prefix, 2 units per character.
const GSM7_EXTENDED = "^{}\\[~]|€";
const GSM7_EXTENDED_SET = new Set(GSM7_EXTENDED);

export interface SmsSegmentEstimate {
  encoding: "gsm7" | "ucs2";
  /** Character units billed (GSM-7 basic = 1, GSM-7 extension = 2, UCS-2 = 1
   *  per UTF-16 code unit). */
  units: number;
  segments: number;
}

/** Pure: standard carrier segment math. GSM-7 when every character is in the
 *  basic or extension set (160 units single segment, 153 per segment when
 *  concatenated); UCS-2 the moment ANY character falls outside that alphabet
 *  (70 single segment, 67 per segment concatenated). */
export function estimateSmsSegments(text: string): SmsSegmentEstimate {
  if (text.length === 0) return { encoding: "gsm7", units: 0, segments: 0 };

  let units = 0;
  let isGsm7 = true;
  for (const ch of text) {
    if (GSM7_BASIC_SET.has(ch)) {
      units += 1;
    } else if (GSM7_EXTENDED_SET.has(ch)) {
      units += 2;
    } else {
      isGsm7 = false;
      break;
    }
  }

  if (!isGsm7) {
    const ucs2Units = text.length;
    return {
      encoding: "ucs2",
      units: ucs2Units,
      segments: ucs2Units <= 70 ? 1 : Math.ceil(ucs2Units / 67),
    };
  }

  return {
    encoding: "gsm7",
    units,
    segments: units <= 160 ? 1 : Math.ceil(units / 153),
  };
}

/** Pure: the characters in `text` that GSM-7 cannot represent, deduped and in
 *  first-seen order. Empty array means the body bills as GSM-7.
 *
 *  This exists because normalizeForGsm7 is a DENYLIST, and a denylist silently
 *  fails on the offender nobody thought of. It shipped without the middle dot
 *  and the rightwards arrow, both of which were live in outbound bodies and
 *  both of which forced UCS-2 straight past the choke point (2026-09-09).
 *  Assert on this in template tests so the next miss fails CI instead of
 *  quietly doubling a bill nobody reconciles. */
export function findNonGsm7Chars(text: string): string[] {
  const seen = new Set<string>();
  for (const ch of text) {
    if (!GSM7_BASIC_SET.has(ch) && !GSM7_EXTENDED_SET.has(ch)) seen.add(ch);
  }
  return [...seen];
}
