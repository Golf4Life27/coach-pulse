export type CardType =
  | "NEGOTIATION_RESPONSE_DUE"
  | "OFFER_ACCEPTED_PA_NEEDED"
  | "STALE_REENGAGEMENT"
  | "AMBIGUOUS_NEEDS_REVIEW"
  | "UNANSWERED_INBOUND_BLOCKING"
  | "PRE_OFFER_BLOCKED"
  | "DD_BLOCKER"
  | "DD_VOLLEY_TEXT_1_DUE"
  | "DD_VOLLEY_TEXT_2_DUE"
  | "DD_VOLLEY_TEXT_3_DUE"
  | "DD_VOLLEY_COMPLETE"
  | "BUYER_MATCH_READY"
  | "BUYER_WARMUP_DUE"
  | "BUYER_FORM_COMPLETED"
  | "BUYER_BLAST_RECOMMENDED"
  | "PA_DRAFTING_AWAITING_RESPONSE"
  | "COST_CLARIFICATION_PENDING"
  | "POST_ACCEPTANCE_DD_DUE"
  | "AWAITING_BUYER_PIPELINE"
  | "RESURRECTION_OPPORTUNITY"
  ;

export type ActionType =
  | "send_reply"
  | "mark_dead"
  | "walk"
  | "clarify"
  | "accept"
  | "counter"
  | "send_dd_volley_1"
  | "send_dd_volley_2"
  | "send_dd_volley_3"
  | "fire_buyer_blast"
  | "run_pre_offer_screen"
  | "review_buyer_form"
  ;

export type Channel = "sms" | "email" | "none";
export type TimelineChannel = "sms" | "email" | "note" | "system";
export type Direction = "in" | "out";

export interface TimelineEntry {
  timestamp: string;
  channel: TimelineChannel;
  direction: Direction;
  body: string;
  subject?: string;
  sender: string;
  propertyMatch: {
    recordId: string;
    confidence: number;
  };
  raw?: unknown;
  metadata?: Record<string, unknown>;
}

export interface ActionOption {
  label: string;
  channel: Channel;
  action_type: ActionType;
  draft?: string;
  subject?: string;
}

export interface BroCard {
  rank: number;
  recordId: string;
  card_type: CardType;
  address: string;
  agent: string;
  headline: string;
  summary: string;
  why_this_matters: string;
  score: number;
  options: ActionOption[];
  recommendation_index: number;
  agentContext?: AgentContext;
  dealStage?: DealStage;
  metadata: Record<string, unknown>;
}

export interface DealContext {
  recordId: string;
  agent: { name: string | null; phone: string | null; email: string | null };
  property: { address: string; city: string | null; state: string | null; listPrice: number | null };
  timeline: TimelineEntry[];
  ambiguousMessages: TimelineEntry[];
  lastInbound: string | null;
  lastOutbound: string | null;
  hoursSinceInbound: number | null;
  hoursSinceOutbound: number | null;
  responseDue: boolean;
  multiListingAlert: boolean;
  siblingRecords?: { recordId: string; address: string }[];
  dealStage?: DealStage;
  dealStageSignals?: {
    paDrafting: boolean;
    costClarificationPending: boolean;
    inspectionStarted: boolean;
  };
  metadata: Record<string, unknown>;
}

export interface JarvisBrief {
  broCards: BroCard[];
  ambiguousQueue: { recordId: string; address: string; ambiguousMessages: TimelineEntry[] }[];
  metadata: { generated_at: string; model: string; total_active_deals: number };
}

export interface DealActionRequest {
  channel: Channel;
  body: string;
  subject?: string;
  replyToMessageId?: string;
  action_type: ActionType;
}

export interface DealActionResponse {
  success: boolean;
  draftId?: string;
  draftUrl?: string;
  messageId?: string;
  airtableUpdated: boolean;
  newStatus?: string;
}

