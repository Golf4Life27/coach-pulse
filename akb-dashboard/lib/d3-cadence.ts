// D3 Follow-Up Cadence — pure classifier.
//
// Maps (Phase 0a scrub bucket + recency + reply state + List_Price drift)
// to a cadence action. The action names a template (DRAFT in
// scripts/outreach/) and an optional banner. Caller decides whether to
// actually fire — this module produces decisions, not side effects.
//
// Two principles ground every decision (Spine recmmidVrMyrLzjZp +
// recxxNF0U59MxYUqu):
//
//   65% Rule: opening offer = List_Price × 0.65 at outreach time.
//     Pricing Agent runs at gate stage, not intake stage.
//
//   Offer Discipline: once an offer is on the table, the number does
//     not revise downward without new property-side information.
//     Seller-side price drops are leverage for AKB's existing number,
//     not justification to lower it. Stored OfferPrice is sticky.
//
// Reads three real fields (added to Listings_V1 5/13):
//   Stored_Offer_Price       — sticky offer, captured at H2 send.
//   List_Price_At_Send       — list-price snapshot for drift detection.
//   Last_Status_Check_Sent_At — drives 3-day status_check timeout-to-dead.
// Existing pre-cadence records have these fields backfilled via the
// /api/admin/d3-backfill-offer-fields proxy (audit-flagged
// data_source=backfill_proxy).

import type { Listing } from "@/lib/types";
import type { ScrubBucket } from "@/lib/d3-scrub";
import cadenceConfig from "@/lib/config/d3-cadence.json";
import { normalizePhone } from "@/lib/phone-normalize";

const SCHEDULE = cadenceConfig.config.follow_up_schedule_days as number[];
const DRIFT_PCT = cadenceConfig.config.drift_threshold_pct;
const AUTO_DEAD_STATUS_CHECK = cadenceConfig.config.auto_dead_no_status_check_reply_days;
const AUTO_DEAD_FOLLOWUP = cadenceConfig.config.auto_dead_no_followup_reply_days;
const DRIFT_UP_BANNER = cadenceConfig.config.manual_review_banner_drift_up;
// Layer 1 depth-gate widening (5/15) — see config note. Tuned via
// lib/config/d3-cadence.json; surfaced here as a const for ergonomics.
const RECENT_TOUCHED_WINDOW_DAYS = cadenceConfig.config.recently_touched_window_days;

export type CadenceAction =
  | "send_status_check"
  | "send_follow_up_3"
  | "send_follow_up_7"
  | "send_follow_up_14"
  | "send_follow_up_drift_down"
  | "draft_positive_reply"
  | "hold_manual_review_drift_up"
  // Layer 1 depth-gate (5/14). Triggers when the listing's agent has
  // prior outreach on OTHER Listings_V1 records (cross-listing match
  // via normalized phone). Applies to ALL cadence-initiated outbound
  // — status_check, follow_up_3/7/14, follow_up_drift_down. Preserves
  // relationship warmth that cold templates would burn.
  | "hold_warm_contact_manual_draft"
  | "auto_dead_status_check_timeout"
  | "auto_dead_followup_timeout"
  | "wait_in_cadence"
  | "no_action_already_replied"
  | "no_action_pipeline_advanced"
  | "no_action_dead"
  | "no_action_invalid_phone"
  | "no_action_restricted"
  | "no_action_off_market"
  | "no_action_never_list";

export interface CadenceDecision {
  recordId: string;
  action: CadenceAction;
  template_id: string | null;
  banner: string | null;
  reasoning: string;
  data_examined: Record<string, unknown>;
  // Optional writes that would land if the cadence ran in apply mode
  // (e.g. auto-dead actions write Pipeline_Stage=dead). null = no write.
  pending_writes: Record<string, unknown> | null;
}

function daysBetween(a: Date, b: Date): number {
  return Math.floor((a.getTime() - b.getTime()) / (24 * 60 * 60_000));
}

function parseDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const t = new Date(iso);
  return isNaN(t.getTime()) ? null : t;
}

// Map scrub bucket → terminal "no_action" decision when cadence doesn't
// apply (record is already dead, restricted, etc.).
function terminalActionForBucket(bucket: ScrubBucket): CadenceAction | null {
  switch (bucket) {
    case "skip_restricted_state":
      return "no_action_restricted";
    case "skip_never_list":
      return "no_action_never_list";
    case "skip_pipeline_active":
      return "no_action_pipeline_advanced";
    case "skip_invalid_phone":
      return "no_action_invalid_phone";
    case "off_market_killed":
      return "no_action_off_market";
    default:
      return null;
  }
}

