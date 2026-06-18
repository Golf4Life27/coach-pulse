// M8 / Gate 3 — STOP / opt-out detection + number-level suppression.
// @agent: outreach / crier
//
// A TCPA opt-out is NOT a deal rejection. "not interested" closes ONE deal;
// "STOP" / "unsubscribe" / "do not text" / "remove my number" revokes consent
// to text the NUMBER — every listing that shares that agent phone, not just the
// record that happened to receive the reply. This module is the compliance gate
// the H2 send path depends on (the diagnosis "Gate 3").
//
// Two pieces:
//   - detectOptOut(body): PURE. The precise opt-out classifier (distinct from
//     reply-triage's generic "rejection"). Leans toward DETECTION — a missed
//     opt-out is a TCPA violation (serious); a false positive only parks a lead
//     the operator can un-flag (recoverable). A small exclusion list keeps the
//     benign "stop by the house" uses from tripping it.
//   - applyOptOut(records, …): I/O via injected deps. Flips Do_Not_Text=true on
//     EVERY supplied record (the caller passes the whole phone group),
//     idempotent + best-effort per record, fully audited.

export interface OptOutDetection {
  optOut: boolean;
  /** The pattern source that matched (for provenance), or null. */
  matched: string | null;
}

// Canonical CTIA opt-out keywords when sent as the whole message.
const EXACT_KEYWORDS = new Set([
  "STOP", "STOPALL", "STOP ALL", "UNSUBSCRIBE", "END", "QUIT", "CANCEL", "OPTOUT", "OPT OUT",
]);

// Phrase patterns — explicit opt-out intent anywhere in the body.
const OPT_OUT_PATTERNS: RegExp[] = [
  /\bunsubscribe\b/i,
  /\bstop\s+(?:texting|contacting|messaging|calling|text|contact|message|msg|sms)\b/i,
  /\b(?:do\s*not|don'?t|dont)\s+(?:text|contact|call|message|msg)\b/i,
  /\bremove\b[^.!?]*\b(?:number|me|my\s+number)\b/i,
  /\btake\s+me\s+off\b/i,
  /\bopt(?:ed)?\s*-?\s*out\b/i,
  /\bno\s+more\s+(?:texts?|messages?|msgs?|calls?)\b/i,
  /\blose\s+my\s+number\b/i,
];

// Benign "stop" uses that must NOT count as an opt-out (a bare \bstop\b would
// otherwise false-positive on these). Only consulted for the bare-stop path.
const STOP_EXCLUSIONS: RegExp[] = [
  /\bstop\s+by\b/i,
  /\bstop\s+in\b/i,
  /\bbus\s+stop\b/i,
  /\bnon-?stop\b/i,
  /\bone-?stop\b/i,
  /\bstop\s+sign\b/i,
  /\b(?:can'?t|cannot|won'?t|wont|doesn'?t|never|hard\s+to)\s+stop\b/i,
];

/** Pure: does this inbound body revoke consent to text? */
export function detectOptOut(body: string | null | undefined): OptOutDetection {
  const raw = (body ?? "").trim();
  if (!raw) return { optOut: false, matched: null };

  // 1. Exact carrier keyword sent alone (strip surrounding punctuation/space).
  const normalized = raw.replace(/[.!?,;:'"()\-]/g, " ").replace(/\s+/g, " ").trim().toUpperCase();
  if (EXACT_KEYWORDS.has(normalized)) return { optOut: true, matched: `exact:${normalized}` };

  // 2. Explicit opt-out phrases anywhere.
  for (const p of OPT_OUT_PATTERNS) {
    if (p.test(raw)) return { optOut: true, matched: p.source };
  }

  // 3. A bare "stop" token anywhere — opt-out UNLESS a benign exclusion matches.
  //    Catches "not interested, stop" / "stop." while sparing "stop by the house".
  if (/\bstop\b/i.test(raw) && !STOP_EXCLUSIONS.some((x) => x.test(raw))) {
    return { optOut: true, matched: "bare_stop" };
  }

  return { optOut: false, matched: null };
}

// ── Number-level suppression (I/O via injected deps) ───────────────────────

export interface OptOutRecord {
  id: string;
  doNotText?: boolean | null;
  notes?: string | null;
  address?: string | null;
}

export interface ApplyOptOutDeps {
  updateListing: (recordId: string, fields: Record<string, unknown>) => Promise<unknown>;
  audit?: (entry: Record<string, unknown>) => Promise<unknown>;
  now?: () => Date;
}

export interface OptOutApplyResult {
  /** Records newly flipped to Do_Not_Text=true. */
  flipped: string[];
  /** Records already Do_Not_Text=true (idempotent skip). */
  alreadySuppressed: string[];
  /** Records whose write failed — NOT suppressed; the cron retries next tick. */
  failed: Array<{ id: string; error: string }>;
}

/**
 * Flip Do_Not_Text=true on EVERY supplied record (the caller passes the whole
 * phone group, so suppression is number-level). Idempotent (already-DNT records
 * are skipped) and best-effort per record — one failed write never blocks the
 * others, and failures are surfaced (never silently swallowed) so the next
 * scan tick re-applies. The opt-out keyword set is appended to notes for
 * provenance.
 */
export async function applyOptOut(
  records: OptOutRecord[],
  matchedPattern: string,
  deps: ApplyOptOutDeps,
): Promise<OptOutApplyResult> {
  const now = (deps.now ?? (() => new Date()))();
  const iso = now.toISOString();
  const result: OptOutApplyResult = { flipped: [], alreadySuppressed: [], failed: [] };

  for (const r of records) {
    if (r.doNotText === true) {
      result.alreadySuppressed.push(r.id);
      continue;
    }
    const note = `[${iso}] OPT-OUT honored (matched /${matchedPattern}/): Do_Not_Text=true (number-level, M8 Gate 3).`;
    const fields: Record<string, unknown> = {
      Do_Not_Text: true,
      Verification_Notes: r.notes ? `${r.notes}\n${note}` : note,
    };
    try {
      await deps.updateListing(r.id, fields);
      result.flipped.push(r.id);
    } catch (e) {
      result.failed.push({ id: r.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (deps.audit) {
    await deps.audit({
      agent: "crier",
      event: "opt_out_applied",
      status: result.failed.length > 0 ? "uncertain" : "confirmed_success",
      outputSummary: {
        matched: matchedPattern,
        flipped: result.flipped.length,
        already_suppressed: result.alreadySuppressed.length,
        failed: result.failed.length,
        record_ids: result.flipped,
      },
      decision: "opt_out_do_not_text",
    });
  }

  return result;
}
