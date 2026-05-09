export type CardType =
  | "NEGOTIATION_RESPONSE_DUE"
  | "OFFER_ACCEPTED_PA_NEEDED"
  | "STALE_REENGAGEMENT"
  | "AMBIGUOUS_NEEDS_REVIEW"
  | "UNANSWERED_INBOUND_BLOCKING"
  ;

export type ActionType =
  | "send_reply"
  | "mark_dead"
  | "walk"
  | "clarify"
  | "accept"
  | "counter"
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
};

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
