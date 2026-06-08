// INV-026 — Wife-Retirement Progress Meter: the pipeline-stage registry.
//
// This is the single source of truth the meter reads (for the Lost-Phone-
// Test failure count + build-completion) AND the roadmap is generated
// from. Every stage carries BOTH its current state (automation, risk,
// completion) and its path to 100% (nextActions + blockers). That makes
// drift between "what the meter says" and "what we plan to do about it"
// structurally impossible — they read the same array.
//
// Update discipline: when a stage advances (a blocker clears, an action
// ships), edit THIS file. The meter recomputes; the roadmap doc is
// regenerated from it. Material movement (a HIGH→MEDIUM drop, a
// completion jump) becomes an INV-026 Type 2C card per the brief.
//
// "Lost-Phone-Test" = if the operator vanishes for 7 days, does this
// stage STALL (deals pile up, can't advance)? That is the load-bearing
// risk — operator-required vs operator-optional — NOT raw % complete.

export type AutomationStatus = "automated" | "partial" | "manual" | "unbuilt";
export type LostPhoneRisk = "HIGH" | "MEDIUM" | "LOW" | "EXPECTED_MANUAL";

export interface StageBlocker {
  /** INV / work-item reference, or "—" for none. */
  ref: string;
  text: string;
}

export interface PipelineStage {
  id: string;
  /** Station number in the find→verify→price→offer→negotiate→contract→dispo flow. */
  station: number;
  name: string;
  automationStatus: AutomationStatus;
  lostPhoneRisk: LostPhoneRisk;
  /** Does this stage stall if the operator is gone 7 days? */
  stallsWithoutOperator: boolean;
  /** Rough build-completion of THIS stage's V1 scope (0-100). */
  completionPct: number;
  /** What specifically stalls / what state it's in today. */
  stateToday: string;
  blockers: StageBlocker[];
  /** Ordered, concrete steps that take this stage to 100%. */
  pathTo100: string[];
}

