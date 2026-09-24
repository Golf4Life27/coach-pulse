// The 14-day silence Death Rule — operator ruling 2026-09-23, spine
// reclKuvb2ZlGTL09O; approved for build as P0-10, spine recYbAYqkguZSOTeF
// (2026-09-24).
//
// THE RULE, verbatim intent: an UNSIGNED deal where the other side
// (seller/agent) has been silent 14+ days is Dead. Only a NEW message from
// them brings it back (that resurrection path already exists —
// lib/resurrection.ts). Signed deals never die this way: an executed
// contract routes to a termination-card decision for the operator instead,
// regardless of how long the record has been silent.
//
// THE CLOCK: Last_Inbound_At (the counterparty's last message), regardless
// of who technically owes the next reply. A record where they spoke 15 days
// ago and we simply never followed up still dies — the rule tracks THEIR
// silence, not our responsiveness.
//
// OUT OF SCOPE: a record that was never engaged (cold outreach, no reply
// ever — no Last_Inbound_At and never in an engaged status) isn't touched
// here; the outreach lanes (H2 cadence, bump-followup, etc.) own that
// population's lifecycle, not this rule. It classifies `alive`.
//
// Pure — no IO. The caller (the cron route) supplies each record's fields
// and decides what to do with the verdict.

export type DeathRuleVerdict = "dead" | "alive" | "executed_needs_termination_card";

/** The subset of Listings_V1 fields the rule reads. Field names match the
 *  Airtable schema (see lib/airtable.ts LISTING_FIELD_REGISTRY). */
export interface DeathRuleRecord {
  outreachStatus: string | null;
  /** Last_Inbound_At — the counterparty's last message. THE clock. */
  lastInboundAt: string | null;
  /** Last_Outbound_At — used only as a fallback clock, and only for a
   *  record already in an engaged status with no Last_Inbound_At. */
  lastOutboundAt?: string | null;
  /** Last_Outreach_Date — same fallback role as lastOutboundAt; whichever
   *  of the two is present is used. */
  lastOutreachDate?: string | null;
  /** Airtable's record-creation timestamp — last-resort fallback clock
   *  ("first contact") when neither outbound timestamp is populated. */
  createdTime?: string | null;
  /** Contract_Executed_At — set means a signed deal. Never Dead. */
  contractExecutedAt?: string | null;
}

export interface DeathRuleResult {
  verdict: DeathRuleVerdict;
  /** Whole days of counterparty silence the verdict was computed from.
   *  null when there was no clock to compute from (out of scope / executed
   *  / already Dead). */
  daysSilent: number | null;
  /** Which field supplied the clock, for audit/debugging. null when no
   *  clock was used. */
  clockSource: "last_inbound" | "fallback_engaged" | null;
}

export const DEATH_RULE_SILENCE_DAYS = 14;
export const DEATH_RULE_SILENCE_MS = DEATH_RULE_SILENCE_DAYS * 24 * 60 * 60 * 1000;

/** Outreach_Status values that mean the counterparty engaged at all — the
 *  same set lib/stale-triage.ts / stale-deal-triage cron already treat as
 *  "responded". A record in one of these with no Last_Inbound_At still gets
 *  a fallback clock instead of being waved through as never-engaged. */
const ENGAGED_STATUSES: ReadonlySet<string> = new Set([
  "Response Received",
  "Negotiating",
  "Counter Received",
  "Offer Accepted",
]);

export function isEngagedStatus(status: string | null | undefined): boolean {
  return status != null && ENGAGED_STATUSES.has(status);
}

const NOT_APPLICABLE: DeathRuleResult = { verdict: "alive", daysSilent: null, clockSource: null };

/**
 * Decide dead | alive | executed_needs_termination_card for one record.
 * Pure; takes `now` explicitly so it's trivially testable.
 */
export function classifyDeathRule(record: DeathRuleRecord, nowIso: string): DeathRuleResult {
  // Signed deals never die this way — checked first so it overrides even a
  // record someone already (mis)flipped toward Dead.
  if (record.contractExecutedAt) {
    return { verdict: "executed_needs_termination_card", daysSilent: null, clockSource: null };
  }

  // Already Dead — this rule only KILLS, it never resurrects (that's
  // lib/resurrection.ts's job, triggered by a fresh non-rejection inbound).
  if (record.outreachStatus === "Dead") {
    return NOT_APPLICABLE;
  }

  let clockIso = record.lastInboundAt ?? null;
  let clockSource: DeathRuleResult["clockSource"] = clockIso ? "last_inbound" : null;

  if (!clockIso) {
    // Never engaged (no reply ever, and not sitting in an engaged status
    // some other way) — out of scope for this rule.
    if (!isEngagedStatus(record.outreachStatus)) {
      return NOT_APPLICABLE;
    }
    clockIso = record.lastOutboundAt ?? record.lastOutreachDate ?? record.createdTime ?? null;
    clockSource = clockIso ? "fallback_engaged" : null;
  }

  if (!clockIso) {
    // Engaged status but no timestamp anywhere to compute silence from —
    // never kill on missing data.
    return NOT_APPLICABLE;
  }

  const clockMs = new Date(clockIso).getTime();
  if (!Number.isFinite(clockMs)) {
    return NOT_APPLICABLE;
  }

  const nowMs = new Date(nowIso).getTime();
  const silentMs = nowMs - clockMs;
  const daysSilent = Math.floor(silentMs / (24 * 60 * 60 * 1000));

  if (silentMs >= DEATH_RULE_SILENCE_MS) {
    return { verdict: "dead", daysSilent, clockSource };
  }
  return { verdict: "alive", daysSilent, clockSource };
}