// Per-cadence-run input. Built once by the endpoint by grouping all
// Texted+Negotiating Listings_V1 records by normalizedPhone(Agent_Phone).
// For each phone the map stores the listingIds touched and the count.
// Bypasses the stored Agent_Prior_Outreach_Count field (which the
// upstream Make scan computes WITHOUT phone normalization and therefore
// undercounts — 5/14 finding: "(713) 231-1129" and "713-231-1129" are
// treated as two distinct phones today).
export interface AgentInteraction {
  count: number; // number of listings touching this phone in Texted/Negotiating
  listingIds: string[];
}
export type AgentInteractionMap = Map<string, AgentInteraction>;

// Layer 1 widening (5/15) — captures recent outreach to an agent
// REGARDLESS of the touched record's current Outreach_Status. Catches
// the case where a prior listing transitioned to Dead but the human
// agent still remembers our outreach. listingIds + statuses are
// parallel arrays so the classifier can name both the matched listing
// and its current status in the warm-route banner.
export interface RecentlyTouchedAgentEntry {
  listingIds: string[];
  statuses: string[]; // Outreach_Status values, parallel to listingIds
  mostRecentTouchedDate: string; // ISO YYYY-MM-DD
}
export type RecentlyTouchedAgentMap = Map<string, RecentlyTouchedAgentEntry>;

export interface CadenceInputs {
  listing: Listing;
  bucket: ScrubBucket;
  // Cross-listing agent interaction lookup. If omitted, the depth-gate
  // is silently skipped (legacy behavior). Endpoint always populates
  // post-5/14.
  agentInteractionMap?: AgentInteractionMap;
  // 5/15 widening — recent-touch lookup across ALL outreach statuses
  // within RECENT_TOUCHED_WINDOW_DAYS. Endpoint always populates.
  recentlyTouchedAgentMap?: RecentlyTouchedAgentMap;
  now?: Date; // injected for testing
}

/**
 * Classify a single record into a cadence action.
 */