// Current registry — honest state as of 2026-06-08 (post enrich +
// off-market-veto ship; post 346-Modder end-to-end audit). Risk levels
// use the strict "stalls if operator gone 7d" test.
export const PIPELINE_STAGES: PipelineStage[] = [
  {
    id: "intake",
    station: 1,
    name: "Intake / Crawler",
    automationStatus: "partial",
    lostPhoneRisk: "LOW",
    stallsWithoutOperator: false,
    completionPct: 70,
    stateToday:
      "listings-intake cron pulls RentCast active band-listings autonomously for configured ZIPs; ATTOM backbone wired. Does NOT stall without operator. Missing: the 44-state route-planned crawler (autonomous geographic expansion).",
    blockers: [{ ref: "INV-025", text: "Crawler Engine — route planning + cadence + per-ZIP eligibility not built" }],
    pathTo100: [
      "Author INV-025 brief (D1-D4 cadence/granularity/vendor/explore-exploit decisions)",
      "Ship ZIP_Registry-driven route planner consuming ZIP_Daily_Stats density",
      "Add explore/exploit budget split + per-ZIP eligibility maintenance",
    ],
  },
  {
    id: "verify",
    station: 2,
    name: "Verify (on-market / off-market)",
    automationStatus: "automated",
    lostPhoneRisk: "LOW",
    stallsWithoutOperator: false,
    completionPct: 85,
    stateToday:
      "verify-listing confirms active status via RentCast; off-market veto now parks/disposes through the conveyor with the delivered-offer/open-thread guard. Runs per-record autonomously.",
    blockers: [],
    pathTo100: [
      "Wire off-market veto into a scheduled re-verify sweep (catch listings that go off-market mid-pipeline)",
      "Resolve the v1/v2 duplicate-record gap surfaced on 346 Modder (dedup on intake)",
    ],
  },
  {
    id: "enrich",
    station: 2.5,
    name: "Enrich (structural facts)",
    automationStatus: "automated",
    lostPhoneRisk: "LOW",
    stallsWithoutOperator: false,
    completionPct: 80,
    stateToday:
      "Intake mapper writes sqft/baths/year at create (zero extra calls); station2-enrich backfills nulls from RentCast subject facts. Year_Built field live. Enrichment writes do NOT trigger downstream (decoupled).",
    blockers: [{ ref: "STATIONS-4/5/8", text: "Enrichment does not event-trigger ARV/rehab/underwrite" }],
    pathTo100: [
      "Backfill Year_Built on the already-enriched cohort (re-fire station2-enrich)",
      "Emit an enrichment-complete event that the appraisal cascade can subscribe to",
    ],
  },
  {
    id: "outreach",
    station: 3,
    name: "Outreach (H2 / Crier)",
    automationStatus: "partial",
    lostPhoneRisk: "MEDIUM",
    stallsWithoutOperator: true,
    completionPct: 80,
    stateToday:
      "H2 first-contact fires autonomously on cron (65%-of-list script). Crier re-engagement primitives exist. REPLIES require operator relay — that arm stalls without the operator (346 Modder is sitting on a live 'Response Received').",
    blockers: [
      { ref: "INV-020", text: "Gmail/SMS inbound triage + Action Queue surfacing not wired" },
      { ref: "INV-017/019", text: "Quo MCP read auth asymmetry + silent delivery failure" },
    ],
    pathTo100: [
      "Ship INV-020 inbound triage (severity classify → attribute → auto-draft holding reply)",
      "Close Quo delivery-confirmation gap (poll or webhook)",
      "Wire reply → negotiation-state advance",
    ],
  },
  {
    id: "arv",
    station: 4,
    name: "ARV / Comps",
    automationStatus: "partial",
    lostPhoneRisk: "MEDIUM",
    stallsWithoutOperator: true,
    completionPct: 65,
    stateToday:
      "appraiser-backfill cron fans ARV per record but at limit=3/day, selection-based, NOT event-triggered — hot deals wait days. RentCast/ATTOM comps flow; confidence-floor friction drops some to manual_review.",
    blockers: [{ ref: "STATIONS-4/5/8", text: "Cron-sweep throughput (3/day) + no event trigger from enrich" }],
    pathTo100: [
      "Event-wire enrich-complete → ARV (replace blind sweep)",
      "Raise sweep throughput or prioritize by pipeline stage (hot deals first)",
      "Resolve confidence-floor drops (comp-coverage fallback)",
    ],
  },
  {
    id: "rehab",
    station: 5,
    name: "Rehab estimate (vision)",
    automationStatus: "partial",
    lostPhoneRisk: "MEDIUM",
    stallsWithoutOperator: true,
    completionPct: 50,
    stateToday:
      "Vision pipeline exists (base64 path, photo-source priority). Photo collection still fragile; gates correctly HOLD on Street-View-only / low-confidence, which means many records need the operator's manual-rehab fallback.",
    blockers: [
      { ref: "INV-005", text: "Photo-collection success rate; manual fallback is operator-gated" },
      { ref: "INV-021", text: "4-consumer photo-collection contract divergence" },
    ],
    pathTo100: [
      "Lift photo-collection reliability (Firecrawl-first verified; demote ScraperAPI)",
      "Unify the 4 photo consumers on the graceful-degrade contract",
      "Auto-retry manual_operator records on a cooldown (already partly built — extend)",
    ],
  },
  {
    id: "underwrite",
    station: 6,
    name: "Underwrite (Quality Gate)",
    automationStatus: "partial",
    lostPhoneRisk: "HIGH",
    stallsWithoutOperator: true,
    completionPct: 40,
    stateToday:
      "INV-023 math gate shipped (PC-25/26/27 in Gate 4). But PC-26 HOLDs on EVERY record because Property_Intel.Buyer_Median_Value has ZERO writers — InvestorBase scraper doesn't exist. The whole back half is gated here.",
    blockers: [
      { ref: "INV-022", text: "Buyer_Median hydration — InvestorBase scraper/API client does not exist" },
      { ref: "INV-023", text: "V2 DD checklist (payoff viability, federation discrepancy, clause extraction) not built" },
    ],
    pathTo100: [
      "Hydrate Buyer_Median: build InvestorBase scraper (α) OR operator-manual per-deal (γ) for the active cluster now",
      "Ship INV-022 federation layer (PropStream/RentCast/FEMA → Property_Intel with provenance)",
      "Build INV-023 V2 DD checklist + downstream cascade",
    ],
  },
  {
    id: "negotiate",
    station: 7,
    name: "Negotiate / Reply triage",
    automationStatus: "manual",
    lostPhoneRisk: "HIGH",
    stallsWithoutOperator: true,
    completionPct: 25,
    stateToday:
      "Largely manual. Inbound seller-agent replies are relayed by the operator via Quo/Gmail. No autonomous negotiation-state machine; RESPONSE-DUE alerts have stage false-positives.",
    blockers: [
      { ref: "INV-020", text: "Inbox triage + auto-draft not wired" },
      { ref: "INV-010", text: "RESPONSE DUE false-positive contradicting deal stage" },
      { ref: "INV-007", text: "Multi-listing-agent attribution layer (Step 2) not built" },
    ],
    pathTo100: [
      "Ship INV-020 autonomous holding-reply + operator-approval queue",
      "Build the unified attribution layer (INV-007 Step 2 → resolves INV-014/015/016)",
      "Stage-aware alert suppression (INV-010)",
    ],
  },
  {
    id: "contract",
    station: 8,
    name: "Contract / DD",
    automationStatus: "partial",
    lostPhoneRisk: "HIGH",
    stallsWithoutOperator: true,
    completionPct: 30,
    stateToday:
      "Pre-EMD gate + DD checklist scaffolding exist (INV-029). But DocuSign/Authentisign are not provisioned, so envelopes can't fire; DD auto-extraction from comms (INV-008) is not built. Contracts stall.",
    blockers: [
      { ref: "INV-024", text: "DocuSign/Authentisign webhook wiring to Action Queue" },
      { ref: "INV-008", text: "DD checklist auto-extraction from comms chain" },
      { ref: "PROVISION", text: "DocuSign account/envelope provisioning (operator)" },
    ],
    pathTo100: [
      "Provision DocuSign + wire envelope create/send",
      "Wire INV-024 webhooks (sent→viewed→signed→completed) into Action Queue",
      "Build INV-008 comms→DD-field auto-extraction",
    ],
  },
  {
    id: "dispo",
    station: 9,
    name: "Dispo / Closing",
    automationStatus: "unbuilt",
    lostPhoneRisk: "HIGH",
    stallsWithoutOperator: true,
    completionPct: 15,
    stateToday:
      "Deals table + closing-status fields + buyer pool exist as data, but there is no closing orchestration: no buyer-blast automation, no title-coordination cadence, no assignment-execution flow driving to Closed.",
    blockers: [
      { ref: "INV-022", text: "Buyer smart-match pull (InvestorBase) for dispo" },
      { ref: "PHASE-15.5", text: "Per-deal P&L + closing orchestration not built" },
    ],
    pathTo100: [
      "Build buyer-blast + smart-match dispo flow off the Buyers table",
      "Title-coordination cadence engine (the Closing_F3..F9 idempotency keys are stubbed)",
      "Assignment-execution → Closed transition + per-deal P&L capture",
    ],
  },
];