export const CARD_TYPE_CONFIG: Record<CardType, { icon: string; urgency: "critical" | "high" | "medium" | "low"; color: string }> = {
  NEGOTIATION_RESPONSE_DUE: { icon: "message", urgency: "high", color: "red" },
  OFFER_ACCEPTED_PA_NEEDED: { icon: "file-text", urgency: "critical", color: "red" },
  STALE_REENGAGEMENT: { icon: "clock", urgency: "medium", color: "amber" },
  AMBIGUOUS_NEEDS_REVIEW: { icon: "alert-triangle", urgency: "medium", color: "amber" },
  UNANSWERED_INBOUND_BLOCKING: { icon: "alert-octagon", urgency: "critical", color: "red" },
  PRE_OFFER_BLOCKED: { icon: "shield-x", urgency: "critical", color: "red" },
  DD_BLOCKER: { icon: "list-checks", urgency: "high", color: "red" },
  DD_VOLLEY_TEXT_1_DUE: { icon: "message-square", urgency: "high", color: "amber" },
  DD_VOLLEY_TEXT_2_DUE: { icon: "message-square", urgency: "high", color: "amber" },
  DD_VOLLEY_TEXT_3_DUE: { icon: "message-square", urgency: "high", color: "amber" },
  DD_VOLLEY_COMPLETE: { icon: "check-square", urgency: "low", color: "emerald" },
  BUYER_MATCH_READY: { icon: "users", urgency: "high", color: "blue" },
  BUYER_WARMUP_DUE: { icon: "thermometer", urgency: "medium", color: "amber" },
  BUYER_FORM_COMPLETED: { icon: "user-plus", urgency: "high", color: "blue" },
  BUYER_BLAST_RECOMMENDED: { icon: "send", urgency: "critical", color: "red" },
  PA_DRAFTING_AWAITING_RESPONSE: { icon: "file-pen", urgency: "critical", color: "red" },
  COST_CLARIFICATION_PENDING: { icon: "calculator", urgency: "high", color: "red" },
  POST_ACCEPTANCE_DD_DUE: { icon: "list-checks", urgency: "high", color: "amber" },
  AWAITING_BUYER_PIPELINE: { icon: "users", urgency: "high", color: "blue" },
  RESURRECTION_OPPORTUNITY: { icon: "rotate-ccw", urgency: "critical", color: "red" },
};

export type DealStage =
  | "cold"
  | "outreach"
  | "engaged"
  | "negotiating"
  | "accepted_pending_pa"
  | "pa_signed"
  | "inspection"
  | "closing"
  | "dead"
  | "won";

export type DepthScore = 0 | 1 | 2 | 3;
export type InferredTone = "formal" | "casual" | "friendly" | "transactional";

export interface AgentContextProperty {
  recordId: string;
  address: string;
  status: string;
}

export interface AgentContextUnanswered {
  recordId: string;
  address: string;
  lastInboundAt: string;
}

export interface AgentContext {
  identifier: string;
  agentName: string;
  totalListings: number;
  totalOutreaches: number;
  totalReplies: number;
  lastInteractionAt: string | null;
  daysSinceLastInteraction: number | null;
  activeProperties: AgentContextProperty[];
  propertiesWithUnansweredInbound: AgentContextUnanswered[];
  depthScore: DepthScore;
  inferredTone: InferredTone;
  // Set when the agent's inbound messages indicate they're a principal
  // (seller, owner, or family-stake holder) rather than a pure listing
  // agent. Affects negotiation strategy + drafting tone.
  isPrincipal?: boolean;
  // The text snippet that triggered the principal detection — included
  // for transparency/debugging.
  principalSignal?: string;
  metadata?: Record<string, unknown>;
}

export type SafetyCheckReason =
  | "cooldown"
  | "reintroduction_detected"
  | "unanswered_inbound"
  | "tone_mismatch";

export interface SafetyCheckResult {
  passed: boolean;
  reason?: SafetyCheckReason;
  warnings: string[];
  agentContext: AgentContext;
  suggestedDraft?: string;
}

export const URGENCY_LABEL: Record<string, string> = {
  critical: "ACT NOW",
  high: "ACT NOW",
  medium: "HEADS UP",
  low: "FYI",
};

// ── Phase 3: photo / ARV / pre-offer / DD ──────────────────────────────────

export type PropertyCondition = "Good" | "Fair" | "Average" | "Poor" | "Disrepair";

export type PhotoConfidence = "HIGH" | "MED" | "LOW";

export type PhotoLineItemCategory =
  | "roof" | "exterior" | "interior" | "kitchen" | "bathroom"
  | "hvac" | "electrical" | "plumbing" | "foundation" | "other";

export interface PhotoLineItem {
  category: PhotoLineItemCategory;
  estimate_low: number;
  estimate_high: number;
  confidence: PhotoConfidence;
  notes: string;
}

export type PhotoRedFlag =
  | "fire_damage_visible"
  | "structural_compromise"
  | "no_roof_visible"
  | "demolition_required"
  | "foundation_settling"
  | "water_damage"
  | "broken_windows"
  | "signs_of_squatting"
  | "overgrown_lot"
  | "utilities_disconnected"
  | "debris_present";

export interface PhotoAnalysisResult {
  recordId: string;
  condition_overall: PropertyCondition;
  rehab_estimate_low: number;
  rehab_estimate_mid: number;
  rehab_estimate_high: number;
  confidence: number;
  line_items: PhotoLineItem[];
  red_flags: PhotoRedFlag[];
  photo_count: number;
  photo_sources: Array<"listing" | "streetview">;
  market_multiplier: number;
  analyzed_at: string;
}

