// Phone normalization — convert any human-format US phone string into
// canonical E.164 ("+15551234567") so downstream cross-listing matches
// don't miss duplicates stored in different formats.
//
// Found 5/14: Listings_V1 stores "(713) 231-1129" and "713-231-1129" as
// separate values for the same agent. Agent_Prior_Outreach_Count
// undercounts as a result, and Layer 1 of the D3 depth-gate inherits
// that miss rate unless every phone-keyed comparison normalizes first.
//
// US/Canada only for now. Handles:
//   - "(713) 231-1129", "713-231-1129", "713.231.1129", "7132311129"
//   - "1-713-231-1129", "+1 713 231 1129", "+17132311129"
//   - Extensions ("x123") are stripped — the destination is the line,
//     not the extension. Matches Quo/OpenPhone routing reality.
// Returns null for:
//   - null / undefined / empty string input
//   - <10 digits after stripping (invalid)
//   - 11 digits not starting with 1 (not US/Canada — flag for human)
//   - >11 digits (invalid)
//
// Pure function. No I/O. Stable output across runs.

export function normalizePhone(input: string | null | undefined): string | null {
  if (input == null) return null;
  if (typeof input !== "string") return null;

  // Strip extension. Common forms: "x123", "ext 123", "ext. 123".
  // Everything from the first 'x'/'ext' onwards is dropped.
  const cleanedExt = input.replace(/\s*(?:x|ext\.?)\s*\d+\s*$/i, "");

  // Keep only digits.
  const digits = cleanedExt.replace(/\D/g, "");

  // A NANP area code can never begin with 0 or 1. A stored "1313702367"
  // (26295 Kathy St, a dropped digit off a 313 number) is ten digits, so it
  // used to normalize to +11313702367 — area code "131", structurally
  // impossible. Being non-null, it skipped bad_phone_quarantine and was handed
  // to Quo on every run, which rejected it forever: an invisible poison record
  // that stalled the whole send queue (2026-09-09). Reject it here so it
  // routes to the existing quarantine path instead.
  if (digits.length === 10) {
    if (digits[0] === "0" || digits[0] === "1") return null;
    return `+1${digits}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    if (digits[1] === "0" || digits[1] === "1") return null;
    return `+${digits}`;
  }
  return null;
}

// Convenience: returns true if both inputs normalize to the same E.164.
// Both nulls compare as false (no usable signal).
export function phonesEqual(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const na = normalizePhone(a);
  const nb = normalizePhone(b);
  if (!na || !nb) return false;
  return na === nb;
}
