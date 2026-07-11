// Decision escalation + morning digest (silver-platter cockpit, operator
// 2026-07-11): "when a decision ages past threshold with real revenue
// attached and I haven't logged in recently, text my personal number one
// plain sentence with a deep link; single 8:30am digest."
//
// PURE decision + composition logic. The cron routes do the I/O. Honest by
// construction: escalation requires a SOURCED dollar amount (the conveyor
// never fabricates one), a real waiting clock, and a server-side last-seen
// older than the away threshold. One plain sentence, one deep link.

import type { ConveyorItem } from "@/lib/conveyor/model";
import { urgencyRank } from "@/lib/conveyor/model";

/** KV key for the server-side operator last-seen ping (written by
 *  /api/ui/last-seen, read by the escalation cron). */
export const OPERATOR_LAST_SEEN_KEY = "operator:last_seen";

export interface EscalationConfig {
  /** Minimum SOURCED dollars in play before a decision may text the phone. */
  minUsd: number;
  /** Decision age (hours since posted) before escalation. */
  ageHours: number;
  /** Operator absence (hours since last-seen ping) before escalation. */
  awayHours: number;
  /** Chicago-local send window (decency floor on the operator's own phone). */
  windowStartHour: number;
  windowEndHour: number;
  /** Max escalation texts per run. */
  maxPerRun: number;
}

export function readEscalationConfig(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): EscalationConfig {
  const num = (raw: string | undefined, dflt: number, min = 0) => {
    const n = Number(raw);
    return Number.isFinite(n) && n >= min ? n : dflt;
  };
  return {
    minUsd: num(env.ESCALATION_MIN_USD, 1_000),
    ageHours: num(env.ESCALATION_AGE_HOURS, 6),
    awayHours: num(env.ESCALATION_AWAY_HOURS, 3),
    windowStartHour: 8,
    windowEndHour: 21,
    maxPerRun: num(env.ESCALATION_MAX_PER_RUN, 2, 1),
  };
}

export function chicagoHour(now: Date): number {
  return new Date(now.toLocaleString("en-US", { timeZone: "America/Chicago" })).getHours();
}

export function insideChicagoWindow(now: Date, cfg: EscalationConfig): boolean {
  const h = chicagoHour(now);
  return h >= cfg.windowStartHour && h < cfg.windowEndHour;
}

const HOUR_MS = 3_600_000;

export interface EscalationVerdict {
  escalate: boolean;
  reason: string;
  ageHours: number | null;
}

/** Pure: does THIS decision earn a text to the operator's phone right now? */
export function shouldEscalate(
  item: ConveyorItem,
  input: { lastSeenIso: string | null; nowIso: string; cfg: EscalationConfig },
): EscalationVerdict {
  const now = Date.parse(input.nowIso);
  const posted = item.postedAt ? Date.parse(item.postedAt) : NaN;
  const ageHours = Number.isFinite(posted) ? (now - posted) / HOUR_MS : null;

  if (item.dollars == null || item.dollars < input.cfg.minUsd) {
    return { escalate: false, reason: "no_real_dollars", ageHours };
  }

  const overdue = urgencyRank(item, input.nowIso) === 4 && !item.deadlineImplied;
  const agedPast = ageHours != null && ageHours >= input.cfg.ageHours;
  if (!overdue && !agedPast) {
    return { escalate: false, reason: "not_aged", ageHours };
  }

  // Operator presence: a recent server-side last-seen means he's IN the
  // cockpit — the conveyor is the surface, no text needed.
  if (input.lastSeenIso) {
    const seen = Date.parse(input.lastSeenIso);
    if (Number.isFinite(seen) && now - seen < input.cfg.awayHours * HOUR_MS) {
      return { escalate: false, reason: "operator_recently_seen", ageHours };
    }
  }

  return { escalate: true, reason: overdue ? "overdue_with_dollars" : "aged_with_dollars", ageHours };
}

function money(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

/** One plain sentence + a deep link. */
export function composeEscalationSms(item: ConveyorItem, baseUrl: string, ageHours: number | null): string {
  const what =
    item.type === "2A" ? "reply approval" : item.type === "2B" ? "money/signature decision" : "ruling";
  const waiting = ageHours != null ? ` waiting ${Math.round(ageHours)}h` : "";
  const link = item.href ? `${baseUrl}${item.href}` : baseUrl;
  return `AKB: ${money(item.dollars ?? 0)} ${what} on ${item.title}${waiting} — ${link}`;
}

export interface DigestBelt {
  intakeFreshness: string | null;
  sendFreshness: string | null;
  sentYesterday: number | null;
  repliesYesterday: number | null;
}

/** The single 8:30am digest — decisions waiting, $ at stake, belt status. */
export function composeDigestSms(items: ConveyorItem[], belt: DigestBelt | null, baseUrl: string): string {
  const byType = { "2A": 0, "2B": 0, "2C": 0 } as Record<ConveyorItem["type"], number>;
  let dollars = 0;
  for (const i of items) {
    byType[i.type]++;
    if (i.dollars != null) dollars += i.dollars;
  }
  const parts = [
    `AKB 8:30 — ${items.length} decision${items.length === 1 ? "" : "s"} waiting` +
      (items.length > 0 ? ` (${byType["2A"]} sends, ${byType["2B"]} money, ${byType["2C"]} rulings)` : ""),
    dollars > 0 ? `${money(dollars)} at stake` : null,
    belt
      ? `belt: intake ${belt.intakeFreshness ?? "?"} · send ${belt.sendFreshness ?? "?"}` +
        (belt.sentYesterday != null ? ` · yday ${belt.sentYesterday} sent/${belt.repliesYesterday ?? 0} replies` : "")
      : null,
    baseUrl,
  ].filter(Boolean);
  return parts.join(". ");
}