// Cross-cutting infrastructure (not a pipeline stage, but load-bearing).
// Tracked separately so it doesn't dilute the stall-count headline.
export const INFRA_COMPLETION = {
  pct: 78,
  note:
    "Pipeline_State engine (sole writer, legal-edge guarded), Spine, Pulse detectors, conveyor spend telemetry, paid-API audit, Source_Version walls — strong. Gaps: data federation (INV-022) partial; event bus absent (stations decoupled).",
} as const;

// Operator hours/week is NOT auto-measurable today (no instrumentation).
// This is the operator-confirmed estimate; replacing it with a measured
// value is itself a roadmap item (instrument code-paste + dashboard time).
export const OPERATOR_HOURS_ESTIMATE = {
  lowHours: 33,
  highHours: 58,
  targetHours: 15,
  asOf: "2026-05-23",
  measured: false,
  note:
    "Rough estimate from INV-026 baseline. Top consumers: dashboard time, code-paste coordination, manual data hydration, DD work. Collapses with INV-022 (hydration), INV-020 (inbox), INV-023 (DD), GITHUB_PAT (code-paste).",
} as const;

// The Crawler 2.0 unlock target (Bible §1.2): $40K/mo net for 3 consecutive
// months. The velocity number is measured against this.
export const DEAL_VELOCITY_TARGET = {
  monthlyNetUsd: 40_000,
  consecutiveMonths: 3,
} as const;
