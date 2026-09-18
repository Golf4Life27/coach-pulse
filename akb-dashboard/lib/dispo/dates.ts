// DISPO DATES — timezone-safe date-only formatting (2026-09-18).
//
// WHY: `new Date("2026-09-14")` then `.toLocaleDateString()` on the local
// clock shifts a date-only string backward a day in any US timezone (the
// string parses as UTC midnight, then the local formatter renders it in a
// zone behind UTC) — "Contract executed: Sep 14, 2026" was showing as
// "Sep 13, 2026" on the package page. Rendering in UTC keeps the calendar
// date the operator typed in Airtable the one that shows on screen.
//
// Pure. No I/O.

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** "Sep 14, 2026" for a date-only or full ISO datetime string, rendered in
 *  UTC so the calendar date never shifts with the viewer's timezone.
 *  "not recorded" for null; the raw string back for anything unparseable. */
export function formatDateOnly(raw: string | null): string {
  if (!raw) return "not recorded";
  const s = raw.trim();
  const d = DATE_ONLY_RE.test(s) ? new Date(`${s}T12:00:00Z`) : new Date(s);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}
