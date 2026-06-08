// Phone-number normalization helpers shared across Quo/OpenPhone callers.
//
// The Quo (OpenPhone) /v1/messages endpoint expects `participants` in
// E.164 format. Listings carry phones in mixed shapes — "(901) 555-1234",
// "9015551234", "+19015551234" — so every Quo caller must normalize OR
// it gets back an empty thread.
//
// Pure; no I/O. Extracted from app/api/cron/scan-comms/route.ts on
// 2026-06-08 (conversation-check was calling Quo without this and got
// 0 messages for every record).

/** Normalize a phone number to E.164. Strips non-digits, prepends US
 *  country code on bare 10-digit numbers, preserves an existing leading 1.
 *  Returns the original string with a "+" prefix if length doesn't match
 *  US shapes — defensive but never throws. */
export function toE164(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

/** Pure: true when the input has enough digits to plausibly be a US phone.
 *  Used as a guard before calling Quo — a malformed phone shouldn't burn
 *  an API request. */
export function isPlausibleUsPhone(phone: string | null | undefined): boolean {
  if (!phone) return false;
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.length === 10) return true;
  if (digits.length === 11 && digits.startsWith("1")) return true;
  return false;
}
