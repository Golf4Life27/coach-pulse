// Pre-Negotiation Gate (Gate 3) check functions — 19 items per
// AKB_Deal_Flow_Orchestrator_Spec §4 + 5/13 PN-07a amendment.
//
// This gate runs every time a reply lands or any negotiation move is
// considered. It is the gate that would have caught the 5/12 Briyana
// failure (sqft 1100 modeled vs 1548 CMA, gut-rehab condition vs
// modeled "Poor + cosmetic"). The four target items per Alex 5/13:
//
//   PN-07   sqft variance vs CMA      — block on >15% delta
//   PN-07a  photo condition variance  — Phase 1 surfaces URLs, data_missing
//                                       on vision parse. Phase 2 vision
//                                       parse blocks on >50% variance.
//   PN-12   Pricing Agent refresh     — blocks when PN-07 detected variance
//   PN-14   Your_MAO vs counter price — blocks on counter > Your_MAO
//
// Phase 1 explicit data_missing items (per Alex 5/13 scoping):
//   PN-08  ownership of record — no seller field on Listings_V1
//   PN-09  liens > sale price — no lien data source wired
//   PN-16  decision spiral    — no Pricing_Last_Run history yet
//   PN-18  template approval  — no template library yet
//
// Reuses lib/quo getMessagesForParticipant, lib/gmail getThreadsForEmail,
// lib/rentcast getSaleComparables — pre-fetched by gate-runner per spec
// §10.2 parallel data fetch.

import preNegotiationConfig from "@/lib/config/gates/pre_negotiation.json";
import { collectPhotos } from "@/lib/photo-sources";
import type { CheckFn, CheckResult, ChecklistItem, Gate } from "./types";

export const PRE_NEGOTIATION_GATE: Gate = {
  id: preNegotiationConfig.gate_id,
  stage_from: preNegotiationConfig.stage_from as Gate["stage_from"],
  stage_to: preNegotiationConfig.stage_to as Gate["stage_to"],
  items: preNegotiationConfig.items as ChecklistItem[],
};

export const PRE_NEGOTIATION_CONFIG = preNegotiationConfig.config as {
  list_price_change_warn_pct: number;
  sqft_variance_block_pct: number;
  photo_condition_variance_block_pct: number;
  counter_classify_regex_dollar: string;
  rejection_phrases: string[];
  interest_phrases: string[];
  question_marker: string;
  inspection_waiver_phrases: string[];
  confidence_high_threshold: number;
  confidence_low_threshold: number;
};

// ── Helpers ───────────────────────────────────────────────────────────