export function classifyCadence(opts: CadenceInputs): CadenceDecision {
  const { listing, bucket } = opts;
  const now = opts.now ?? new Date();
  const recordId = listing.id;

  // Terminal scrub buckets — no cadence applies.
  const terminal = terminalActionForBucket(bucket);
  if (terminal) {
    return {
      recordId,
      action: terminal,
      template_id: null,
      banner: null,
      reasoning: `Scrub bucket=${bucket} — record is already terminal for cadence. No follow-up will fire.`,
      data_examined: { scrub_bucket: bucket },
      pending_writes: null,
    };
  }

  // Already-dead from outreach status side (defensive — scrub apply
  // should have caught these but skim again).
  if ((listing.outreachStatus ?? "").toLowerCase() === "dead") {
    return {
      recordId,
      action: "no_action_dead",
      template_id: null,
      banner: null,
      reasoning: `Outreach_Status=Dead — record already exited cadence.`,
      data_examined: { outreach_status: listing.outreachStatus },
      pending_writes: null,
    };
  }

  // Agent replied since last send. Cadence stops; orchestrator Gate 3
  // picks up. Compare Last_Inbound_At vs Last_Outreach_Date / Last_Outbound_At.
  const lastInbound = parseDate(listing.lastInboundAt);
  const lastOutbound = parseDate(listing.lastOutboundAt);
  const lastOutreach = parseDate(listing.lastOutreachDate);
  const lastStatusCheck = parseDate(listing.lastStatusCheckSentAt);
  const lastSendAt = lastOutbound ?? lastOutreach;
  if (lastInbound && lastSendAt && lastInbound > lastSendAt) {
    return {
      recordId,
      action: "no_action_already_replied",
      template_id: null,
      banner: null,
      reasoning: `Last_Inbound_At (${listing.lastInboundAt}) is after last send (${lastSendAt.toISOString()}). Cadence yields to orchestrator Gate 3 (pre-negotiation).`,
      data_examined: {
        last_inbound_at: listing.lastInboundAt,
        last_outbound_at: listing.lastOutboundAt,
        last_outreach_date: listing.lastOutreachDate,
      },
      pending_writes: null,
    };
  }

  // ── Layer 1 depth-gate (5/14, Spine recmmidVrMyrLzjZp + recxxNF0U59MxYUqu
  //    follow-on). Prevents cold-template fires on warm agent contacts.
  //
  // Looks up normalized Agent_Phone in agentInteractionMap. If this
  // agent appears on OTHER Listings_V1 records (count > 1, since this
  // record itself contributes one), we've contacted this agent before
  // on another listing. Cold copy on this listing would read as
  // "Alex doesn't remember me" and burns the relationship.
  //
  // Gate applies BEFORE the bucket-specific send paths but AFTER
  // terminal-bucket / dead / replied checks — those still take
  // precedence because a warm-but-invalid-phone or warm-but-dead
  // record can't be sent at all.
  if (opts.agentInteractionMap) {
    const normalized = normalizePhone(listing.agentPhone);
    if (normalized) {
      const interaction = opts.agentInteractionMap.get(normalized);
      if (interaction && interaction.count > 1) {
        const others = interaction.listingIds.filter((id) => id !== recordId);
        return {
          recordId,
          action: "hold_warm_contact_manual_draft",
          template_id: null,
          banner: `Warm contact — agent has ${others.length} other Listings_V1 record(s). Manual draft required.`,
          reasoning: `Agent_Phone "${listing.agentPhone}" normalized to ${normalized} matches ${others.length} OTHER record(s) in Texted/Negotiating. Cold cadence templates would burn the relationship; route to Action Queue for manual draft.`,
          data_examined: {
            agent_phone_raw: listing.agentPhone,
            agent_phone_normalized: normalized,
            interaction_count: interaction.count,
            other_listing_ids_sample: others.slice(0, 5),
            scrub_bucket: bucket,
          },
          pending_writes: null,
        };
      }
    }
  }

  // ── Layer 1 widening (5/15) — recent-touch warm gate.
  //
  // Catches the case Layer 1's status-scoped check misses: agent was
  // texted recently on a DIFFERENT listing that has since transitioned
  // to a non-active status (Dead, Off Market, etc). The human agent
  // still remembers our outreach even though our system no longer
  // tracks the listing as in-pipeline. Cold cadence on a new listing
  // for the same agent would burn that residual relationship.
  //
  // Runs AFTER the same-status Layer 1 check so actively-active
  // relationships keep the more informative original banner.
  // Window: RECENT_TOUCHED_WINDOW_DAYS (default 30, configurable in
  // lib/config/d3-cadence.json).
  if (opts.recentlyTouchedAgentMap) {
    const normalized = normalizePhone(listing.agentPhone);
    if (normalized) {
      const entry = opts.recentlyTouchedAgentMap.get(normalized);
      if (entry) {
        // Walk parallel arrays excluding self.
        const others: Array<{ listingId: string; status: string }> = [];
        for (let i = 0; i < entry.listingIds.length; i++) {
          if (entry.listingIds[i] !== recordId) {
            others.push({
              listingId: entry.listingIds[i],
              status: entry.statuses[i] ?? "(unknown)",
            });
          }
        }
        if (others.length > 0) {
          const uniqueStatuses = [...new Set(others.map((o) => o.status))].sort();
          const statusLabel = uniqueStatuses.join(", ");
          return {
            recordId,
            action: "hold_warm_contact_manual_draft",
            template_id: null,
            banner: `Warm contact — agent was texted within last ${RECENT_TOUCHED_WINDOW_DAYS} days on ${others.length} other listing(s) (now ${statusLabel}). Manual draft required.`,
            reasoning: `Agent_Phone "${listing.agentPhone}" normalized to ${normalized} appears on ${others.length} OTHER record(s) with Last_Outreach_Date within last ${RECENT_TOUCHED_WINDOW_DAYS} days. Status(es): ${statusLabel}. Memory of prior contact may still be active even though those listings have moved out of active outreach. Route to Action Queue for manual draft.`,
            data_examined: {
              agent_phone_raw: listing.agentPhone,
              agent_phone_normalized: normalized,
              other_recently_touched_listings: others.slice(0, 5),
              other_statuses: uniqueStatuses,
              window_days: RECENT_TOUCHED_WINDOW_DAYS,
              most_recent_touched_date: entry.mostRecentTouchedDate,
              scrub_bucket: bucket,
            },
            pending_writes: null,
          };
        }
      }
    }
  }

  // Active eligible path — standard follow_up_3/7/14 cadence.
  if (bucket === "active_eligible") {
    if (!lastSendAt) {
      return {
        recordId,
        action: "wait_in_cadence",
        template_id: null,
        banner: null,
        reasoning:
          "active_eligible but no Last_Outreach_Date or Last_Outbound_At — can't compute cadence position. Likely a data gap; investigate.",
        data_examined: {
          last_outreach_date: listing.lastOutreachDate,
          last_outbound_at: listing.lastOutboundAt,
        },
        pending_writes: null,
      };
    }

    const daysSinceSend = daysBetween(now, lastSendAt);
    const followUpCount = listing.followUpCount ?? 0;

    // Already exhausted the schedule — check timeout-to-dead.
    if (followUpCount >= SCHEDULE.length) {
      if (daysSinceSend >= AUTO_DEAD_FOLLOWUP) {
        return {
          recordId,
          action: "auto_dead_followup_timeout",
          template_id: null,
          banner: null,
          reasoning: `follow_up_count=${followUpCount} (schedule exhausted), days_since_last_send=${daysSinceSend} >= ${AUTO_DEAD_FOLLOWUP}. Auto-dead.`,
          data_examined: {
            follow_up_count: followUpCount,
            days_since_send: daysSinceSend,
            auto_dead_threshold_days: AUTO_DEAD_FOLLOWUP,
          },
          pending_writes: {
            Pipeline_Stage: "dead",
            Outreach_Status: "Dead",
          },
        };
      }
      return {
        recordId,
        action: "wait_in_cadence",
        template_id: null,
        banner: null,
        reasoning: `follow_up_count=${followUpCount} (schedule exhausted), days_since_send=${daysSinceSend} < ${AUTO_DEAD_FOLLOWUP}. Waiting for auto-dead window.`,
        data_examined: {
          follow_up_count: followUpCount,
          days_since_send: daysSinceSend,
          auto_dead_threshold_days: AUTO_DEAD_FOLLOWUP,
        },
        pending_writes: null,
      };
    }

    const nextDay = SCHEDULE[followUpCount];
    if (daysSinceSend < nextDay) {
      return {
        recordId,
        action: "wait_in_cadence",
        template_id: null,
        banner: null,
        reasoning: `follow_up_count=${followUpCount}, next follow-up at day ${nextDay}, days_since_send=${daysSinceSend}. Wait.`,
        data_examined: {
          follow_up_count: followUpCount,
          days_since_send: daysSinceSend,
          next_followup_at_day: nextDay,
        },
        pending_writes: null,
      };
    }

    // Time to send. Drift-check before picking template. Uses real
    // List_Price_At_Send + Stored_Offer_Price fields.
    const atSend = listing.listPriceAtSend ?? null;
    const storedOffer = listing.storedOfferPrice ?? null;
    const current = listing.listPrice ?? null;

    let drift_pct = 0;
    if (typeof atSend === "number" && atSend > 0 && typeof current === "number" && current > 0) {
      drift_pct = (current - atSend) / atSend;
    }

    const driftData = {
      list_price_at_send: atSend,
      list_price_current: current,
      drift_pct,
      drift_threshold: DRIFT_PCT,
      stored_offer_price: storedOffer,
      follow_up_count: followUpCount,
      days_since_send: daysSinceSend,
    };

    if (drift_pct > DRIFT_PCT) {
      return {
        recordId,
        action: "hold_manual_review_drift_up",
        template_id: null,
        banner: DRIFT_UP_BANNER,
        reasoning: `Drift up ${(drift_pct * 100).toFixed(1)}% (List_Price $${current} vs at-send $${atSend}). Seller got aggressive — possible new property-side info. Hold for Manual Review.`,
        data_examined: driftData,
        pending_writes: null,
      };
    }

    if (drift_pct < -DRIFT_PCT) {
      return {
        recordId,
        action: "send_follow_up_drift_down",
        template_id: "follow_up_drift_down",
        banner: null,
        reasoning: `Drift down ${(drift_pct * 100).toFixed(1)}% (List_Price $${current} vs at-send $${atSend}). Per offer-discipline: stored OfferPrice $${storedOffer} holds; switch to drift-down template.`,
        data_examined: driftData,
        pending_writes: null,
      };
    }

    // Within ±10% — standard follow-up.
    const templateId =
      nextDay === 3 ? "follow_up_3" : nextDay === 7 ? "follow_up_7" : "follow_up_14";
    const actionId =
      nextDay === 3
        ? ("send_follow_up_3" as const)
        : nextDay === 7
          ? ("send_follow_up_7" as const)
          : ("send_follow_up_14" as const);

    return {
      recordId,
      action: actionId,
      template_id: templateId,
      banner: null,
      reasoning: `active_eligible, follow_up_count=${followUpCount}, days_since_send=${daysSinceSend} >= ${nextDay}. Drift within ±${(DRIFT_PCT * 100).toFixed(0)}%. Send ${templateId} at stored OfferPrice $${storedOffer}.`,
      data_examined: driftData,
      pending_writes: null,
    };
  }

  // pending_reverification — needs status_check probe.
  //
  // If Last_Status_Check_Sent_At is set: check timeout-to-dead window.
  // Else: send first status_check.
  if (bucket === "pending_reverification") {
    if (lastStatusCheck) {
      const daysSinceProbe = daysBetween(now, lastStatusCheck);
      if (daysSinceProbe >= AUTO_DEAD_STATUS_CHECK) {
        return {
          recordId,
          action: "auto_dead_status_check_timeout",
          template_id: null,
          banner: null,
          reasoning: `status_check sent ${daysSinceProbe} days ago (>=${AUTO_DEAD_STATUS_CHECK}), no agent reply. Auto-dead.`,
          data_examined: {
            scrub_bucket: bucket,
            last_status_check_sent_at: listing.lastStatusCheckSentAt,
            days_since_status_check: daysSinceProbe,
            auto_dead_threshold_days: AUTO_DEAD_STATUS_CHECK,
          },
          pending_writes: {
            Pipeline_Stage: "dead",
            Outreach_Status: "Dead",
          },
        };
      }
      return {
        recordId,
        action: "wait_in_cadence",
        template_id: null,
        banner: null,
        reasoning: `status_check sent ${daysSinceProbe} days ago, waiting for ${AUTO_DEAD_STATUS_CHECK}-day auto-dead window.`,
        data_examined: {
          scrub_bucket: bucket,
          last_status_check_sent_at: listing.lastStatusCheckSentAt,
          days_since_status_check: daysSinceProbe,
          auto_dead_threshold_days: AUTO_DEAD_STATUS_CHECK,
        },
        pending_writes: null,
      };
    }
    return {
      recordId,
      action: "send_status_check",
      template_id: "status_check",
      banner: null,
      reasoning: `pending_reverification, no prior status_check (Last_Status_Check_Sent_At null). Send first probe; ${AUTO_DEAD_STATUS_CHECK}-day window starts on send.`,
      data_examined: {
        scrub_bucket: bucket,
        last_verified: listing.lastVerified,
        live_status: listing.liveStatus,
      },
      pending_writes: null,
    };
  }

  // Shouldn't reach here — every scrub bucket has been handled above.
  // Defensive default surfaces this in audit instead of throwing.
  return {
    recordId,
    action: "wait_in_cadence",
    template_id: null,
    banner: null,
    reasoning: `Unhandled scrub bucket=${bucket}. Defensive fallthrough — surface as data issue.`,
    data_examined: { scrub_bucket: bucket },
    pending_writes: null,
  };
}

