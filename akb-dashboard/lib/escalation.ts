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
import { trimAtWord } from "@/lib/maverick/sms-escalation";
import { normalizeForGsm7 } from "@/lib/sms/gsm7";

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
  return `AKB: ${money(item.dollars ?? 0)} ${what} on ${item.title}${waiting} - ${link}`;
}

/** Same per-message budget as the other hand-composed operator SMS (see
 *  lib/maverick/operator-page.ts SMS_MAX_LEN / lib/maverick/sms-escalation.ts
 *  SMS_MAX_LEN — ~2 GSM-7 segments of headroom). */
export const ESCALATION_DIGEST_SMS_MAX_LEN = 300;

export interface DigestDueItem {
  title: string;
  dollars: number | null;
}

/** ONE digest SMS for every escalatable decision claimed this run (P0-17
 *  follow-up, 2026-09-24): a separate text per overdue decision was noise —
 *  with ~32 overdue decisions live, the per-item send would have meant ~26
 *  texts in a single day. Names the top 3 in the CALLER's existing due
 *  order (already ranked: overdue-first, then urgency, then dollars — see
 *  lib/conveyor/model.rankConveyor), then folds the rest into a count.
 *  Budgets the link WHOLE first (same discipline as composeOperatorPageSms /
 *  formatStage4Message — a trimmed link is a broken one), then trims the
 *  itemized body to what's left. Pure. */
export function composeEscalationDigestSms(due: DigestDueItem[], baseUrl: string): string {
  const link = normalizeForGsm7(baseUrl.trim());
  const top = due.slice(0, 3);
  const rest = due.length - top.length;
  const tail = rest > 0 ? `+${rest} more overdue in your queue.` : "";

  const header = normalizeForGsm7(
    `AKB: ${due.length} overdue decision${due.length === 1 ? "" : "s"} waiting.`,
  );
  const itemLines = top.map((d, i) => {
    const title = normalizeForGsm7(d.title);
    const withMoney = d.dollars != null ? `${title} - ${money(d.dollars)}` : title;
    return `${i + 1}) ${withMoney}`;
  });

  const linkOverhead = link.length + 1;
  const fixedOverhead = header.length + 1 + (tail ? tail.length + 1 : 0);
  const room = Math.max(0, ESCALATION_DIGEST_SMS_MAX_LEN - linkOverhead - fixedOverhead);
  let itemsBody = itemLines.join("\n");
  if (itemsBody.length > room) itemsBody = trimAtWord(itemsBody, room);

  return [header, itemsBody, tail, link].filter(Boolean).join("\n");
}

export interface DigestBelt {
  intakeFreshness: string | null;
  sendFreshness: string | null;
  sentYesterday: number | null;
  repliesYesterday: number | null;
}

/** Build Ledger counts (operator directive 2026-09-05) — optional, one
 *  short line appended to the digest when present. */
export interface DigestBuild {
  inWorks: number;
  operatorActions: number;
}

/** The single 8:30am digest — decisions waiting, $ at stake, belt status,
 *  and (when supplied) the build ledger's one-line status. Kept under
 *  ~300 chars total. */
export function composeDigestSms(
  items: ConveyorItem[],
  belt: DigestBelt | null,
  baseUrl: string,
  build?: DigestBuild | null,
): string {
  const byType = { "2A": 0, "2B": 0, "2C": 0 } as Record<ConveyorItem["type"], number>;
  let dollars = 0;
  for (const i of items) {
    byType[i.type]++;
    if (i.dollars != null) dollars += i.dollars;
  }
  const parts = [
    `AKB 8:30 - ${items.length} decision${items.length === 1 ? "" : "s"} waiting` +
      (items.length > 0 ? ` (${byType["2A"]} sends, ${byType["2B"]} money, ${byType["2C"]} rulings)` : ""),
    dollars > 0 ? `${money(dollars)} at stake` : null,
    belt
      ? `belt: intake ${belt.intakeFreshness ?? "?"} | send ${belt.sendFreshness ?? "?"}` +
        (belt.sentYesterday != null ? ` | yday ${belt.sentYesterday} sent/${belt.repliesYesterday ?? 0} replies` : "")
      : null,
    build ? `Build: ${build.inWorks} in works | ${build.operatorActions} need you` : null,
    baseUrl,
  ].filter(Boolean);
  return parts.join(". ");
}