export interface ArvValidationResult {
  recordId: string;
  arv_low: number | null;
  arv_high: number | null;
  arv_median: number | null;
  comp_count: number;
  as_is_value: number | null;
  investor_mao: number | null;
  your_mao: number | null;
  your_mao_pct: number | null;
  spread_label: "positive" | "tight" | "negative";
  auto_approve_v2: boolean;
  validated_at: string;
}

export type PreOfferCheckSeverity = "BLOCK" | "WARN" | "PASS";

export interface PreOfferCheck {
  check: string;
  severity: PreOfferCheckSeverity;
  reason: string;
  suggestedAction?: string;
}

export interface PreOfferScreenResult {
  recordId: string;
  proposedOfferAmount: number | null;
  passed: boolean;
  blockers: PreOfferCheck[];
  warnings: PreOfferCheck[];
  checks: PreOfferCheck[];
  screened_at: string;
}

export const DD_V3_ITEMS = [
  "Vacancy/Occupancy Status",
  "Utility Status Known",
  "Roof Age Asked",
  "HVAC Age Asked",
  "Water Heater Age Asked",
  "Electrical Age Asked",
  "Plumbing Age Asked",
  "Foundation Issues Disclosed",
  "Active Leaks Disclosed",
  "Sewer Issues Disclosed",
  "Environmental Hazards Disclosed",
  "Permits/Violations Disclosed",
] as const;

export type DDItem = typeof DD_V3_ITEMS[number];

export interface DDStatus {
  recordId: string;
  outreachStatus: string | null;
  // Effective complete count: count of UNIQUE items covered by formal
  // checklist + informal timeline answers (capped at ddTotal).
  ddCompleteCount: number;
  ddTotal: number;
  ddCheckedItems: DDItem[];
  ddMissingItems: DDItem[];
  // Items checked via the formal DD_Checklist multi-select on the record.
  ddFormalAnsweredItems: DDItem[];
  // Items the parser detected in inbound timeline messages, even if the
  // formal checklist hasn't been ticked.
  ddInformalAnsweredItems: DDItem[];
  // Per-item evidence for informal answers (snippet + timestamp).
  ddInformalEvidence?: Partial<Record<DDItem, { snippet: string; timestamp: string }>>;
  canCounter: boolean;
  canSignPA: boolean;
  volleyState: {
    text1SentAt: string | null;
    text2SentAt: string | null;
    text3SentAt: string | null;
  };
  recommendedActions: Array<{
    action:
      | "send_volley_text_1"
      | "send_volley_text_2"
      | "send_volley_text_3"
      | "mark_complete"
      | "override";
    label: string;
    suggestedDraft?: string;
  }>;
}

// ── Phase 2: buyers ─────────────────────────────────────────────────────────

export type BuyerType = "flipper" | "landlord" | "wholesaler" | "owner-occupant" | "unknown";
export type BuyerStatus = "Cold" | "Warmed" | "Form Completed" | "Active Match" | "Closed Deal" | "Dead";
export type BuyerVolumeTier = "A" | "B" | "C";
export type BuyerSource = "InvestorBase" | "Networking" | "Inbound Form" | "Referral";

export interface BuyerRecord {
  id: string;
  name: string;
  entity: string | null;
  email: string | null;
  phonePrimary: string | null;
  phoneSecondary: string | null;
  buyerType: BuyerType | null;
  propertyTypePreference: string[] | null;
  markets: string[] | null;
  targetZips: string | null;
  minPrice: number | null;
  maxPrice: number | null;
  minBeds: number | null;
  lastPurchaseDate: string | null;
  lastPurchasePrice: number | null;
  lastPurchaseAddress: string | null;
  linkedDealCount: number | null;
  buyerVolumeTier: BuyerVolumeTier | null;
  source: BuyerSource | null;
  status: BuyerStatus | null;
  warmthScore: number | null;
  emailSentAt: string | null;
  emailOpenedAt: string | null;
  formCompletedAt: string | null;
  lastEngagementAt: string | null;
  notes: string | null;
}

export interface BuyerMatch {
  buyer: BuyerRecord;
  score: number;
  reasoning: string[];
}

export interface BuyerMatchResult {
  recordId: string;
  matches: BuyerMatch[];
  generated_at: string;
}

export interface BuyerDraft {
  buyerId: string;
  buyerName: string;
  buyerEmail: string | null;
  buyerPhone: string | null;
  channel: "email" | "sms";
  subject?: string;
  body: string;
}

export interface BuyerBlastResult {
  recordId: string;
  sent: number;
  failed: number;
  results: Array<{
    buyerId: string;
    success: boolean;
    error?: string;
    draftUrl?: string;
  }>;
}
