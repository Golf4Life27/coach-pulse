// Pure-function helper for the bulk-dead-stale-texted operation.
//
// Per Alex 5/14 policy: records texted >7 days ago with no reply are
// noise, not cadence. Bulk-mark them Dead with a notes annotation that
// preserves audit trail without burying existing context.
//
// Annotation copy is fixed by Alex (matches the 50 hand-written records
// he ran first to validate the pattern):
//   "{M}/{D} — BULK DEAD per stale records policy. {N} days since
//   first touch, no reply. D3 cadence engine predates this record;
//   too stale to resurrect."
//
// Idempotency: any Notes string that already contains the sentinel
// phrase "BULK DEAD per stale records policy" is treated as already-
// annotated. Re-running the endpoint over the same cohort produces
// zero writes.
//
// Pure function. No I/O. Tested under lib/bulk-dead-annotation.test.ts.

// Sentinel substring used to detect prior annotation. Stable across
// any month/day prefix so the idempotency check works for records
// annotated on different days.
export const BULK_DEAD_SENTINEL = "BULK DEAD per stale records policy";

export interface AnnotationInputs {
  recordId: string;
  currentNotes: string | null | undefined;
  lastOutreachDate: string | null | undefined; // ISO "YYYY-MM-DD"
  now: Date;
}

export type AnnotationResult =
  | {
      decision: "annotate";
      recordId: string;
      newNotes: string;
      daysSince: number;
    }
  | {
      decision: "skip_already_annotated";
      recordId: string;
    }
  | {
      decision: "skip_missing_outreach_date";
      recordId: string;
    };

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function isoToday(now: Date): string {
  return `${pad2(now.getMonth() + 1)}/${pad2(now.getDate())}`;
}

function daysBetween(now: Date, lastOutreachDate: string): number | null {
  // Last_Outreach_Date is an Airtable date field (no time component).
  // Treat it as UTC midnight of the given day to keep math deterministic
  // across server timezones.
  const m = lastOutreachDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (isNaN(d.getTime())) return null;
  // Floor of elapsed days. now is the operation timestamp; if it crosses
  // a day boundary mid-batch, every record in the same batch still gets
  // the same day count from its own lastOutreachDate.
  return Math.floor((now.getTime() - d.getTime()) / 86_400_000);
}

/**
 * Compute the annotated Notes for one record. Caller decides what to
 * do with the result (write to Airtable in apply mode, surface in
 * dry-run report).
 */
export function annotateBulkDead(opts: AnnotationInputs): AnnotationResult {
  // Idempotency — if any prior bulk-dead annotation is present, skip.
  // Substring match is sufficient; the sentinel is unique enough that
  // a false-positive on legitimate text is implausible.
  const existing = opts.currentNotes ?? "";
  if (existing.includes(BULK_DEAD_SENTINEL)) {
    return { decision: "skip_already_annotated", recordId: opts.recordId };
  }

  if (!opts.lastOutreachDate) {
    // Without a date we can't compute the days-since number that goes
    // in the annotation. Skip and surface — caller can investigate.
    return { decision: "skip_missing_outreach_date", recordId: opts.recordId };
  }

  const days = daysBetween(opts.now, opts.lastOutreachDate);
  if (days == null) {
    return { decision: "skip_missing_outreach_date", recordId: opts.recordId };
  }

  const dateStamp = isoToday(opts.now); // e.g. "05/14"
  const annotation =
    `${dateStamp} — ${BULK_DEAD_SENTINEL}. ${days} days since first touch, no reply. ` +
    `D3 cadence engine predates this record; too stale to resurrect.`;

  // Notes-append pattern: separate from existing with a blank line if
  // existing isn't empty, else just write the annotation.
  const trimmed = existing.replace(/\s+$/u, "");
  const newNotes = trimmed.length > 0 ? `${trimmed}\n\n${annotation}` : annotation;

  return {
    decision: "annotate",
    recordId: opts.recordId,
    newNotes,
    daysSince: days,
  };
}
