// V2 surface — response types for the EXISTING read routes this surface
// consumes. V2 is read-only against the spine: these mirror what the live
// routes return today; they do not define new backend contracts.

// ── /api/queue (lib/actionQueue.ts shapes) ─────────────────────────────
export type CardKind = "deal" | "response" | "dd" | "stale";

export interface QueueCard {
  id: string;
  kind: CardKind;
  recordId: string;
  table: "listings" | "deals";
  cardState: "Open" | "Held" | "Cleared";
  holdUntil: string | null;
  address: string;
  city: string | null;
  state: string | null;
  // response / stale / dd
  agentName?: string | null;
  agentPhone?: string | null;
  listPrice?: number | null;
  mao?: number | null;
  dom?: number | null;
  inboundMessage?: string | null;
  outboundMessage?: string | null;
  lastOutreachDate?: string | null;
  daysSilent?: number;
  missingItems?: string[];
  // deal
  contractPrice?: number | null;
  assignmentPrice?: number | null;
  spread?: number | null;
  closingStatus?: string | null;
  status?: string | null;
}

export interface QueueResponse {
  open: QueueCard[];
  held: QueueCard[];
}

// ── /api/operator-actions ──────────────────────────────────────────────
export interface OperatorItem {
  id: string;
  title: string;
  sourceRecordId: string | null;
  actionRequired: string | null;
  context: string | null;
  verbatimReply: string | null;
  status: string;
  priority: string;
  createdAt: string | null;
}

// ── /api/briefing ──────────────────────────────────────────────────────
export interface Briefing {
  pendingResponses: number;
  activeNegotiations: number;
  staleNegotiations: number;
  dealDeadlines7d: number;
  textsToday: number;
  responseRateToday: number | null;
  makeErrors24h: number;
  gaps: string[];
}

// ── /api/admin/audit-tail (lib/audit-log.ts AuditEntry) ────────────────
export interface AuditEntry {
  ts: string;
  agent: string;
  event: string;
  status: "confirmed_success" | "confirmed_failure" | "uncertain";
  recordId?: string;
  externalId?: string;
  inputSummary?: Record<string, unknown>;
  outputSummary?: Record<string, unknown>;
  decision?: string;
  ms?: number;
  error?: string;
}

export interface AuditTailResponse {
  ok: boolean;
  scanned: number;
  kv_oldest_ts: string | null;
  kv_newest_ts: string | null;
  matched_count: number;
  entries: AuditEntry[];
}

// ── /api/listings/[id] (lib/types.ts Listing — fields v2 reads) ────────
export interface ListingDetail {
  id: string;
  address: string;
  city: string;
  zip: string;
  state: string | null;
  listPrice: number | null;
  mao: number | null;
  dom: number | null;
  outreachStatus: string | null;
  pipelineStage?: string | null;
  lastOutreachDate: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  agentName: string | null;
  agentPhone: string | null;
  agentEmail: string | null;
  verificationUrl: string | null;
  ddChecklist: string[] | null;
  doNotText: boolean;
  outreachOfferPrice?: number | null;
  contractOfferPrice?: number | null;
  underwrittenMao?: number | null;
  /** landlord | flipper — the PERSISTED operative underwrite track
   *  (Underwritten_MAO_Track, ops bb03a6d). Display ceilings track-labeled,
   *  matching ops's Offer Readiness panel. */
  underwrittenMaoTrack?: string | null;
  investorMao?: number | null;
  yourMao?: number | null;
  estRehab?: number | null;
  estRehabLow?: number | null;
  estRehabHigh?: number | null;
  rehabSource?: string | null;
  rehabEstimatedAt?: string | null;
  rehabConfidenceScore?: number | null;
  realArvLow?: number | null;
  realArvMedian?: number | null;
  realArvHigh?: number | null;
  arvConfidence?: "HIGH" | "MED" | "LOW" | null;
  arvCompCount?: number | null;
  arvValidatedAt?: string | null;
  estimatedMonthlyRent?: number | null;
  followUpCount?: number | null;
  sellerMotivationScore?: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  buildingSqFt: number | null;
  yearBuilt: number | null;
  distressBucket: string | null;
}

// ── /api/deal-dossier/[id] ─────────────────────────────────────────────
export interface DossierResponse {
  found: boolean;
  dossierRecordId?: string;
  dealNumber?: number | null;
  verdict?: string | null;
  pessimisticMao?: number | null;
  stickyFloor?: number | null;
  marginOverFloor?: number | null;
  awaiting?: string | null;
  createdAt?: string | null;
  hasOperatorCma?: boolean;
  markdown?: string | null;
}

// ── /api/conversations/[id] ────────────────────────────────────────────
export interface UnifiedMessage {
  id: string;
  source: "quo" | "email" | "notes";
  direction: "inbound" | "outbound" | "system";
  body: string;
  timestamp: string;
  from: string;
  to: string;
  subject?: string;
}

export interface ConversationResponse {
  recordId: string;
  address: string;
  agentName: string | null;
  agentPhone: string | null;
  messageCount: number;
  quoCount: number;
  emailCount: number;
  notesCount: number;
  messages: UnifiedMessage[];
}

// ── /api/maverick/recall ───────────────────────────────────────────────
export interface RecallResult {
  source: "spine" | "audit" | "listings" | "deals";
  record_id: string;
  summary: string;
  full_data: Record<string, unknown>;
}

export interface RecallResponse {
  results: RecallResult[];
  truncated_to_n: number;
  searched_sources: string[];
}