function pass(item_id: string, reasoning: string, data_examined: Record<string, unknown>, failure_action: ChecklistItem["failure_action"] = "block"): CheckResult {
  return { item_id, status: "pass", reasoning, data_examined, failure_action };
}
function fail(item_id: string, reasoning: string, data_examined: Record<string, unknown>, failure_action: ChecklistItem["failure_action"] = "block"): CheckResult {
  return { item_id, status: "fail", reasoning, data_examined, failure_action };
}
function warn(item_id: string, reasoning: string, data_examined: Record<string, unknown>): CheckResult {
  return { item_id, status: "warning", reasoning, data_examined, failure_action: "warn" };
}
function dataMissing(item_id: string, reasoning: string, data_examined: Record<string, unknown>, failure_action: ChecklistItem["failure_action"] = "block"): CheckResult {
  return { item_id, status: "data_missing", reasoning, data_examined, failure_action };
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

// Classify reply per spec §4 PN-10. Returns route + optional counter_price.
type ReplyRoute = "rejection" | "interest" | "counter" | "question" | "inbound_lead" | "no_reply";
function classifyReply(
  bodies: string[],
  cfg: typeof PRE_NEGOTIATION_CONFIG,
): { route: ReplyRoute; counter_price: number | null; matched_text: string | null } {
  if (bodies.length === 0) return { route: "no_reply", counter_price: null, matched_text: null };
  // Use the most recent inbound; assumed to be ordered most-recent-first
  // by the caller (we sort defensively below).
  const lower = bodies.map((b) => b.toLowerCase().trim()).filter(Boolean);
  if (lower.length === 0) return { route: "no_reply", counter_price: null, matched_text: null };
  const latest = lower[0];

  for (const r of cfg.rejection_phrases) {
    if (latest.includes(r.toLowerCase())) {
      return { route: "rejection", counter_price: null, matched_text: r };
    }
  }
  // Counter: dollar-amount regex
  const dollarRe = new RegExp(cfg.counter_classify_regex_dollar);
  const dollarMatch = latest.match(dollarRe);
  if (dollarMatch) {
    const raw = dollarMatch[1].replace(/,/g, "");
    const n = Number(raw);
    if (!isNaN(n) && n > 100) {
      // Threshold $100 to avoid catching "$5" / dates / etc. False
      // positives still possible (e.g. "I closed at $99 last week");
      // PN-14's downstream sanity catches obviously wrong values.
      return { route: "counter", counter_price: n, matched_text: dollarMatch[0] };
    }
  }
  for (const i of cfg.interest_phrases) {
    if (latest.includes(i.toLowerCase())) {
      return { route: "interest", counter_price: null, matched_text: i };
    }
  }
  if (latest.includes(cfg.question_marker)) {
    return { route: "question", counter_price: null, matched_text: "?" };
  }
  return { route: "inbound_lead", counter_price: null, matched_text: null };
}

// Map ARV_Confidence singleSelect + Rehab_Confidence_Score number to
// composite HIGH / MED / LOW. Conservative — takes the WORSE of the two.
function compositeConfidence(
  arvConf: string | null | undefined,
  rehabScore: number | null | undefined,
  cfg: typeof PRE_NEGOTIATION_CONFIG,
): "HIGH" | "MED" | "LOW" {
  const arvLevel = arvConf?.toLowerCase() === "high" ? 2 : arvConf?.toLowerCase() === "medium" ? 1 : 0;
  const rehabLevel =
    rehabScore == null
      ? 0
      : rehabScore >= cfg.confidence_high_threshold
        ? 2
        : rehabScore >= cfg.confidence_low_threshold
          ? 1
          : 0;
  const min = Math.min(arvLevel, rehabLevel);
  return min === 2 ? "HIGH" : min === 1 ? "MED" : "LOW";
}

// ── Checks ────────────────────────────────────────────────────────────

const PN_01_quo_thread: CheckFn = (ctx) => {
  const thread = ctx.quoThread;
  if (thread == null) {
    return dataMissing("PN-01", "Quo thread fetch failed or listing.agentPhone unset", {
      missing_data_source: "quo_thread",
      recordId: ctx.recordId,
    });
  }
  return pass("PN-01", `Quo thread pulled (${thread.length} messages)`, {
    quo_message_count: thread.length,
    agent_phone: ctx.listing?.agentPhone ?? null,
  });
};

const PN_02_gmail_thread: CheckFn = (ctx) => {
  const thread = ctx.gmailThread;
  if (thread == null) {
    return dataMissing("PN-02", "Gmail thread fetch failed or listing.agentEmail unset", {
      missing_data_source: "gmail_thread",
      recordId: ctx.recordId,
    });
  }
  return pass("PN-02", `Gmail thread pulled (${thread.length} messages)`, {
    gmail_message_count: thread.length,
    agent_email: ctx.listing?.agentEmail ?? null,
  });
};

const PN_03_live_listing: CheckFn = (ctx) => {
  const ll = ctx.liveListing;
  if (!ll) {
    return dataMissing("PN-03", "live_listing snapshot unavailable", {
      missing_data_source: "live_listing",
      recordId: ctx.recordId,
    });
  }
  if (!ll.listingStatus) {
    return dataMissing(
      "PN-03",
      "live_listing snapshot returned but listingStatus is null (Phase 1 uses Airtable Live_Status — not set on this record)",
      { live_listing: ll },
    );
  }
  return pass("PN-03", `live_listing pulled (status=${ll.listingStatus})`, { live_listing: ll });
};

const PN_04_listing_active: CheckFn = (ctx) => {
  const status = ctx.liveListing?.listingStatus;
  if (!status) {
    return dataMissing("PN-04", "live_listing.listingStatus unset — can't verify Active", {
      missing_data_source: "live_listing.listingStatus",
      recordId: ctx.recordId,
    });
  }
  if (status.toLowerCase() !== "active") {
    return fail("PN-04", `Listing status is "${status}" — must be Active`, { listing_status: status });
  }
  return pass("PN-04", `Listing status is Active`, { listing_status: status });
};

const PN_05_price_change: CheckFn = (ctx, cfg) => {
  const c = cfg as typeof PRE_NEGOTIATION_CONFIG;
  const current = ctx.listing?.listPrice;
  // Prev_List_Price isn't currently in the Listing type; readers can add
  // it later. For Phase 1, if we can't compare, surface as data_missing.
  if (current == null) {
    return dataMissing("PN-05", "List_Price unset — can't compare to prev", {
      missing_data_source: "airtable_listing.List_Price",
      recordId: ctx.recordId,
    });
  }
  // TODO: Prev_List_Price not yet mapped. Phase 1 emits a "no prior to
  // compare" pass; once Prev_List_Price is in the mapper, this fills in.
  return pass(
    "PN-05",
    "Prev_List_Price not yet wired to the mapper — change-detection deferred",
    {
      list_price: current,
      prev_list_price: null,
      change_threshold: c.list_price_change_warn_pct,
      note: "Add Prev_List_Price to LISTING_FIELDS (fldduzFLSaFBfIl9Rn) to enable",
    },
  );
};

const PN_06_cma: CheckFn = (ctx) => {
  const cma = ctx.cma;
  if (cma == null) {
    return dataMissing("PN-06", "CMA fetch failed", {
      missing_data_source: "cma",
      recordId: ctx.recordId,
    });
  }
  if (cma.length === 0) {
    return fail(
      "PN-06",
      "RentCast returned 0 comparables — can't validate against current market",
      { comp_count_raw: 0 },
    );
  }
  return pass("PN-06", `CMA pulled (${cma.length} comps)`, { comp_count_raw: cma.length });
};

const PN_07_sqft_matches_cma: CheckFn = (ctx, cfg) => {
  const c = cfg as typeof PRE_NEGOTIATION_CONFIG;
  const listingSqft = ctx.listing?.buildingSqFt;
  const compSqfts = (ctx.cma ?? [])
    .map((cp) => cp.squareFootage)
    .filter((s): s is number => s != null && s > 0);
  if (listingSqft == null) {
    return dataMissing("PN-07", "listing.buildingSqFt unset", {
      missing_data_source: "airtable_listing.Building_SqFt",
      recordId: ctx.recordId,
    });
  }
  if (compSqfts.length === 0) {
    return dataMissing(
      "PN-07",
      "No comps with sqft — can't compute CMA median for comparison",
      { missing_data_source: "cma[].squareFootage", recordId: ctx.recordId },
    );
  }
  const cmaMedian = median(compSqfts)!;
  const variance = Math.abs(listingSqft - cmaMedian) / cmaMedian;
  if (variance > c.sqft_variance_block_pct) {
    return fail(
      "PN-07",
      `Building_SqFt=${listingSqft} differs from CMA median ${Math.round(cmaMedian)} by ${(variance * 100).toFixed(0)}% (block at >${(c.sqft_variance_block_pct * 100).toFixed(0)}%) — listing may be using modeled default`,
      {
        listing_sqft: listingSqft,
        cma_median_sqft: Math.round(cmaMedian),
        variance_pct: variance,
        variance_threshold_pct: c.sqft_variance_block_pct,
        comp_count: compSqfts.length,
      },
    );
  }
  return pass(
    "PN-07",
    `Building_SqFt=${listingSqft} matches CMA median ${Math.round(cmaMedian)} within ${(c.sqft_variance_block_pct * 100).toFixed(0)}%`,
    { listing_sqft: listingSqft, cma_median_sqft: Math.round(cmaMedian), variance_pct: variance },
  );
};

// PN-07a is async (collectPhotos hits external sources). Wrap with a
// sync signature by returning a promise-resolved result; the gate-runner
// awaits results via Promise.allSettled — but the current runner expects
// sync CheckFn. Adapt: gate-runner needs async support, OR PN-07a does a
// best-effort pre-fetch via the gate-runner source dispatcher.
//
// Phase 1 simpler path: detect photo availability via verification_url
// presence (Airtable field) — if the listing has a Verification_URL the
// listing-scrape would have produced photos. Defer actual photo URL
// surfacing to Phase 2 when the live_listing fetcher gains a real
// scraping path. This keeps PN-07a synchronous + principle-compliant
// (data_missing with reasoning).
const PN_07a_photo_condition: CheckFn = (ctx) => {
  const verUrl = ctx.listing?.verificationUrl;
  if (!verUrl) {
    return dataMissing(
      "PN-07a",
      "Verification_URL unset — no photo source to scrape for condition assessment. Manual review required before proceeding.",
      {
        missing_data_source: "airtable_listing.Verification_URL",
        recordId: ctx.recordId,
        phase_1_note: "Phase 2 will pull photos via lib/photo-sources.collectPhotos and run vision-model condition parse",
      },
    );
  }
  return dataMissing(
    "PN-07a",
    `Photos available at ${verUrl} but condition_from_photos not parsed in Phase 1 — manual review required before negotiation move.`,
    {
      verification_url: verUrl,
      photo_count_estimate: "tbd",
      modeled_condition: "tbd",
      phase: 1,
      next_action: "human review of listing photos for condition vs modeled",
      phase_2_note: "Vision-model parse will compare interior photos to modeled condition; block on >50% variance",
    },
  );
};

const PN_08_ownership: CheckFn = (ctx) => {
  return dataMissing(
    "PN-08",
    "Phase 1: Listings_V1 has no seller_name field. Ownership verification requires either Deals-table link or RentCast property-owner API.",
    {
      missing_data_source: "airtable_listing.seller_name (not modeled)",
      recordId: ctx.recordId,
      phase: 1,
    },
    "warn",
  );
};

const PN_09_liens: CheckFn = (ctx) => {
  return dataMissing(
    "PN-09",
    "Phase 1: no lien data source wired. Future: title prelim integration or county records.",
    {
      missing_data_source: "title_prelim_or_county_records",
      recordId: ctx.recordId,
      phase: 1,
    },
    "warn",
  );
};

const PN_10_classify_reply: CheckFn = (ctx, cfg) => {
  const c = cfg as typeof PRE_NEGOTIATION_CONFIG;
  // Build the inbound list, most recent first. Quo direction "incoming",
  // Gmail we treat all messages as inbound for Phase 1 (the From-vs-To
  // distinction lives one level up in the parser).
  const quoInbound = (ctx.quoThread ?? [])
    .filter((m) => m.direction === "incoming")
    .map((m) => ({ ts: m.createdAt, body: m.body, source: "quo" as const }));
  const gmailInbound = (ctx.gmailThread ?? []).map((m) => ({
    ts: m.date,
    body: m.body,
    source: "gmail" as const,
  }));
  const all = [...quoInbound, ...gmailInbound].sort(
    (a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime(),
  );
  const cls = classifyReply(all.map((m) => m.body), c);
  return pass(
    "PN-10",
    `Reply classification: ${cls.route}${cls.counter_price != null ? ` (counter=$${cls.counter_price.toLocaleString()})` : ""}`,
    {
      reply_classification: cls.route,
      counter_price: cls.counter_price,
      matched_text: cls.matched_text,
      inbound_count: all.length,
      most_recent_inbound_ts: all[0]?.ts ?? null,
      most_recent_inbound_source: all[0]?.source ?? null,
    },
    "warn",
  );
};

const PN_11_counter_spread: CheckFn = (ctx, cfg) => {
  const c = cfg as typeof PRE_NEGOTIATION_CONFIG;
  // Re-run PN-10's classification (cheap; results already cached implicitly).
  const quoInbound = (ctx.quoThread ?? [])
    .filter((m) => m.direction === "incoming")
    .map((m) => m.body);
  const gmailInbound = (ctx.gmailThread ?? []).map((m) => m.body);
  const cls = classifyReply([...quoInbound, ...gmailInbound], c);
  if (cls.route !== "counter" || cls.counter_price == null) {
    return pass("PN-11", "No counter detected in latest inbound — spread check N/A", {
      reply_classification: cls.route,
    });
  }
  const investor = ctx.listing?.investorMao;
  if (investor == null) {
    return dataMissing(
      "PN-11",
      `Counter detected at $${cls.counter_price.toLocaleString()} but Investor_MAO unset on listing — can't compute spread`,
      {
        counter_price: cls.counter_price,
        missing_data_source: "airtable_listing.Investor_MAO",
        recordId: ctx.recordId,
      },
    );
  }
  const spread = investor - cls.counter_price;
  if (spread <= 0) {
    return fail(
      "PN-11",
      `Counter=$${cls.counter_price.toLocaleString()} exceeds Investor_MAO=$${investor.toLocaleString()} (spread=$${spread.toLocaleString()})`,
      { counter_price: cls.counter_price, investor_mao: investor, spread },
    );
  }
  return pass(
    "PN-11",
    `Spread at counter price=$${spread.toLocaleString()} (counter=$${cls.counter_price.toLocaleString()}, Investor_MAO=$${investor.toLocaleString()})`,
    { counter_price: cls.counter_price, investor_mao: investor, spread },
  );
};

const PN_12_pricing_agent_refresh: CheckFn = (ctx, cfg) => {
  const c = cfg as typeof PRE_NEGOTIATION_CONFIG;
  // Cascade check: if PN-07 would have flagged sqft variance, this
  // check blocks with the refresh instruction. We don't have cross-check
  // result access in the current gate-runner signature, so re-derive
  // the variance condition here.
  const listingSqft = ctx.listing?.buildingSqFt;
  const compSqfts = (ctx.cma ?? [])
    .map((cp) => cp.squareFootage)
    .filter((s): s is number => s != null && s > 0);
  if (listingSqft == null || compSqfts.length === 0) {
    return pass(
      "PN-12",
      "Sqft or CMA missing — refresh-check N/A (upstream items surface the gap)",
      { listing_sqft: listingSqft, comp_sqft_count: compSqfts.length },
    );
  }
  const cmaMedian = median(compSqfts)!;
  const variance = Math.abs(listingSqft - cmaMedian) / cmaMedian;
  if (variance > c.sqft_variance_block_pct) {
    return fail(
      "PN-12",
      `Pricing Agent must re-run with sqft=${Math.round(cmaMedian)} from CMA before proceeding. Current Listing.Building_SqFt=${listingSqft} (variance ${(variance * 100).toFixed(0)}%).`,
      {
        action_required: "rerun_pricing_agent_with_cma_sqft",
        new_sqft_to_use: Math.round(cmaMedian),
        current_sqft: listingSqft,
        variance_pct: variance,
      },
    );
  }
  return pass(
    "PN-12",
    "Inputs aligned with CMA — Pricing Agent does not need refresh on sqft grounds",
    { listing_sqft: listingSqft, cma_median_sqft: Math.round(cmaMedian), variance_pct: variance },
  );
};

const PN_13_your_mao_recomputed: CheckFn = (ctx, cfg) => {
  // Cascade: passes when PN-12 passes. We re-derive the same condition
  // here so each check is self-contained.
  const c = cfg as typeof PRE_NEGOTIATION_CONFIG;
  const listingSqft = ctx.listing?.buildingSqFt;
  const compSqfts = (ctx.cma ?? [])
    .map((cp) => cp.squareFootage)
    .filter((s): s is number => s != null && s > 0);
  if (listingSqft == null || compSqfts.length === 0) {
    return pass("PN-13", "Upstream gaps prevent meaningful recompute check", {});
  }
  const cmaMedian = median(compSqfts)!;
  const variance = Math.abs(listingSqft - cmaMedian) / cmaMedian;
  if (variance > c.sqft_variance_block_pct) {
    return fail(
      "PN-13",
      "Cascade — PN-12 blocked on sqft refresh. Your_MAO recompute pending refresh.",
      { upstream_blocker: "PN-12", waiting_on: "pricing_agent_rerun" },
    );
  }
  // Your_MAO present + computed from clean inputs (per PN-12 pass)
  const your = ctx.listing?.yourMao;
  if (your == null) {
    return dataMissing("PN-13", "Your_MAO formula returned null — likely missing Real_ARV_Median or Est_Rehab inputs", {
      missing_data_source: "airtable_listing.Your_MAO (formula)",
      recordId: ctx.recordId,
    });
  }
  return pass("PN-13", `Your_MAO=$${your.toLocaleString()} (recomputed from current inputs)`, {
    your_mao: your,
  });
};

const PN_14_your_mao_vs_counter: CheckFn = (ctx, cfg) => {
  const c = cfg as typeof PRE_NEGOTIATION_CONFIG;
  const quoInbound = (ctx.quoThread ?? [])
    .filter((m) => m.direction === "incoming")
    .map((m) => m.body);
  const gmailInbound = (ctx.gmailThread ?? []).map((m) => m.body);
  const cls = classifyReply([...quoInbound, ...gmailInbound], c);
  if (cls.route !== "counter" || cls.counter_price == null) {
    return pass("PN-14", "No counter detected — comparison N/A", {
      reply_classification: cls.route,
    });
  }
  // Block downstream of PN-12 if sqft variance would invalidate Your_MAO.
  const listingSqft = ctx.listing?.buildingSqFt;
  const compSqfts = (ctx.cma ?? [])
    .map((cp) => cp.squareFootage)
    .filter((s): s is number => s != null && s > 0);
  if (listingSqft != null && compSqfts.length > 0) {
    const cmaMedian = median(compSqfts)!;
    const variance = Math.abs(listingSqft - cmaMedian) / cmaMedian;
    if (variance > c.sqft_variance_block_pct) {
      return fail(
        "PN-14",
        `Counter detected at $${cls.counter_price.toLocaleString()} but PN-12 blocks (sqft variance ${(variance * 100).toFixed(0)}%). Refresh Pricing Agent before comparing.`,
        {
          counter_price: cls.counter_price,
          your_mao_stale: ctx.listing?.yourMao,
          upstream_blocker: "PN-12",
        },
      );
    }
  }
  const your = ctx.listing?.yourMao;
  if (your == null) {
    return dataMissing(
      "PN-14",
      `Counter detected at $${cls.counter_price.toLocaleString()} but Your_MAO unset`,
      {
        counter_price: cls.counter_price,
        missing_data_source: "airtable_listing.Your_MAO",
        recordId: ctx.recordId,
      },
    );
  }
  if (cls.counter_price > your) {
    return fail(
      "PN-14",
      `Counter=$${cls.counter_price.toLocaleString()} exceeds Your_MAO=$${your.toLocaleString()}. Accepting would be above-MAO commitment.`,
      { counter_price: cls.counter_price, your_mao: your, delta: cls.counter_price - your },
    );
  }
  return pass(
    "PN-14",
    `Counter=$${cls.counter_price.toLocaleString()} <= Your_MAO=$${your.toLocaleString()}`,
    { counter_price: cls.counter_price, your_mao: your, room: your - cls.counter_price },
  );
};

const PN_15_confidence_band: CheckFn = (ctx, cfg) => {
  const c = cfg as typeof PRE_NEGOTIATION_CONFIG;
  // ARV_Confidence currently not on the Listing type as a mapped field
  // (it's in LISTING_NAME_MAP but the property name "arvConfidence" isn't
  // on the interface). For Phase 1 read Rehab_Confidence_Score only.
  const rehabScore = ctx.listing?.rehabConfidenceScore;
  const band = compositeConfidence(null, rehabScore, c);
  return pass(
    "PN-15",
    `Composite confidence band: ${band}`,
    {
      confidence_band: band,
      rehab_confidence_score: rehabScore,
      arv_confidence: null,
      note: "Phase 1 uses Rehab_Confidence_Score only; ARV_Confidence wiring deferred",
    },
    "warn",
  );
};

const PN_16_decision_spiral: CheckFn = (ctx) => {
  return dataMissing(
    "PN-16",
    "Phase 1: decision-spiral detection requires Pricing_Last_Run history per recordId. Audit log carries pricing-agent:agent_run events but Phase 1 doesn't yet scan them for monotonic-down sequences.",
    {
      missing_data_source: "audit_log[pricing-agent:agent_run] filtered by recordId",
      recordId: ctx.recordId,
      phase: 1,
      phase_2_note: "Phase 2: detect 3+ monotonic downward Your_MAO moves on this record",
    },
  );
};

const PN_17_inspection_clause: CheckFn = (ctx, cfg) => {
  const c = cfg as typeof PRE_NEGOTIATION_CONFIG;
  const corpus = [
    ...(ctx.quoThread ?? []).map((m) => m.body),
    ...(ctx.gmailThread ?? []).map((m) => m.body),
    ctx.listing?.notes ?? "",
  ]
    .join("\n")
    .toLowerCase();
  const hit = c.inspection_waiver_phrases.find((p) => corpus.includes(p.toLowerCase()));
  if (hit) {
    return fail(
      "PN-17",
      `Inspection-waiver language detected in thread/notes: "${hit}". Inspection clause must NEVER be waived (Briefing §3 inviolable rule).`,
      { matched_phrase: hit, source: "quo_thread + gmail_thread + listing.notes" },
    );
  }
  return pass(
    "PN-17",
    "No inspection-waiver language detected",
    {
      checked_phrases: c.inspection_waiver_phrases,
      sources: ["quo_thread", "gmail_thread", "listing.notes"],
    },
  );
};

const PN_18_template_approval: CheckFn = (ctx) => {
  return dataMissing(
    "PN-18",
    "Phase 1: no template library wired. Future: match outbound draft against approved templates; nonconforming → Approval Queue.",
    {
      missing_data_source: "template_library + outbound_draft",
      recordId: ctx.recordId,
      phase: 1,
      phase_2_note: "Phase 2: route nonconforming responses to Alex approval queue per spec §8.3",
    },
  );
};

export const PRE_NEGOTIATION_CHECKS: Record<string, CheckFn> = {
  "PN-01": PN_01_quo_thread,
  "PN-02": PN_02_gmail_thread,
  "PN-03": PN_03_live_listing,
  "PN-04": PN_04_listing_active,
  "PN-05": PN_05_price_change,
  "PN-06": PN_06_cma,
  "PN-07": PN_07_sqft_matches_cma,
  "PN-07a": PN_07a_photo_condition,
  "PN-08": PN_08_ownership,
  "PN-09": PN_09_liens,
  "PN-10": PN_10_classify_reply,
  "PN-11": PN_11_counter_spread,
  "PN-12": PN_12_pricing_agent_refresh,
  "PN-13": PN_13_your_mao_recomputed,
  "PN-14": PN_14_your_mao_vs_counter,
  "PN-15": PN_15_confidence_band,
  "PN-16": PN_16_decision_spiral,
  "PN-17": PN_17_inspection_clause,
  "PN-18": PN_18_template_approval,
};

// Silence unused-import warnings until Phase 2 wires collectPhotos in
// for PN-07a vision parse.
void collectPhotos;
