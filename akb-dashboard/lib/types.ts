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
  yearBuilt: number | null;
  /** Portfolio / investor-seller language detected at intake (operator
   *  2026-06-08). Down-rank signal — H2 cadence deprioritizes within
   *  the eligible band; never a veto. Forward-only intake flag. */
  portfolioDetected: boolean;
  stageCalc: string | null;
  approvedForOutreach: boolean;
  flipScore: number | null;
  offMarketOverride: boolean;
  restrictionText: string | null;
  ddChecklist: string[] | null;
  doNotText: boolean;
  state: string | null;
  /** v1_legacy | v2_post_2026-05-26 | null (INV-LEGACY-BACKSTOP). */
  sourceVersion: string | null;
  actionHoldUntil: string | null;
  actionCardState: "Open" | "Held" | "Cleared" | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  // Phase 11.2 — email outbound timestamp. Crier staleness uses max()
  // of all four contact timestamps to avoid false-stale on active email
  // negotiations (the 23 Fields scenario). Null until first attributable
  // gmail send. Written by lib/gmail.ts sendEmail when recordId is in
  // scope; manual mailto: sends from outside the app cannot populate this
  // (see Checklist 11.2 gap notes).
  lastEmailOutreachDate: string | null;
  // Phase 5.4 — DocuSign envelope attribution. Null until Alex clicks
  // "Track in Scribe" on the deal-detail page. Drives the per-deal
  // ScribeDealCommentary lookup against external_signals.docusign.envelopes.
  envelopeId: string | null;
  // ── Pre-Outreach Gate inputs (added 5/13 for orchestrator Gate 1)
  mlsStatus?: string | null;
  propertyType?: string | null;
  priceDropCount?: number | null;
  lastVerified?: string | null;
  pipelineStage?: string | null;
  // Prev_List_Price drives list-drift detection in D3 math filter — if
  // current List_Price has fallen substantially since the Texted record
  // was created, the math we ran at that time is stale.
  prevListPrice?: number | null;
  // Follow_Up_Count — number of follow-up texts already sent on this
  // record. Drives D3 cadence position (0 = none yet, 1 = day-3 sent,
  // 2 = day-7 sent, 3 = day-14 sent).
  followUpCount?: number | null;
  // D3 cadence — fields captured at H2 outreach time (or backfilled on
  // existing records 5/13 via proxy).
  //   lastStatusCheckSentAt: dateTime of most recent status_check probe.
  //     Drives 3-day timeout-to-dead window.
  //   outreachOfferPrice: sticky 65%-of-List offer captured at outreach
  //     time. Renamed 5/18 from storedOfferPrice per Phase 20.2 v1.3
  //     amendment (two-field model — see contractOfferPrice below).
  //     Never recomputed; never overwritten after first set.
  //   contractOfferPrice: set at negotiation / DD stage. CAN BE ABOVE
  //     OR BELOW outreachOfferPrice — DD reveals whether to drop (worse
  //     rehab than expected) or push (clean deal, motivated seller).
  //     Hard floor: V2.1 math (Investor_MAO − Wholesale_Fee). Soft
  //     ceiling: none, but >75% of List triggers a Maverick caution
  //     flag on the deal-detail page. Sticky during negotiation.
  //   sellerMotivationScore: 1-5 coarse motivation rubric per the v1.3
  //     amendment. Manually populated for now; Sentinel automates in
  //     Phase 13. Drives the seller-motivation modifier on the Unified
  //     Deal Math range endpoint (Phase 4 v1.3 amendment).
  //   listPriceAtSend: snapshot of List_Price at outreach time. Used
  //     by cadence drift-detection (±10% threshold).
  lastStatusCheckSentAt?: string | null;
  outreachOfferPrice?: number | null;
  contractOfferPrice?: number | null;
  sellerMotivationScore?: number | null;
  listPriceAtSend?: number | null;
  // ── Pre-Send Gate inputs (added 5/13 for orchestrator Gate 2)
  rehabConfidenceScore?: number | null;
  agentPriorOutreachCount?: number | null;
  // ── Pre-Negotiation Gate inputs (added 5/13 for orchestrator Gate 3)
  // Est_Rehab (fldmup8SvMky9eyag) — referenced by Investor_MAO formula.
  // PN-13/PN-14 read this directly to verify pricing math has clean
  // inputs (not just relying on the formula output).
  estRehab?: number | null;
  // Phase 3 — photo analysis
  estRehabLow?: number | null;
  estRehabMid?: number | null;
  estRehabHigh?: number | null;
  // Phase 4B.1 — Appraiser rehab endpoint writes these alongside
  // estRehab/estRehabMid. Existing pricing-route 4B leg only wrote
  // estRehabLow/Mid/High + rehabConfidenceScore + redFlags; the new
  // /api/agents/appraiser/rehab/[recordId] adds the timestamp + the
  // structured BBC-calibration JSON (bbc_tier + market_tier + anchor
  // + multiplier + vision line items).
  rehabEstimatedAt?: string | null;
  rehabLineItemsJson?: string | null;
  rehabRedFlags?: string | null;
  // INV-005 — Rehab_Source provenance flag. Distinct from the BroCard
  // pricing classifier's "rehab_source" (phase_4b_calibrated | legacy_
  // est_rehab | none — calibration epoch). This field records whether
  // the persisted Est_Rehab came from the autonomous vision pipeline
  // or from the operator/partner fallback unlocked after vision failed.
  rehabSource?: "vision" | "manual_operator" | "manual_partner" | null;
  // INV-029 — Pre-EMD Gate operator-verify flags. Memphis_Assignment_Verified:
  // operator confirmed non-assignment language absent (required when State=TN).
  // EMD_Operator_Signoff: final "Alex looked at this" gate before EMD wire.
  memphisAssignmentVerified?: boolean;
  emdOperatorSignoff?: boolean;
  photoConfidence?: number | null;
  lineItemsJson?: string | null;
  redFlags?: string[] | string | null;
  photoAnalyzedAt?: string | null;
  visualVerified?: boolean;
  visualSource?: string | null;
  // Phase 4C.1 — RentCast AVM rent estimate (monthly USD). Drives
  // the landlord-track MAO: (rent × 12) / cap_rate − rehab −
  // wholesale_fee. Written by /api/agents/appraiser/buyer-intelligence/
  // [recordId]. Null until first dual-track run pulls RentCast rent.
  estimatedMonthlyRent?: number | null;
  // Phase 3 — ARV validation
  realArvLow?: number | null;
  realArvHigh?: number | null;
  realArvMedian?: number | null;
  // Phase 4A.1 — Appraiser ARV endpoint writes these alongside Real_ARV_*
  // (the existing Pricing Agent leaves them unwritten today; the new
  // standalone /api/agents/appraiser/arv/[recordId] route fills them
  // per the Crawler Roadmap spec).
  arvConfidence?: "HIGH" | "MED" | "LOW" | null;
  arvCompCount?: number | null;
  arvCompAvgPrSqFt?: number | null;
  arvCompDetailsJson?: string | null;
  // Phase 4A.1 — read for the V2.1 MAO floor calc:
  //   floor = MAX(realArvMedian - estRehab - wholesaleFeeTarget, 0)
  // Defaults: wholesaleFeeTarget 15000, buyerProfitTarget 30000 (Bible v3).
  wholesaleFeeTarget?: number | null;
  buyerProfitTarget?: number | null;
  investorMao?: number | null;
  yourMao?: number | null;
  // Confirmed-override taxes (2026-06-06). Operator/CAD-sourced; survives
  // V2.1 cron re-runs (anti-regression). See lib/landlord-hydrate.ts
  // resolveAnnualTaxes for precedence.
  confirmedTaxes?: number | null;
  confirmedTaxesSource?: string | null;
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
  /** Date the assignment was executed (deal realized). INV-026 velocity. */
  assignmentExecutedAt: string | null;
  /** Scheduled closing date — velocity fallback when no assignment date. */
  closingScheduledDate: string | null;
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
