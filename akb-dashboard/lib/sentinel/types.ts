// Phase 13 — Sentinel inbound-classification types.
//
// These types are the canonical shape for Sentinel's inbound-reply
// classifier output. Richer than the L3 4-bucket regex in
// /api/scan-replies — Sentinel adds LLM-based intent detection,
// confidence scoring, red-flag signals, and a motivation-score hint
// that feeds Seller_Motivation_Score (Phase 20.2 / v1.3 field added but
// not yet auto-populated).

/** Phase 13 intent taxonomy. Richer than L3's
 *  rejection/interest/counter/unknown — splits "interest" into
 *  motivated vs lukewarm, isolates questions (POF, terms) from
 *  generic interest, and adds wire-fraud / off-topic / spam buckets
 *  the regex layer doesn't catch. */
export type SentinelIntent =
  | "motivated"
  | "lukewarm"
  | "rejection"
  | "question"
  | "wire_fraud_red_flag"
  | "off_topic"
  | "spam";

/** Specific red-flag categories Sentinel watches for. Wire-fraud
 *  patterns are the canonical concern but each pattern is listed
 *  individually so Pulse can baseline frequency per flag. */
export type SentinelRedFlag =
  | "phishing_link"
  | "request_wire_transfer"
  | "impersonation"
  | "request_routing_number"
  | "fake_urgency"
  | "deceptive_identity"
  | "off_platform_redirect";

export interface SentinelClassification {
  intent: SentinelIntent;
  /** 0-1 inclusive. LLM-reported confidence in the intent assignment.
   *  Coerced/clamped on read — never trust the model to stay in
   *  range. */
  confidence: number;
  /** 1-2 sentence rationale. Surfaced in the Sentinel room UI so the
   *  operator can audit the classification without re-reading the
   *  source reply. */
  reasoning: string;
  /** Red flags surfaced by the model. Empty array when none — never
   *  null, simplifies UI consumers. */
  red_flags: SentinelRedFlag[];
  /** Seller motivation hint on the v1.3 1-5 scale. Populated only for
   *  intent in {"motivated", "lukewarm"} — other intents return null.
   *  Phase 13 ships this as a HINT (operator-reviewed before it
   *  writes Seller_Motivation_Score); the wire-up to the Airtable
   *  field lands in N.2. */
  motivation_score_hint: number | null;
  /** Model identifier used for the classification. Locked here so
   *  downstream Pulse can detect drift when the model version
   *  changes. */
  model: string;
  /** ISO timestamp of when the classification ran. */
  classified_at: string;
}

/** The minimal input shape the classifier needs. Address + agent name
 *  + recent timeline give the LLM enough context to disambiguate
 *  (e.g., "yes" alone is ambiguous — "yes, we can do $90K" with
 *  prior thread context is motivated). */
export interface SentinelClassifierInput {
  /** The raw inbound body — never pre-processed. The classifier sees
   *  exactly what the agent sent. */
  body: string;
  /** Property + agent context. Address + list price give the LLM
   *  anchor for "is the reply mentioning a price relative to list?". */
  listing: {
    address: string;
    list_price: number | null;
    state: string | null;
  };
  agent: {
    name: string | null;
  };
  /** Last N timeline entries before this inbound. Lets the LLM
   *  determine whether "yes" / "send it" is a follow-up vs a fresh
   *  hot lead. Pass as already-rendered text snippets so the
   *  classifier prompt stays tight. */
  recent_timeline_snippets?: string[];
}
