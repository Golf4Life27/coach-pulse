// Last_Seen stamping — record that the SOURCE FEED still lists an address.
// @agent: scout
//
// WHY (2026-08-04, the 8203 Brace incident): the system texted an agent a
// $35,250 offer on a house that was not for sale. Liveness was being decided
// by scraping the listing page and looking for one of a handful of phrases —
// a blocklist that reads ACTIVE whenever it finds nothing it recognises.
//
// The far better signal was already being bought and thrown away. Every
// intake run calls RentCast `listings/sale` per ZIP, which returns that ZIP's
// CURRENTLY ACTIVE listings. If we hold a record for an address and the feed
// still returns it, that is positive confirmation the listing is live. If a
// crawl of its ZIP comes back without it, that is the strongest off-market
// evidence available. The intake loop saw this on every run, counted it as
// `duplicates++`, and discarded it.
//
// So this costs ZERO extra vendor calls — it writes down an answer already
// paid for. Coverage builds as the ZIP rotation comes around.
//
// DELIBERATELY matched on EVERY candidate the feed returns, not just the ones
// that survive the distress filter. "Still for sale" and "still interesting"
// are different questions: a listing that drops out of the price band or
// loses its distress signal is still LISTED, and stamping only accepted
// candidates would silently mark those as gone.

/** Records whose Last_Seen is fresher than this are not re-stamped. Intake
 *  runs every 10 minutes; without a floor, every run would rewrite the same
 *  few hundred rows forever. 12h keeps steady-state writes near zero while
 *  still refreshing each record roughly daily. */
export const LAST_SEEN_REFRESH_HOURS = 12;

/** Hard bound on rows stamped per run, so the first pass over a large backlog
 *  cannot turn one intake run into hundreds of Airtable PATCHes. The rotation
 *  picks up the remainder on subsequent runs.
 *  ponytail: fixed cap; make it budget-aware only if a run ever hits it often. */
export const LAST_SEEN_MAX_WRITES_PER_RUN = 150;

export interface LastSeenCandidateRow {
  /** Airtable record id of an existing listing. */
  id: string;
  /** Current Last_Seen value, ISO string or null when never stamped. */
  lastSeen?: string | null;
}

/** Pure: which existing records matched by the feed this run actually need a
 *  Last_Seen write. Skips rows stamped within LAST_SEEN_REFRESH_HOURS and
 *  caps the batch. Returns record ids in input order. */
export function selectLastSeenWrites(
  matched: LastSeenCandidateRow[],
  now: Date,
  refreshHours: number = LAST_SEEN_REFRESH_HOURS,
  maxWrites: number = LAST_SEEN_MAX_WRITES_PER_RUN,
): string[] {
  const cutoff = now.getTime() - refreshHours * 3_600_000;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of matched) {
    if (out.length >= maxWrites) break;
    if (!r.id || seen.has(r.id)) continue;
    seen.add(r.id);
    if (r.lastSeen) {
      const t = Date.parse(r.lastSeen);
      // An unparseable stamp is treated as stale — better one redundant write
      // than a row that can never refresh.
      if (Number.isFinite(t) && t >= cutoff) continue;
    }
    out.push(r.id);
  }
  return out;
}
