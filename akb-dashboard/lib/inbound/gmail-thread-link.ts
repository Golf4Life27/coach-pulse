// Gmail deal-thread linking + sweep cohort math (Sunbeam capture-gap fix,
// spine rec17krmeSuttdyNy). @agent: outreach
//
// THE MISS (2026-07-12T13:53Z, thread 19d9bb3906ab44db): a material contract
// email on the pipeline's ONE live deal was skipped by three green sweeps.
// Verified root causes, in order of blast radius:
//
//   1. COHORT STARVATION — the sweep sliced the first `limit` rows of an
//      UNSORTED population every run. Records past the prefix (including the
//      live contract) were never fetched, and the audit carried no
//      truncation telemetry, so green runs looked like full coverage.
//   2. SENDER-KEYED FETCHING — threads are discovered via the agent's email
//      only. A message from the transaction coordinator (operator CC-only,
//      subject flipped Re:→Fwd:) belongs to the deal but has no durable key
//      tying it to the listing.
//
// This module is the PURE half of the fix: deterministic cohort selection
// (live-money never truncated, remainder rotates so every record is visited
// on a bounded cadence), thread-link field serialization, subject
// normalization, and any-recipient address matching. No I/O.

export interface GmailishMessage {
  from?: string | null;
  to?: string | null;
  cc?: string | null;
  bcc?: string | null;
}

/** Strip leading Re:/Fwd:/Fw: prefixes — case-insensitive, repeated, with or
 *  without surrounding whitespace — before ANY subject-based correlation.
 *  "Fwd: RE:  Fw:Cash Offer" → "Cash Offer". */
export function normalizeSubject(subject: string | null | undefined): string {
  let s = (subject ?? "").trim();
  const prefix = /^(re|fwd?|fw)\s*:\s*/i;
  while (prefix.test(s)) s = s.replace(prefix, "").trim();
  return s;
}

/** Lowercased bare addresses harvested from a header value ("A <a@x.com>,
 *  b@y.com" → ["a@x.com","b@y.com"]). Tolerates display names and commas. */
export function extractAddresses(header: string | null | undefined): string[] {
  const s = (header ?? "").toLowerCase();
  const out = s.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g);
  return out ? [...new Set(out)] : [];
}

/** True when `address` appears in ANY of From/To/Cc/Bcc — never To:-only.
 *  The operator being CC'd on a TC-addressed email is still our mail. */
export function messageTouchesAddress(msg: GmailishMessage, address: string): boolean {
  const want = (address ?? "").trim().toLowerCase();
  if (!want) return false;
  return [msg.from, msg.to, msg.cc, msg.bcc].some((h) => extractAddresses(h).includes(want));
}

// ── Thread-link field (Listings_V1.Gmail_Thread_Ids) ────────────────────────
// Stored as a space-separated list of Gmail thread ids. Space-separated
// survives Airtable long-text editing better than JSON and diffs cleanly.

export function parseThreadIds(field: string | null | undefined): string[] {
  return [...new Set((field ?? "").split(/[\s,;]+/).map((s) => s.trim()).filter((s) => /^[A-Za-z0-9_-]{8,}$/.test(s)))];
}

/** Merge newly-seen thread ids into the stored field value. Returns null when
 *  nothing new (caller skips the write). Order-stable: existing first. */
export function mergeThreadIds(field: string | null | undefined, seen: Iterable<string>): string | null {
  const existing = parseThreadIds(field);
  const have = new Set(existing);
  const merged = [...existing];
  for (const raw of seen) {
    const id = (raw ?? "").trim();
    if (id && /^[A-Za-z0-9_-]{8,}$/.test(id) && !have.has(id)) {
      have.add(id);
      merged.push(id);
    }
  }
  return merged.length > existing.length ? merged.join(" ") : null;
}

// ── Sweep cohort selection ───────────────────────────────────────────────────

export interface CohortCandidate {
  id: string;
  /** Outreach_Status — live-money statuses are never truncated out. */
  status: string | null;
  /** Has either an agent email or a linked thread — syncable at all. */
  syncable: boolean;
  /** Most recent activity (inbound or outbound), ISO — recency priority. */
  lastActivityAt: string | null;
}

export const LIVE_MONEY_STATUSES: ReadonlySet<string> = new Set([
  "Negotiating",
  "Response Received",
  "Counter Received",
  "Offer Accepted",
]);

export interface CohortSelection<T extends CohortCandidate> {
  cohort: T[];
  populationSyncable: number;
  liveMoneyCount: number;
  /** How many syncable records did NOT make this run's cohort. >0 means the
   *  audit MUST say so — silent truncation is how Sunbeam was missed. */
  truncated: number;
  /** Which rotation window the remainder drew from this run. */
  rotationWindow: number;
}

/** Deterministic cohort: every live-money record ALWAYS syncs (a live
 *  negotiation missing an email is a deal-losing event); the remainder is
 *  ordered newest-activity-first and rotated by `rotationKey` (e.g. the run
 *  hour) so with N remainder slots per run every record is visited at least
 *  every ceil(rest/N) runs — bounded staleness instead of permanent
 *  starvation. */
export function selectSweepCohort<T extends CohortCandidate>(
  population: T[],
  limit: number,
  rotationKey: number,
): CohortSelection<T> {
  const syncable = population.filter((c) => c.syncable);
  const live = syncable.filter((c) => LIVE_MONEY_STATUSES.has(c.status ?? ""));
  const rest = syncable
    .filter((c) => !LIVE_MONEY_STATUSES.has(c.status ?? ""))
    .sort((a, b) => {
      const ta = a.lastActivityAt ? new Date(a.lastActivityAt).getTime() : 0;
      const tb = b.lastActivityAt ? new Date(b.lastActivityAt).getTime() : 0;
      return tb - ta || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });

  const cohort: T[] = [...live];
  const slots = Math.max(0, limit - cohort.length);
  let rotationWindow = 0;
  if (slots > 0 && rest.length > 0) {
    const windows = Math.ceil(rest.length / slots);
    rotationWindow = ((rotationKey % windows) + windows) % windows;
    cohort.push(...rest.slice(rotationWindow * slots, rotationWindow * slots + slots));
  }
  return {
    cohort,
    populationSyncable: syncable.length,
    liveMoneyCount: live.length,
    truncated: Math.max(0, syncable.length - cohort.length),
    rotationWindow,
  };
}
