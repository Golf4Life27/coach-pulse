export interface Listing {
  id: string;
  address: string;
  city: string;
  zip: string;
  listPrice: number | null;
  mao: number | null;
  dom: number | null;
  offerTier: string | null;
  liveStatus: string | null;
  executionPath: string | null;
  outreachStatus: string | null;
  lastOutreachDate: string | null;
  agentName: string | null;
  agentPhone: string | null;
  agentEmail: string | null;
  verificationUrl: string | null;
  notes: string | null;
  distressScore: number | null;
  distressBucket: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  buildingSqFt: number | null;
  stageCalc: string | null;
  approvedForOutreach: boolean;
  flipScore: number | null;
  offMarketOverride: boolean;
  restrictionText: string | null;
  ddChecklist: string[] | null;
  doNotText: boolean;
  state: string | null;
  actionHoldUntil: string | null;
  actionCardState: "Open" | "Held" | "Cleared" | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  // ── Pre-Outreach Gate inputs (added 5/13 for orchestrator Gate 1)
  mlsStatus?: string | null;
  propertyType?: string | null;
  priceDropCount?: number | null;
  lastVerified?: string | null;
  pipelineStage?: string | null;
  // Phase 3 — photo analysis
  estRehabLow?: number | null;
  estRehabMid?: number | null;
  estRehabHigh?: number | null;
  photoConfidence?: number | null;
  lineItemsJson?: string | null;
  redFlags?: string[] | string | null;
  photoAnalyzedAt?: string | null;
  visualVerified?: boolean;
  visualSource?: string | null;
  // Phase 3 — ARV validation
  realArvLow?: number | null;
  realArvHigh?: number | null;
  realArvMedian?: number | null;
  investorMao?: number | null;
  yourMao?: number | null;
  autoApproveV2?: boolean;
  arvValidatedAt?: string | null;
  // Phase 3 — pre-offer screen
  preOfferScreenResult?: "Pass" | "Block" | "Warn" | null;
  preOfferScreenNotes?: string | null;
  preOfferScreenAt?: string | null;
  // Phase 3 — DD volley
  ddVolleyText1SentAt?: string | null;
  ddVolleyText2SentAt?: string | null;
  ddVolleyText3SentAt?: string | null;
}

export interface Deal {
  id: string;
  propertyAddress: string;
  city: string;
  state: string | null;
  contractPrice: number | null;
  offerPrice: number | null;
  assignmentFee: number | null;
  estimatedRepairs: number | null;
  arv: number | null;
  status: string | null;
  closingStatus: string | null;
  dispoReady: boolean;
  propertyImageUrl: string | null;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  buyerBlastStatus: "Pending" | "Sent" | "Closed" | null;
  actionCardState: "Open" | "Held" | "Cleared" | null;
  actionHoldUntil: string | null;
}

export interface Buyer {
  id: string;
  buyerName: string;
  buyerEmail: string | null;
  buyerStatus: string | null;
  preferredCities: string | null;
  cashBuyer: boolean;
  proofOfFundsOnFile: boolean;
  buyerActiveFlag: boolean;
}

export interface DashboardStats {
  negotiating: number;
  responseReceived: number;
  textedEmailed: number;
  dead: number;
  totalRecords: number;
  verifiedActive: number;
  autoProceed: number;
  manualReview: number;
  rejected: number;
}

// Morning-briefing summary served by /api/briefing. Numbers are computed from
// already-cached listings + deals; some fields ride on data we don't yet have
// a clean source for and are returned as zero/null with a reason in `gaps`.
export interface Briefing {
  pendingResponses: number;
  activeNegotiations: number;
  staleNegotiations: number;
  dealDeadlines7d: number;
  textsToday: number;
  responseRateToday: number | null;
  makeErrors24h: number;
  gaps: BriefingGap[];
}

export type BriefingGap =
  | "dealDeadlines7d"
  | "responseRateToday"
  | "makeErrors24h"
  | "pendingResponsesSinceLogin";

export interface ProspectiveBuyer {
  id: string;
  fullName: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  propertyPurchased: string | null;
  city: string | null;
  zip: string | null;
  source: string | null;
  outreachStatus: string | null;
  lastContacted: string | null;
  notes: string | null;
}
