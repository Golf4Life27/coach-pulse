// Mission Control heartbeat — pure daily-throughput math for the dashboard's
// live belt. @agent: maverick
//
// Operator spec (2026-07-04): "a health display… so I know how well things are
// working daily… seeing things in action helps." The belt renders four
// stations (CRAWLED → ACCEPTED → SENT → REPLIES) with today/yesterday hero
// counts, cron heartbeat freshness, and a live event tape. This module is the
// pure half: day bucketing, freshness tiers, tape assembly. The route supplies
// raw rows from Airtable; the component supplies motion.

export interface StampedRow {
  ts: string; // ISO timestamp the row is bucketed by
}

export interface DayBuckets {
  today: number;
  yesterday: number;
}

/** Bucket rows into today/yesterday by the operator-local day boundary.
 *  todayStart/yesterdayStart are precomputed ISO instants (route computes
 *  them in America/Chicago); rows before yesterdayStart are dropped. */
export function bucketByDay(
  rows: StampedRow[],
  todayStartIso: string,
  yesterdayStartIso: string,
): DayBuckets {
  const todayStart = new Date(todayStartIso).getTime();
  const yStart = new Date(yesterdayStartIso).getTime();
  let today = 0;
  let yesterday = 0;
  for (const r of rows) {
    const t = new Date(r.ts).getTime();
    if (!Number.isFinite(t)) continue;
    if (t >= todayStart) today++;
    else if (t >= yStart) yesterday++;
  }
  return { today, yesterday };
}

/** Heartbeat freshness for a daily cron: green when it ran within its
 *  expected window (+2h slack), amber when one cycle late, red beyond. */
export type Freshness = "ok" | "late" | "stale" | "never";

export function cronFreshness(lastRunIso: string | null, nowIso: string): Freshness {
  if (!lastRunIso) return "never";
  const ageH = (new Date(nowIso).getTime() - new Date(lastRunIso).getTime()) / 3600_000;
  if (!Number.isFinite(ageH)) return "never";
  if (ageH <= 26) return "ok";
  if (ageH <= 50) return "late";
  return "stale";
}

/** Next H2 send slot (15:00 / 17:30 / 19:45 UTC daily) after `nowIso`. */
export const SEND_SLOTS_UTC: ReadonlyArray<{ h: number; m: number }> = [
  { h: 15, m: 0 },
  { h: 17, m: 30 },
  { h: 19, m: 45 },
];

export function nextSendSlotIso(nowIso: string): string {
  const now = new Date(nowIso);
  for (const s of SEND_SLOTS_UTC) {
    const cand = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), s.h, s.m, 0));
    if (cand.getTime() > now.getTime()) return cand.toISOString();
  }
  const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, SEND_SLOTS_UTC[0].h, SEND_SLOTS_UTC[0].m, 0));
  return t.toISOString();
}

export interface TapeEvent {
  ts: string;
  kind: "sent" | "reply" | "quarantined";
  /** One human line, e.g. "→ $80,665 offer · 1654 2nd St NW". */
  line: string;
}

export interface TapeInputs {
  outbound: Array<{ ts: string; address: string | null; offer: number | null; status: string | null }>;
  inbound: Array<{ ts: string; address: string | null }>;
}

/** Assemble the merged, newest-first event tape (capped). Quarantined =
 *  an outbound whose record now sits at Outreach_Status "Dead" (the #64
 *  auto-quarantine writes Dead in the same breath as the failed send). */
export function buildTape(inputs: TapeInputs, cap = 10): TapeEvent[] {
  const street = (a: string | null) => (a ?? "").split(",")[0].trim() || "—";
  const events: TapeEvent[] = [];
  for (const o of inputs.outbound) {
    const quarantined = (o.status ?? "").toLowerCase() === "dead";
    events.push({
      ts: o.ts,
      kind: quarantined ? "quarantined" : "sent",
      line: quarantined
        ? `dead number auto-quarantined · ${street(o.address)}`
        : `offer ${o.offer != null ? `$${Math.round(o.offer).toLocaleString("en-US")}` : "sent"} · ${street(o.address)}`,
    });
  }
  for (const i of inputs.inbound) {
    events.push({ ts: i.ts, kind: "reply", line: `reply received · ${street(i.address)}` });
  }
  return events
    .filter((e) => Number.isFinite(new Date(e.ts).getTime()))
    .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
    .slice(0, cap);
}
