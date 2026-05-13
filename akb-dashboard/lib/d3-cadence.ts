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
// Schema gap acknowledged:
//   The clean implementation of "stored List_Price-at-send" and
//   "stored OfferPrice" needs two new Listings_V1 fields:
//     - List_Price_At_Send (currency, captured at H2 outreach time)
//     - Stored_Offer_Price (currency, captured at H2 outreach time)
//   Until those exist, this module uses Prev_List_Price as the
//   best-available proxy for List_Price-at-send (works correctly only
//   when there has been at most one price change since outreach), and
//   derives stored_offer_price = (Prev_List_Price ?? List_Price) × 0.65.
//   Each decision surfaces `schema_gaps` so the audit log records when
//   proxies were used.

import type { Listing } from "@/lib/types";
import type { ScrubBucket } from "@/lib/d3-scrub";
import cadenceConfig from "@/lib/config/d3-cadence.json";

const SCHEDULE = cadenceConfig.config.follow_up_schedule_days as number[];
const DRIFT_PCT = cadenceConfig.config.drift_threshold_pct;
const AUTO_DEAD_STATUS_CHECK = cadenceConfig.config.auto_dead_no_status_check_reply_days;
const AUTO_DEAD_FOLLOWUP = cadenceConfig.config.auto_dead_no_followup_reply_days;
const DRIFT_UP_BANNER = cadenceConfig.config.manual_review_banner_drift_up;

export type CadenceAction =
  | "send_status_check"
  | "send_follow_up_3"
  | "send_follow_up_7"
  | "send_follow_up_14"
  | "send_follow_up_drift_down"
  | "draft_positive_reply"
  | "hold_manual_review_drift_up"
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
  // Schema-gap markers — each entry names a missing data source the
  // engine had to proxy or guess.
  schema_gaps: string[];
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

// Determine "stored OfferPrice" — what AKB texted the seller's agent
// at outreach time. Sticky by design per Offer Discipline. Until
// Stored_Offer_Price field exists on Listings_V1, the cleanest proxy
// is 65% of the pre-drop List_Price (which we approximate with
// Prev_List_Price if a drop has happened, else current List_Price).
function deriveStoredOfferPrice(listing: Listing): {
  value: number | null;
  source: "list_price_at_send_field" | "prev_list_price_proxy" | "current_list_price_proxy" | "unavailable";
  schemaGap: string | null;
} {
  // When Stored_Offer_Price field is added, this branch wins.
  // const stored = listing.storedOfferPrice;
  // if (typeof stored === "number" && stored > 0) {
  //   return { value: stored, source: "list_price_at_send_field", schemaGap: null };
  // }

  const prev = listing.prevListPrice;
  if (typeof prev === "number" && prev > 0) {
    return {
      value: Math.round(prev * 0.65),
      source: "prev_list_price_proxy",
      schemaGap:
        "stored_offer_price_proxied_from_prev_list_price — accurate only if exactly one price drop has happened since outreach",
    };
  }

  const current = listing.listPrice;
  if (typeof current === "number" && current > 0) {
    return {
      value: Math.round(current * 0.65),
      source: "current_list_price_proxy",
      schemaGap:
        "stored_offer_price_proxied_from_current_list_price — assumes no price drift since outreach (true when prev_list_price is null)",
    };
  }

  return {
    value: null,
    source: "unavailable",
    schemaGap: "stored_offer_price_unavailable — no list_price + no prev_list_price",
  };
}

// "List_Price at the moment outreach went out" — needed for drift
// detection. Same schema gap as above. Best proxy:
//   - If Prev_List_Price exists: it WAS the price at send time (assumes
//     exactly one drop since outreach).
//   - If Prev_List_Price is null: no drop has happened since outreach,
//     so current List_Price = price at send time → drift = 0.
function deriveListPriceAtSend(listing: Listing): {
  value: number | null;
  drifted: boolean;
  schemaGap: string | null;
} {
  const prev = listing.prevListPrice;
  if (typeof prev === "number" && prev > 0) {
    return {
      value: prev,
      drifted: true,
      schemaGap:
        "list_price_at_send_proxied_from_prev_list_price — accurate only if exactly one price drop since outreach",
    };
  }
  const current = listing.listPrice;
  if (typeof current === "number" && current > 0) {
    return {
      value: current,
      drifted: false,
      schemaGap: null, // unambiguous when no drop has happened
    };
  }
  return {
    value: null,
    drifted: false,
    schemaGap: "list_price_at_send_unavailable — no list_price + no prev_list_price",
  };
}

export interface CadenceInputs {
  listing: Listing;
  bucket: ScrubBucket;
  now?: Date; // injected for testing
}

/**
 * Classify a single record into a cadence action.
 */