export interface CadenceSummary {
  total_examined: number;
  by_action: Record<CadenceAction, number>;
  templates_pending_alex_approval: string[];
}

export function summarizeCadence(decisions: CadenceDecision[]): CadenceSummary {
  const by_action: Record<CadenceAction, number> = {
    send_status_check: 0,
    send_follow_up_3: 0,
    send_follow_up_7: 0,
    send_follow_up_14: 0,
    send_follow_up_drift_down: 0,
    draft_positive_reply: 0,
    hold_manual_review_drift_up: 0,
    hold_warm_contact_manual_draft: 0,
    auto_dead_status_check_timeout: 0,
    auto_dead_followup_timeout: 0,
    wait_in_cadence: 0,
    no_action_already_replied: 0,
    no_action_pipeline_advanced: 0,
    no_action_dead: 0,
    no_action_invalid_phone: 0,
    no_action_restricted: 0,
    no_action_off_market: 0,
    no_action_never_list: 0,
  };
  const templatesTouched = new Set<string>();

  for (const d of decisions) {
    by_action[d.action]++;
    if (d.template_id) templatesTouched.add(d.template_id);
  }

  return {
    total_examined: decisions.length,
    by_action,
    templates_pending_alex_approval: [...templatesTouched].sort(),
  };
}