export function classifyCadence(opts: CadenceInputs): CadenceDecision {
  const { listing, bucket } = opts;
  const now = opts.now ?? new Date();
  const recordId = listing.id;
  const schemaGaps: string[] = [];

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
      schema_gaps: [],
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
      schema_gaps: [],
    };
  }

  // Agent replied since outreach. Cadence stops; orchestrator Gate 3
  // picks up. Compare Last_Inbound_At vs Last_Outreach_Date / Last_Outbound_At.
  const lastInbound = parseDate(listing.lastInboundAt);
  const lastOutbound = parseDate(listing.lastOutboundAt);
  const lastOutreach = parseDate(listing.lastOutreachDate);
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
      schema_gaps: [],
    };
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
        schema_gaps: ["last_send_timestamp_missing_for_active_eligible"],
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
          schema_gaps: [],
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
        schema_gaps: [],
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
        schema_gaps: [],
      };
    }

    // Time to send. Drift-check before picking template.
    const atSend = deriveListPriceAtSend(listing);
    if (atSend.schemaGap) schemaGaps.push(atSend.schemaGap);
    const offer = deriveStoredOfferPrice(listing);
    if (offer.schemaGap) schemaGaps.push(offer.schemaGap);

    const current = listing.listPrice ?? null;
    let drift_pct = 0;
    if (atSend.value && current && current > 0) {
      drift_pct = (current - atSend.value) / atSend.value;
    }

    const driftData = {
      list_price_at_send: atSend.value,
      list_price_current: current,
      drift_pct,
      drift_threshold: DRIFT_PCT,
      stored_offer_price: offer.value,
      stored_offer_price_source: offer.source,
      follow_up_count: followUpCount,
      days_since_send: daysSinceSend,
    };

    if (drift_pct > DRIFT_PCT) {
      return {
        recordId,
        action: "hold_manual_review_drift_up",
        template_id: null,
        banner: DRIFT_UP_BANNER,
        reasoning: `Drift up ${(drift_pct * 100).toFixed(1)}% (List_Price $${current} vs at-send $${atSend.value}). Seller got aggressive — possible new property-side info. Hold for Manual Review.`,
        data_examined: driftData,
        pending_writes: null,
        schema_gaps: schemaGaps,
      };
    }

    if (drift_pct < -DRIFT_PCT) {
      return {
        recordId,
        action: "send_follow_up_drift_down",
        template_id: "follow_up_drift_down",
        banner: null,
        reasoning: `Drift down ${(drift_pct * 100).toFixed(1)}% (List_Price $${current} vs at-send $${atSend.value}). Per offer-discipline: stored OfferPrice $${offer.value} holds; switch to drift-down template.`,
        data_examined: driftData,
        pending_writes: null,
        schema_gaps: schemaGaps,
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
      reasoning: `active_eligible, follow_up_count=${followUpCount}, days_since_send=${daysSinceSend} >= ${nextDay}. Drift within ±${(DRIFT_PCT * 100).toFixed(0)}%. Send ${templateId} at stored OfferPrice $${offer.value}.`,
      data_examined: driftData,
      pending_writes: null,
      schema_gaps: schemaGaps,
    };
  }

  // pending_reverification — needs status_check probe.
  //
  // The clean implementation needs a Last_Status_Check_Sent_At field on
  // Listings_V1 so we can detect timeout-to-dead. Without it, every
  // pending_reverification record looks like "needs first status_check"
  // and the 3-day timeout can't fire. Flagged in schema_gaps.
  if (bucket === "pending_reverification") {
    schemaGaps.push(
      "last_status_check_sent_at_field_missing — 3-day timeout-to-dead can't be detected without this field; every pending_reverification looks like a fresh first-time status_check.",
    );
    return {
      recordId,
      action: "send_status_check",
      template_id: "status_check",
      banner: null,
      reasoning: `pending_reverification — send status_check probe. Auto-dead window: ${AUTO_DEAD_STATUS_CHECK} days (requires Last_Status_Check_Sent_At field, not yet on Listings_V1).`,
      data_examined: {
        scrub_bucket: bucket,
        last_verified: listing.lastVerified,
        live_status: listing.liveStatus,
      },
      pending_writes: null,
      schema_gaps: schemaGaps,
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
    schema_gaps: ["unhandled_scrub_bucket_in_cadence_classifier"],
  };
}

export interface CadenceSummary {
  total_examined: number;
  by_action: Record<CadenceAction, number>;
  templates_pending_alex_approval: string[];
  schema_gaps_summary: Record<string, number>;
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
  const schema_gaps_summary: Record<string, number> = {};
  const templatesTouched = new Set<string>();

  for (const d of decisions) {
    by_action[d.action]++;
    if (d.template_id) templatesTouched.add(d.template_id);
    for (const gap of d.schema_gaps) {
      schema_gaps_summary[gap] = (schema_gaps_summary[gap] ?? 0) + 1;
    }
  }

  return {
    total_examined: decisions.length,
    by_action,
    templates_pending_alex_approval: [...templatesTouched].sort(),
    schema_gaps_summary,
  };
}
