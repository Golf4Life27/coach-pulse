# AKB INEVITABLE — MASTER CHECKLIST

**Document version:** v1.1 (Code-audited)
**Authored:** May 15, 2026 (v1.0 — Claude, post-Gate-3-closure)
**Audited + corrected:** May 16, 2026 (v1.1 — Code, Days 6-7 audit pass)
**Status:** **THE** procedural source of truth. Every other doc is a spec. This is the sequence.
**Owner:** Alex Balog (decisions) / Code (build) / Claude (orchestration + drafting)

---

## Why this document exists

Alex has asked for a checklist countless times. Seven thousand documents have been produced. None of them are this. **This document is the single procedural list to follow until Inevitable is operational.**

## Rules of engagement

1. **Items are followed in order unless explicitly skipped with a logged reason.** No silent skipping.
2. **Every skip requires a reason recorded inline** in the `Skip Reason` column. Acceptable reasons: `OUTDATED`, `REPLACED-BY-[item#]`, `DEFERRED-UNTIL-[trigger]`, `BLOCKED-BY-[item#]`.
3. **New procedures may be inserted** with a clear `INSERTED [date] BECAUSE [reason]` note. Insertion does not justify skipping unrelated items.
4. **Skipped items must be revisited** unless marked `OUTDATED` or `REPLACED`. The `DEFERRED-UNTIL-[trigger]` status creates an active surveillance commitment.
5. **Status values:** `DONE` | `IN PROGRESS` | `BLOCKED` | `NOT STARTED` | `SKIPPED-OUTDATED` | `SKIPPED-REPLACED` | `SKIPPED-DEFERRED`
6. **Severity values:** `CRITICAL` (blocks deal flow or revenue) | `HIGH` (significant productivity multiplier) | `MEDIUM` (quality/discipline) | `LOW` (nice-to-have)
7. **This doc lives at `akb-dashboard/docs/specs/AKB_MASTER_CHECKLIST.md`.** Code's audited canonical version is here.
8. **Maverick loads this checklist** alongside the Continuity Layer Spec at session-start. Future Claude sessions read this first.
9. **Code-audited status correction notation:** entries with `(CODE 5/16: ...)` indicate Code's Days 6-7 audit corrected the original draft based on repo / Airtable / Vercel / live-briefing evidence. Original status preserved when correction is a status flip; otherwise commentary in Notes.

---

## Phase 0 — Foundation (HISTORICAL)

| # | Item | Status | Severity | Notes |
|---|------|--------|----------|-------|
| 0.1 | LLC formation (AKB Solutions LLC) | DONE | CRITICAL | Pre-2026 |
| 0.2 | Banking + accounting separation | DONE | CRITICAL | Pre-2026 |
| 0.3 | Quo phone number (815-556-9965) + carrier registration | DONE | CRITICAL | Carrier registration PAID and LIVE |
| 0.4 | Airtable base `appp8inLAGTg4qpEZ` with Listings_V1 table | DONE | CRITICAL | Primary table `tbldMjKBgPiq45Jjs` |
| 0.5 | Buyers table `tbl4Rr07vq0mTftZB` | DONE | CRITICAL | |
| 0.6 | D3 Manual Fix Queue `tblV6OkNPDzOo6ubp` | DONE | HIGH | |
| 0.7 | Spine_Decision_Log table for principle persistence | DONE | CRITICAL | Maverick writes here. (CODE 5/16: confirmed `tblbp91DB5szxsJpT` referenced from `lib/maverick/recall.ts:17`) |
| 0.8 | Vercel project `prj_X1pCuqzRml74iOKfNhTo4ZMG9K87` provisioned | DONE | CRITICAL | Team `team_zwFAlAQ8CyjGYcxyk7Sn6ww0` |
| 0.9 | GitHub repo `Golf4Life27/coach-pulse` with subdir `akb-dashboard/` | DONE | CRITICAL | Current branch: `claude/build-akb-inevitable-week1-uG6xD` |
| 0.10 | Vercel KV provisioned for audit log | DONE | CRITICAL | Used by Maverick state layer. (CODE 5/16: confirmed via live Maverick briefing — `vercel_kv_audit` source returned ok with 28 events) |

---

## Phase 1 — Intake & Pipeline Loading (HISTORICAL + ACTIVE)

| # | Item | Status | Severity | Notes |
|---|------|--------|----------|-------|
| 1.1 | PropStream account + export workflow | DONE (manual) | HIGH | Currently manual exports — Alex runs CSV pulls |
| 1.2 | Scenario A (Intake_Loader_V1, Make 4256273) | DONE | CRITICAL | Filters: Poor/Disrepair/Average, $3.5K-$250K, regex phone. Number fields use `{{if(value; value; ignore)}}` pattern in Modules 12/13 as of 5/1/2026. (CODE 5/16: process-intake/route.ts mirrors filters in Vercel; A retained per Phase 20.1 resolution) |
| 1.3 | Scenario B (Listing_Verification_V2, Make 4331170) | DONE (with pending fixes) | HIGH | Live but needs 4 fixes (see 1.4-1.7). (CODE 5/16: `app/api/verify-listing/route.ts` is the Vercel-side companion that writes Execution_Path; Make B remains the verification fire-path) |
| 1.4 | Scenario B fix: Off-market body text detection | NOT STARTED | HIGH | Scan for "off the market"/"sold on"/"pending sale" |
| 1.5 | Scenario B fix: Flip/renovation keyword scoring | NOT STARTED | HIGH | 4+ indicators = Manual Review, 7+ = Reject |
| 1.6 | Scenario B fix: DOM discrepancy check (PropStream vs. Redfin) | NOT STARTED | MEDIUM | Flag if delta >14 days |
| 1.7 | Scenario B fix: Agent_Phone numeric validation | NOT STARTED | MEDIUM | Regex `^[\d\-\(\)\s\+\.]+$` or route to Manual Review |
| 1.8 | NEVER-list enforcement (12+ properties) | DONE | CRITICAL | Per userMemory |
| 1.9 | Dead-record auto-classification | DONE | HIGH | 1,093 records currently marked Dead. (CODE 5/16: `lib/bulk-dead-annotation.ts` + admin bulk-dead route confirm) |
| 1.10 | 890 records singleSelect/formula mismatch bulk cleanup | NOT STARTED | HIGH | Required before H2 fires safely at scale |

---

## Phase 2 — Outreach (Crier) Layer (HISTORICAL + ACTIVE)

| # | Item | Status | Severity | Notes |
|---|------|--------|----------|-------|
| 2.1 | Quo API integration (`/v1/messages`) | DONE | CRITICAL | Raw API key in Authorization header, phone ID `PNLosBI6fh`. (CODE 5/16: `lib/quo.ts` 227 lines, no throttle layer present) |
| 2.2 | H2 (Quo_Outreach_V1, Make 4724197) | DONE | CRITICAL | Trigger: `AND(Execution_Path=Auto Proceed, Live_Status=Active, Outreach_Status empty, State=TX, NOT(Do_Not_Text), Agent_Phone not empty)`. (CODE 5/16: H2 retires per Phase 20.1 retirement plan when Acquisition Agent ships + 30d stability) |
| 2.3 | Outreach script (canonical 3-sentence version) | DONE | CRITICAL | "Hi [First Name], this is Alex with AKB Solutions..." |
| 2.4 | 9 PM CT daily send cutoff | DONE | HIGH | No late-night texts |
| 2.5 | 128 TN records pre-blocked (Memphis acquisition pause) | DONE | CRITICAL | |
| 2.6 | L3 Reply Triage V3 (Make 4812756) | DONE | CRITICAL | 4-way Router architecture, working as of 4/21/2026. (CODE 5/16: KEEP per Phase 20.1 retirement plan — Negotiation Agent reads its output) |
| 2.7 | L2 deprecation | DONE | MEDIUM | Replaced by L3 |
| 2.8 | Quo throttle implementation (15/hour recommended) | NOT STARTED | HIGH | Specced, not built. (CODE 5/16: confirmed — grep for "throttle\|rate" in `lib/quo.ts` returns zero matches) |
| 2.9 | Cadence_Queue async dispatch | NOT STARTED | HIGH | Specced, not built. (CODE 5/16: confirmed — only references are `cadence_queue_present: false` placeholder in action-queue source) |
| 2.10 | Make blueprint API gotcha: every push sets isActive: false | DOCUMENTED | MEDIUM | Manual UI toggle required every deploy. Workflow established. |

---

## Phase 3 — Pricing & Math Discipline (HISTORICAL + ACTIVE)

| # | Item | Status | Severity | Notes |
|---|------|--------|----------|-------|
| 3.1 | 65% List Price outreach pricing | DONE | CRITICAL | Door-opener stage |
| 3.2 | V2.1 negotiation pricing (`Investor_MAO = Buyer_Tx_Median − Est_Rehab`) | DONE | CRITICAL | Per Spine 65% Rule + Offer Discipline |
| 3.3 | <20 priced transactions = Manual Review gate | DONE | CRITICAL | Sentry enforces. (CODE 5/16: enforced in `lib/orchestrator/pre-send-checks.ts` family) |
| 3.4 | InvestorBase per-property CSV exports | DONE (manual) | HIGH | ~50/week bottleneck, no API yet |
| 3.5 | RentCast API integration (AS-IS value) | DONE | CRITICAL | Key in password manager, NOT for ARV. (CODE 5/16: live briefing shows `api_responsive: true`, monthly cap 1000, 16 days until reset, ~0 burn) |
| 3.6 | Buy Box Cartel buyer max offer reference | DONE | HIGH | Empirical anchoring, no universal multiplier |
| 3.7 | HARD RULE: no fabricated multipliers | DONE | CRITICAL | Locked after 4/26 80% MAO near-disaster |
| 3.8 | OfferPrice stickiness (no auto-revise down on seller moves) | DONE | CRITICAL | Per memory |
| 3.9 | Buyer-facing comms: show ONE number only | DONE | CRITICAL | Never disclose spread/fee/contract price |
| 3.10 | `stored_offer_price` field on Listings_V1 | **WRITES PARTIAL** | CRITICAL | (CODE 5/16: status corrected. Field IS written by `app/api/admin/d3-backfill-offer-fields/route.ts` admin one-shot route. NOT written on the live H2 outreach-fire path — that's the broken-discipline finding (Finding #9 / item 11.4). Live briefing's `active_deals` was empty tonight so could not validate in-flight values, but Phase 4 pricing route computes Your_MAO without persisting to Stored_Offer_Price.) |
| 3.11 | Phase 4 — Hyper-Local Math Layer | **PARTIALLY BUILT** | HIGH | (CODE 5/16: status corrected from "LOCKED, NOT STARTED" — Phase 4A + 4B + 4C have shipped. `app/api/agents/pricing/[recordId]/route.ts` orchestrates all three with computeDualTrackPricing. `app/api/arv-intelligence/[zip]/route.ts` ARV engine live. `app/api/rehab-calibration/route.ts` rehab tier engine live. Live briefing audit shows `phase4c` agent fired in last 24h. Phase 4D `/api/deal-math/[recordId]` and Phase 4E BroCard render NOT YET — see new items 3.11a + 3.11b below.) |
| 3.11a | Phase 4D — Unified Deal Math endpoint (`/api/deal-math/[recordId]`) | **NOT STARTED** | HIGH | (CODE 5/16: INSERTED. Pricing-route is per-record but not the canonical `/api/deal-math/` namespace endpoint specced in Phase 3.11.) |
| 3.11b | Phase 4E — Two-Track BroCard rendering in dashboard | **PARTIALLY BUILT** | HIGH | (CODE 5/16: INSERTED. `components/TwoTrackPricing.tsx` exists at 351 LOC. Wired into deal detail pages — need design pass vs Daily UX Spec §4.3 priority surface treatment.) |
| 3.12 | Pricing Agent integration into outreach pre-fire | DONE | HIGH | (CODE 5/16: confirmed via `lib/orchestrator/pre-outreach-checks.ts` family + `outreach-safety-check` route) |

---

## Phase 4 — Buyer Network (Scout) Layer (HISTORICAL + ACTIVE)

| # | Item | Status | Severity | Notes |
|---|------|--------|----------|-------|
| 4.1 | Buyers table schema | DONE | CRITICAL | `tbl4Rr07vq0mTftZB` |
| 4.2 | Buyer warmup sequences (daily cron) | DONE | HIGH | LLM-driven, running. (CODE 5/16: `app/api/buyers/warmup-sequence/route.ts` exists; cron `/api/buyers/warmup-sequence` at 13:00 in `vercel.json`) |
| 4.3 | Buyer warmth states (cold/warm/active) | DONE | MEDIUM | (CODE 5/16: confirmed in `lib/buyers-v2.ts`) |
| 4.4 | Buy-box capture on inbound buyer replies | DONE | HIGH | |
| 4.5 | Automated buyer-deal matching | **PARTIALLY BUILT** | HIGH | (CODE 5/16: status corrected from NOT STARTED. `app/api/buyers/match-to-deal/[recordId]/route.ts` exists. Wired but not yet a "Scout intelligence layer" per spec — single-direction match, no proactive surfacing in briefing. Promote to fully DONE when Scout-named-agent attribution + priority surface BroCards land.) |
| 4.6 | Dispo blast queue | **PARTIALLY BUILT** | HIGH | (CODE 5/16: `app/api/buyers/fire-blast/[recordId]/route.ts` + draft-outreach route exist. Wired for per-record fire, not the queue-level dispo blast. Promote when Phase 4.7 (Scenario G hardening) ships in parallel.) |
| 4.7 | Scenario G (Deal_Alert_Blast_V1, Make 4583609) hardening | NOT STARTED | CRITICAL | Build `G_Safe_View` in Airtable excluding Contract_Price; G reads from that view only. Field must be physically absent — manual template discipline will fail. (CODE 5/16: confirmed G retires per Phase 20.1 retirement plan when Dispo Agent ships) |

---

## Phase 5 — Contract & Closing (Scribe) Layer (FORWARD)

| # | Item | Status | Severity | Notes |
|---|------|--------|----------|-------|
| 5.1 | DocuSign account + workflow established | DONE | CRITICAL | Receiving envelopes from sellers' agents |
| 5.2 | Manual contract review process | DONE | CRITICAL | Working today — tonight's 23 Fields review caught redline gap |
| 5.3 | Contract auto-draft (Buyer side) | NOT STARTED | HIGH | |
| 5.4 | DocuSign API integration | **UNBLOCKED — NOT WIRED** | HIGH | (CODE 5/16: status corrected. DocuSign MCP server `ab943441-29da-4bcb-8d3f-19efc0412d6c` is **now live** — tool schemas `mcp__Docusign__getEnvelope/getEnvelopes/createEnvelope/listRecipients/getAgreementDetails/...` surfaced as deferred tools in THIS session, no longer "announced but not in deferred-tools registry". `lib/orchestrator/pre-contract-checks.ts:79` blocked_on `docusign_mcp_wire_in` can now be resolved. Required for Scribe per Finding #8 — PDF exports drop redline markup, must use API.) |
| 5.5 | EMD wire procedure documented | NOT STARTED | HIGH | Following Wire Fraud Warning discipline |
| 5.6 | Inspection period management | DONE (manual) | HIGH | Never waived rule enforced |
| 5.7 | Assignment clause check pre-contract | DONE (manual) | CRITICAL | Memphis acquisition pause depends on this. (CODE 5/16: `lib/orchestrator/pre-contract-checks.ts` has inviolable items per spec §7) |
| 5.8 | Title company relationships | IN PROGRESS | HIGH | Regency Title (Memphis) established via 23 Fields |

---

## Phase 6 — Maverick Continuity Layer (HISTORICAL)

| # | Item | Status | Severity | Notes |
|---|------|--------|----------|-------|
| 6.1 | Continuity Layer Spec v1.0 authored | DONE | CRITICAL | 5/14/2026 |
| 6.2 | Spec v1.1 with 7 locked amendments | DONE | CRITICAL | Commit `3036126` Day 1 |
| 6.3 | Day 1 — 9 source fetchers | DONE | CRITICAL | git, airtable-listings, airtable-spine, vercel-kv-audit, codebase-metadata, action-queue, external-rentcast, external-quo, external-vercel |
| 6.4 | Day 2 — Aggregator + template + synthesizer | DONE | CRITICAL | Commit `a93a8d8` (CODE 5/16: corrected — Checklist draft said `2ea0161` which is actually the Airtable timeout-bump fix commit; Day 2 ship is `a93a8d8`) |
| 6.5 | Day 2 Gate 2 — P95 ≤ 30s confirmed at 19.6s | DONE | CRITICAL | |
| 6.6 | Day 3 — MCP server with `maverick_load_state` | DONE | CRITICAL | Commit `3248c2d` |
| 6.7 | Day 4 — `maverick_write_state` + `maverick_recall` | DONE | CRITICAL | Commit `366d456`, append-only per spec §6.4 |
| 6.8 | Day 4.5 — OAuth implementation | DONE | CRITICAL | Commit `15b6bfe`, Authorization Code + PKCE, Vercel KV opaque tokens |
| 6.9 | Spec v1.2 with §6.8 OAuth + §6.9 model registry amendments | DONE | CRITICAL | (CODE 5/16: numbering in spec is §6.8 OAuth + §6.9 model registry, NOT §6.5/§6.6 as in draft proposal — v1.1's §6.1-§6.7 were already taken. Implementation amendment §15 in MAVERICK_OAUTH_PROPOSAL.md documents this.) |
| 6.10 | Gate 3 closure — claude.ai connector registered, fresh chat invocation succeeded | DONE | CRITICAL | 5/15/2026 evening. (CODE 5/16: confirmed via current session — MCP server instructions for Maverick surfaced as system reminder, `mcp__Maverick__maverick_load_state` callable from THIS Code session — Maverick is reachable.) |
| 6.11 | Three Maverick spec docs (Character / Daily UX / Capability Absorption) | DONE | CRITICAL | Authored 5/15, delivered to Code via upload on 5/16 |
| 6.12 | Day 5 — Self-instrumentation + stress tests | DONE | CRITICAL | Commit `44f504e`, 397 tests passing |
| 6.13 | Gate 5 — P95 telemetry from production usage | **IN PROGRESS — FIRST SAMPLE OVER TARGET** | HIGH | (CODE 5/16: first telemetry sample landed tonight. Live briefing audit shows MCP `maverick_load_state` P50/P95/P99 all at 31,725ms — **over the 30s target** (`over_target_count: 1`). Cause: 3 Airtable sources timed out concurrently (listings 15s, spine 8s, action_queue 8s) — same contention pattern flagged Day 1. Single sample, not statistically meaningful. Re-evaluate after ~10 sessions. May need Phase 12.6 — concurrent Airtable contention mitigation — inserted below.) |
| 6.14 | Master Context userMemory edit (canonical session-bootstrap directive) | **DONE** | CRITICAL | (CODE 5/16: implied DONE — this Code session received the MCP server instructions for Maverick via system-reminder including the load-state directive. Either Alex pasted the userMemory or the project knowledge equivalent is wired. Directive lives in MAVERICK_OPS.md.) |

---

## Phase 7 — Maverick Spec Docs (HISTORICAL + DROP TO PROJECT)

| # | Item | Status | Severity | Notes |
|---|------|--------|----------|-------|
| 7.1 | `Maverick_Character_Spec_v1.md` | DONE | HIGH | German Shepherd identity, voice register, severity tiers, synthesis prompt instructions. (CODE 5/16: read in full this turn, archiving copy at `docs/specs/` in this commit.) |
| 7.2 | `Maverick_Daily_UX_Spec_v1.md` | DONE | CRITICAL | Visual command surface, factory-floor layout, agent rooms, persistent Shepherd panel, Stage 4 SMS escalation. (CODE 5/16: read in full this turn, archiving copy at `docs/specs/`.) |
| 7.3 | `Maverick_Capability_Absorption_Reference_v1.md` | DONE | HIGH | Matrix-upload analogy canonical, 5-phase absorption pattern. (CODE 5/16: read in full, archiving copy at `docs/specs/`.) |
| 7.4 | All three specs uploaded to Inevitable project knowledge | DONE | HIGH | (CODE 5/16: implied DONE per Alex's 5/15 confirmation. Cannot independently verify project-knowledge contents from Code sandbox, but the userMemory + connector setup from Phase 6.14 implies the project is fully provisioned.) |
| 7.5 | Master Context updated to reference all four spec docs | NOT STARTED | HIGH | Continuity Layer + Character + Daily UX + Capability Absorption |

---

## Phase 8 — Code's Days 6-7 Audit (FORWARD, NOW HISTORICAL ON COMMIT)

| # | Item | Status | Severity | Notes |
|---|------|--------|----------|-------|
| 8.1 | Greenlight Days 6-7 audit to Code | DONE | HIGH | Alex's 5/16 message |
| 8.2 | Code reads three Maverick specs in full | DONE | HIGH | (CODE 5/16: read all three from `/tmp/akb-inputs/` after Alex provided via zip upload.) |
| 8.3 | `AKB_Dashboard_Current_State_v2.md` component audit produced | DONE | CRITICAL | (CODE 5/16: committed in this audit cycle. Gated on 20.1 resolution which is RESOLVED below.) |
| 8.4 | Intake pipeline current state included in audit | DONE | HIGH | (CODE 5/16: covered in System Inventory + Dashboard Current State.) |
| 8.5 | System inventory (`AKB_System_Inventory_v1.md`) | DONE | HIGH | (CODE 5/16: committed in this audit cycle.) |
| 8.6 | Resolve Phase 20.1 (Make migration question) before producing audit deliverables | DONE | CRITICAL | (CODE 5/16: RESOLVED. Per-scenario retirement plan in Bible §9.5 / Code Briefing §9. See Resolution Log at bottom for details.) |
| 8.7 | Sequencing recommendation for Day 8+ dashboard rework | DONE | HIGH | (CODE 5/16: embedded in this Checklist as Phase 9 revised sequencing notes.) |
| 8.8 | v1.2 findings #6-9 scheduled into appropriate phases | DONE | HIGH | (CODE 5/16: schedule below in Phase 11 — #6 → 8b Day-5 hardening, #7 → 11.2 Day 8+ Listings_V1 schema, #8 → Phase 5.4 unlock, #9 → 11.4 Phase 4 wiring fix) |

---

## Phase 9 — Dashboard Rework (Day 8+, FORWARD)

Sequencing locked per Code's audit (5/16) — items ordered by dependency + leverage. Daily UX Spec §10.3 lists 1-7 illustratively; this is the actual order.

| # | Item | Status | Severity | Notes |
|---|------|--------|----------|-------|
| 9.1 | Shepherd panel (persistent Maverick presence on every page) | **DONE** | CRITICAL | (CODE 5/16 Commit B. `components/ShepherdPanel.tsx` rendered from `app/layout.tsx` so persistent across every route. Collapsed: floating pill bottom-right with tier-colored dot + 🐕 placeholder + status label. Expanded: 320px panel with MaverickPriority surface, refresh button, last-fetched timestamp. Subscribes to `/api/maverick/load-state?format=structured` on mount + auto-refresh 90s. Mobile: stacks above CommandBarFAB collision. German Shepherd avatar (9.9) is BLOCKED — placeholder 🐕 emoji holds until asset lands. |
| 9.2 | Priority surface BroCards wired to Maverick aggregator | **DONE** | CRITICAL | (CODE 5/16 Commit B. `components/MaverickPriority.tsx` renders signals inferred from load-state via `inferPrioritySignals()`. Each item: tier-colored left border + status dot + headline + reasoning + agent attribution. Optional href for click-through. Empty state: "All clear. Maverick is watching." Error state: failure message + retry. Lives inside Shepherd panel for v1; standalone embed possible. Existing card family (DDCard/DealCard/etc.) untouched — they remain deal-specific. Phase 9.4 will bridge per-deal signals into those cards.) |
| 9.3 | Named-agent vocabulary in code (`@agent: sentinel/crier/sentry/forge/scribe/scout/pulse/appraiser/ledger`) | **DONE** | HIGH | (CODE 5/16 audit insertion → 5/16 Commit A. 26 audit callsites renamed to roster names across 14 files. Final distribution: maverick 16, sentry 13, appraiser 9, crier 7, pulse 1. Zero operational tags remain. `lib/roster.ts` introduces ROSTER_AGENTS + ROSTER_DOMAINS as the canonical import path for non-Maverick code.) |
| 9.4 | Named-agent rooms on home page (Sentinel/Crier/Sentry/etc) | NOT STARTED | HIGH | (CODE 5/16: gated on 9.3 first. One agent room at a time. Crier likely first — `lib/quo.ts` + `outreach-fire` route are most-stable component to render visually.) |
| 9.5 | Severity tier visual treatment (Tier 0/1/2/3) | **DONE (minimum)** | HIGH | (CODE 5/16 Commit B. `lib/maverick/severity.ts` defines `TIER_VISUAL` (border + text + bg + dot + label) for all four tiers. `inferPrioritySignals(briefing)` classifies signals from load-state structured payload: source-down counts, Quo health, RentCast burn rate, MCP P95 over-target, recent_failures, open_decisions, active_deals. Signals sort tier-descending. 17 new tests in `severity.test.ts`. Tier 3 modal + SMS push (Daily UX Spec §5.4) deferred to 9.7 + 12.3.) |
| 9.6 | Live motion / animation (cards flowing between agent stations) | NOT STARTED | MEDIUM | Converting static to dynamic |
| 9.7 | Out-of-band SMS escalation (Stage 4 → Alex's phone) | NOT STARTED | HIGH | Required for "Maverick bugs me when I'm not at the dashboard". Daily UX Spec §8 — separate Quo number or Twilio integration |
| 9.8 | Deal-detail page enhancements (Maverick commentary, related-deal recall) | NOT STARTED | HIGH | Anchored to 251 Cliffwood reference. (CODE 5/16: existing dashboard has `app/pipeline/[id]/page.tsx` deal detail; gap is the Maverick-commentary panel + related-deal recall — both blocked until `maverick_recall` is wired into the deal-detail UI.) |
| 9.9 | German Shepherd avatar | NOT STARTED | MEDIUM | Visual identity per Character Spec §6 |
| 9.10 | Auto-allow `maverick_load_state` permission (currently "Needs approval") | NOT STARTED | LOW | Friction reduction once trust established |
| 9.11 | Jarvis→Maverick rename of components | **DONE** | MEDIUM | (CODE 5/16 audit insertion → 5/16 Commit A. LLM self-identity strings updated: `lib/jarvis-system-prompt.ts` "You are Jarvis" → "You are Maverick" ×4. User-visible UI strings updated in JarvisChat + JarvisFeed (toasts, headers, placeholder, "thinking..." indicator, attribution label). @deprecated JSDoc added to 3 components + 4 jarvis-* API routes pointing to Phase 9.1 / 9.2 / 10 replacements. File paths retained for backwards-compatible imports — actual file rename + deletion happens when Shepherd panel (9.1) + priority surface (9.2) supersede.) |

---

## Phase 10 — Synthesizer Refactor (Day 8+, FORWARD)

| # | Item | Status | Severity | Notes |
|---|------|--------|----------|-------|
| 10.1 | Refactor `lib/maverick/synthesize.ts` to use Character Spec anchored prompt | NOT STARTED | HIGH | Per Character Spec §7. Anchor: "You are Maverick, a German Shepherd by character..." |
| 10.2 | Build `lib/maverick/model-registry.ts` per Spec v1.2 §6.9 | NOT STARTED | HIGH | Tier registry + selectModel helper |
| 10.3 | Replace hardcoded `claude-sonnet-4-6` with `selectModel("premium_frontier")` | NOT STARTED | HIGH | Maverick rides Opus 4.7 |
| 10.4 | Bump synthesis budget to 30s (per latency tradeoff acceptance) | NOT STARTED | HIGH | Within v1.2 §6.2 P95 ≤ 30s ceiling. (CODE 5/16: live telemetry shows P95 already 31.7s on cold-path-with-source-timeouts — need to land 10.5 and 12.6 first to keep under target before bumping budget further.) |
| 10.5 | Trim `active_deals` to top 15 before synthesis (v1.2 backlog item #3) | NOT STARTED | MEDIUM | Latency + cost reduction. (CODE 5/16: priority bumped — this directly mitigates tonight's P95 overshoot once Airtable returns deals.) |
| 10.6 | Prompt-cache audit (Constitution + agent roster + Character Spec) | NOT STARTED | MEDIUM | |

---

## Phase 11 — v1.2 Findings From Gate 3 Real-World Usage (FORWARD)

| # | Item | Status | Severity | Notes |
|---|------|--------|----------|-------|
| 11.1 | Finding #6: `external_quo` quiet-vs-down conflation fix | **DONE** | MEDIUM | (CODE 5/16: shipped in this sprint. `lib/maverick/sources/external-quo.ts` now runs probe + activity in parallel via Promise.allSettled. Probe (`/v1/messages?phoneNumberId=X&maxResults=1`) drives `api_responsive`; activity call drives stats. Probe success + activity failure → api_responsive stays true with zero stats; probe failure → api_responsive false. Schema drift on activity query no longer collapses to "Quo is dark.") |
| 11.2 | Finding #7: `last_outreach_date` SMS-only — add `last_email_outreach_date` field | NOT STARTED | HIGH | Caused tonight's 23 Fields false-stale |
| 11.3 | Finding #8: Scribe must read DocuSign API directly (not PDF exports) | NOT STARTED | MEDIUM (HIGH at Scribe ship) | (CODE 5/16: **UNBLOCKED** — DocuSign MCP now live, see 5.4 above.) |
| 11.4 | Finding #9: `stored_offer_price` universally null — V2.1 pricing discipline broken | **DONE** | HIGH | (CODE 5/16: shipped in this sprint. Two write paths wired: (a) `app/api/agents/pricing/[recordId]/route.ts` persists `Stored_Offer_Price: your_mao_flipper` when phase4c succeeds + value > 0; (b) `app/api/outreach-fire/route.ts` (both new-outreach + multi-listing handlers) writes `Stored_Offer_Price: offerNum` + `List_Price_At_Send: listing.listPrice` on send success, mirroring d3-backfill semantics with data_source="live_send". Surfaces in next pricing-agent run + next H2 send. Open sub-question logged as Phase 20.2.) |
| 11.5 | Make blueprint API: "right()" doesn't exist | DOCUMENTED | LOW | Use substring instead |

---

## Phase 12 — Infrastructure Provisioning Gaps (FORWARD)

| # | Item | Status | Severity | Notes |
|---|------|--------|----------|-------|
| 12.1 | Vercel API token (`VERCEL_API_TOKEN` env var) | NOT STARTED | MEDIUM | Deploy state currently blind in briefings. (CODE 5/16: confirmed via live briefing — `vercel.api_token_configured: false`, all deploy fields UNKNOWN.) |
| 12.2 | GitHub Personal Access Token (`GITHUB_PAT`) | NOT STARTED | MEDIUM | Git source returns empty without it. (CODE 5/16: confirmed via live briefing — `branch_resolved: false`, `latest_commit: null`, `commits_since_count: 0` even though there have been commits in the last 24h.) |
| 12.3 | Personal phone escalation channel (Stage 4 SMS path) | NOT STARTED | HIGH | Required for Daily UX Spec §8 |
| 12.4 | Scenario J fix — manual Make UI edit (HTTP module empty body) | NOT STARTED | MEDIUM | Anthropic key for Make stored, fix is UI-only. (CODE 5/16: J retires per Phase 20.1 retirement plan when Negotiation Agent ships) |
| 12.5 | Anthropic Console organization-level API spend monitoring | NOT STARTED | MEDIUM | Pulse routine eventually monitors this |
| 12.6 | Airtable concurrent-source contention mitigation | **DONE-PENDING-VALIDATION** | HIGH | (CODE 5/16: shipped in this sprint with mitigation (a) — serialize the 3 Airtable calls (listings → spine → queue) within the aggregator while keeping the other 6 sources parallel. `lib/maverick/aggregator.ts` chains via `.then()` so spine waits for listings to resolve before starting, queue waits for spine. Test `aggregator-stress.test.ts > serializes the 3 Airtable fetchers` locks the behavior. Validation pending: Gate 5 telemetry over next ~5 sessions should show P95 < 30s in `audit_summary.mcp_call_latency.p95_ms`. If telemetry stays over target, layer in mitigation (b): raise listings to 20s + spine/queue to 10s.) |

---

## Phase 13 — Sentinel Build (Funnel Autonomy) (FORWARD, MAJOR GAP)

**INSERTED 5/15 BECAUSE Alex's "what's directing the Crawler" question revealed Sentinel as vocabulary, not reality.**

(CODE 5/16: confirmed Sentinel is vocabulary-only — zero `@agent: sentinel` matches in code. The intake routes (`/api/process-intake`, `/api/verify-listing`, `/api/multi-listing-detect`) implement Sentinel's behavior but lack the named identity. Phase 9.3 — named-agent vocabulary in code — must precede this Phase's deliverables to maintain attribution coherence.)

| # | Item | Status | Severity | Notes |
|---|------|--------|----------|-------|
| 13.1 | Sentinel-as-briefing-routine (Path D from session) | NOT STARTED | HIGH | Reads `airtable-listings`, surfaces "we have N Multi-Listing Queued, intake needed" as BroCard. No autonomous action. |
| 13.2 | Sentinel inventory-low triggers | NOT STARTED | HIGH | When queued inventory drops below threshold, surface intake recommendation |
| 13.3 | PropStream export automation | NOT STARTED | HIGH | Replace manual CSV pull with API or scraping. Crawler 1.0 territory |
| 13.4 | Geographic expansion logic | NOT STARTED | HIGH | "Sentinel suggests Beaumont because signals are strong" — strategic direction layer |
| 13.5 | Crawler 1.0 — on-market MLS automation (full) | NOT STARTED | CRITICAL | The wife-retirement bet. Gated on initial deals shipped + cashflow |
| 13.6 | Crawler 2.0 — off-market motivated seller pipeline | NOT STARTED | HIGH | Probate, tax delinquency, code violations. Gated on Crawler 1.0 |

---

## Phase 14 — Pulse Build (System Self-Monitoring) (FORWARD)

| # | Item | Status | Severity | Notes |
|---|------|--------|----------|-------|
| 14.1 | Confidence threshold model for proactive surfacing | NOT STARTED | HIGH | Per Spec §5 Step 5 |
| 14.2 | Drift detection (audit log patterns over time) | NOT STARTED | MEDIUM | |
| 14.3 | Quota burn monitoring (RentCast + Quo + Anthropic API) | **PARTIALLY BUILT** | HIGH | (CODE 5/16: RentCast burn-rate fully built in `lib/maverick/rentcast-burn-rate.ts`. Quo + Anthropic burn-rate NOT YET. Promote to DONE when all three landed.) |
| 14.4 | Capability/model registry monitoring (Spec v1.2 §6.9 Phase 2) | NOT STARTED | MEDIUM | Surface BroCard when new Anthropic model ships |
| 14.5 | Joe Schmoe-style cross-context recall surfacing | NOT STARTED | HIGH | The "all-seeing eye" capability. (CODE 5/16: foundation laid via `maverick_recall` MCP tool. Surfacing layer not built — needs Phase 14.1 confidence-threshold first.) |
| 14.6 | Family-time signal awareness | NOT STARTED | MEDIUM | Per Character Spec §4.6 |

---

## Phase 15 — Ledger Build (Economics) (FORWARD)

| # | Item | Status | Severity | Notes |
|---|------|--------|----------|-------|
| 15.1 | Revenue tracking per deal | NOT STARTED | HIGH | Monthly target progress |
| 15.2 | Agent cost attribution (LLM API spend per agent) | NOT STARTED | MEDIUM | |
| 15.3 | Truck fund tracking | NOT STARTED | MEDIUM | 10% of normal 30% revenue → next truck |
| 15.4 | Wife retirement progress meter | NOT STARTED | HIGH | The actual mission. Annual income replacement target |
| 15.5 | Deal-by-deal P&L cards | NOT STARTED | MEDIUM | |
| 15.6 | Lane purity (Inevitable revenue only — Whitetail excluded forever) | LOCKED IN SPEC | CRITICAL | Per Spec §7 + Character Spec §5.1 |

---

## Phase 16 — Active Deals In Flight (TACTICAL, CURRENT)

These are deals currently active. Status accurate as of 5/15 evening Maverick briefing + tonight's review.

(CODE 5/16: live briefing 1:11 UTC 5/16 returned `active_deals: []` because all 3 Airtable sources timed out. Status here preserved from 5/15 — Alex to refresh if any have moved.)

| # | Deal | Status | Action |
|---|------|--------|--------|
| 16.1 | 23 Fields Ave (Memphis, Candice Hardaway) | Contract review in progress | DocuSign envelope received 5/14. Email to Candice re: date corrections sent 5/15 evening. Awaiting corrected envelope. Section 16 properly redlined per Candice. EMD $675 to Regency Title within 3 days of binding. Target close ~June 5. |
| 16.2 | Hallbrook (Memphis) | Accepted at $93,500 | Active working playbook. Sole Memphis acquisition exception. Status not yet moved forward in Airtable per Maverick briefing |
| 16.3 | 5006 Creekmoor (San Antonio, George Vasquez) | $117,500 hold, 4 days silent | Soft nudge candidate. SMS counter previously fired but Quo data shows quiet since 5/12 |
| 16.4 | Briyana Jordan — Sturtevant Detroit | All-in ~$31K, $145K ARV | Math works if Detroit buyer sourced |
| 16.5 | Ford St (Daniel) | Reopened — seller offering to repair fire damage | Pending new pricing terms |
| 16.6 | Kim Maloney 8-plex (Houston) | Dead (competing offer) | DO NOT RESURFACE |
| 16.7 | 3022 El Paso St | Dead 4/14 | DO NOT RESURFACE |
| 16.8 | NEVER-list: 2715 Monterey, 714 Hallie, 4330 Pensacola, 9618 Tamalpais, 811 Manhattan, 1635 Arbor, 4448 Marcell, 2725 Bowling Green, 2011 Ramsey, 707 N Pine, 8641 Craige, 910 Green | NEVER RESURFACE | Filter enforced via Sentinel |
| 16.9 | 13-day Detroit Response Received cluster (~12 addresses) | Stale, needs triage | Crier silence may be exacerbating. Resolve after Phase 11.2 fix |

---

## Phase 17 — Monetization & Revenue Layers (FORWARD)

| # | Item | Status | Severity | Notes |
|---|------|--------|----------|-------|
| 17.1 | Phase 1 monetization — wholesale deal flow | IN PROGRESS | CRITICAL | Current focus |
| 17.2 | Phase 2 monetization — adjacent niches (commercial, land, machinery) | NOT STARTED | HIGH | Same stack, different inputs |
| 17.3 | Phase 3 monetization — digital products (Gumroad/Etsy) | NOT STARTED | MEDIUM | Etsy + Gumroad accounts created, products NOT LISTED |
| 17.4 | Wholesale Deal Analyzer ($19.99) | DRAFTED | LOW | `Updated_Etsy_Listing_Copy.md` exists |
| 17.5 | Agent Outreach Playbook ($14.99) | DRAFTED | LOW | |
| 17.6 | Property Screening Checklist ($9.99) | DRAFTED | LOW | |
| 17.7 | Pipeline Tracker ($49) | NOT STARTED | LOW | Future |
| 17.8 | 90-Day Playbook ($79) | NOT STARTED | LOW | Future |
| 17.9 | Full System License ($497+) | NOT STARTED | LOW | Future |

**SKIPPED — REPLACED-BY-architecture:**
- Coaching / Cohorts / Discord / SaaS / DFY services — Alex is a loner, will not do ongoing customer contact. Permanently out of scope.

---

## Phase 18 — Market Geography (HISTORICAL + ACTIVE)

| # | Item | Status | Severity | Notes |
|---|------|--------|----------|-------|
| 18.1 | Texas — San Antonio active | DONE | CRITICAL | Primary active market |
| 18.2 | Texas — Dallas | DONE | HIGH | Active outreach |
| 18.3 | Texas — Houston | DONE | HIGH | Active outreach |
| 18.4 | Tennessee — Memphis (acquisitions PAUSED, outreach OPEN) | DONE | CRITICAL | Sole exception: Hallbrook. Assignment clause check pre-contract required. Target ZIPs: 38109/38114/38116/38118/38127/38128. Avoid 38106 |
| 18.5 | Wholesale-restrictive states: IL, MO, SC, NC, OK, ND — AVOIDED | LOCKED | CRITICAL | Filter in Scenario A |
| 18.6 | Detroit (Michigan) — active | DONE | HIGH | Volume cohort |
| 18.7 | New market expansion logic (Sentinel intelligence) | NOT STARTED | HIGH | See Phase 13.4 |

---

## Phase 19 — Documentation Discipline (META, ONGOING)

| # | Item | Status | Severity | Notes |
|---|------|--------|----------|-------|
| 19.1 | Inevitable_Constitution_v3.docx (formerly Bible_v3) | DONE | CRITICAL | Living canonical handoff. READ FIRST every session |
| 19.2 | Continuity Layer Spec v1.2 (canonical) | DONE | CRITICAL | In repo at `docs/specs/Inevitable_Continuity_Layer_Spec_v1.2.md` |
| 19.3 | Three Maverick spec docs (Character / Daily UX / Capability Absorption) | DONE | HIGH | (CODE 5/16: archived copies committed to `docs/specs/` this turn as part of Days 6-7 audit.) |
| 19.4 | This Master Checklist | **DONE (canonical v1.1 audited)** | CRITICAL | (CODE 5/16: this commit. Future revisions follow the Living Artifact pattern.) |
| 19.5 | `MAVERICK_OPS.md` runbook | DONE | HIGH | Token rotation, OAuth troubleshooting, Gate 3 walkthrough |
| 19.6 | `MAVERICK_V12_BACKLOG.md` | DONE | HIGH | 9 deferred items logged |
| 19.7 | Living Artifact discipline: every doc carries `_v(n)` with `v(n+1)` expected | LOCKED PRINCIPLE | CRITICAL | Amendments are mechanism, not exception |
| 19.8 | No new doc generation without checking this checklist first | NEW DISCIPLINE | CRITICAL | INSERTED 5/15 BECAUSE 7 billion documents produced. New procedures get INSERTED INTO this checklist, not spawned as separate docs. (CODE 5/16: this audit produced ONLY the three explicitly-sanctioned deliverables — corrected Checklist, System Inventory, Dashboard Current State. No floating docs.) |

---

## Phase 20 — Open Architectural Questions

| # | Question | Status | Blocks | Notes |
|---|----------|--------|--------|-------|
| 20.1 | **Make.com migration vs. retention.** | **RESOLVED 5/16** | (nothing — was blocking Phase 8 audit; now unblocked) | See Resolution Log below. |
| 20.2 | **`Stored_Offer_Price` semantics — historical vs operative.** Is the field "the offer we made at outreach time" (point-in-time snapshot, never overwritten) or "the current operative offer ceiling" (mutable per pricing-agent runs)? The d3-backfill route's proxy semantics imply the former (65% List Price = "what we offered then"). Alex's Phase 11.4 directive implies the latter (pricing-agent overwrites with Your_MAO_flipper = "what we're now prepared to make"). v1.3 spec should pick one. Implementation 5/16 ships the latter reading; both backfilled records and live-sent records continue to populate Stored_Offer_Price, and pricing-agent overwrites once V2.1 pricing runs. | UNDECIDED — DEFERRED-UNTIL-v1.3-spec | Phase 11.4 implementation choice + briefing semantics | INSERTED 5/16 BECAUSE the field's semantic interpretation affects what Maverick's briefing reads back. Both readings are defensible; need Alex's pick before historical-deal analysis tooling assumes either. |

### Resolution log

**20.1 RESOLVED — May 16, 2026 (Code's Days 6-7 audit)**

**Decision:** Per-scenario retirement plan, canonical in `docs/AKB_INEVITABLE_Code_Briefing.md §9` (cross-referenced to `Inevitable_Operations_Bible §9.5`). This is essentially Option (c) hybrid, but with explicit per-scenario triggers rather than a generic "migrate where it makes sense" framing.

**The matrix:**

| Make scenario | Disposition | Trigger |
|---|---|---|
| A (Intake, 4256273) | KEEP (data pipe) | Never |
| B (Verification, 4331170) | KEEP, fix UI defects (items 1.4-1.7) | Never |
| H2 (Outreach, 4724197) | Replace with Acquisition Agent | After 30 days of agent stability |
| L3 (Reply triage, 4812756) | KEEP — Negotiation Agent reads its output | Never |
| L4 (Outbound capture) | KEEP | Never |
| G (Dispo blast, 4583609) | Replace with Dispo Agent | When Dispo Agent ships (Phase 4.7) |
| J (Verify agent, 4724499) | Replace with Negotiation Agent | When Negotiation Agent ships (Phase 12.4) |
| I (Rehab est) | Replace with Pricing Agent 4B subroutine | DONE — `app/api/rehab-calibration/route.ts` shipped |
| K (ARV) | Replace with Pricing Agent 4A subroutine | DONE — `app/api/arv-intelligence/[zip]/route.ts` shipped |

**Standing rule:** "Build new in Vercel only. No new Make scenarios." (Code Briefing §9 line 367.)

**Open sub-question (logged for future amendment):** Spec v1.2 line 257 says "Sentinel ... Scenario A + Scenario B in Make today; **migrates to Vercel post-precedent**." That contradicts §9's KEEP-forever framing for A + B. Conservative read: A + B are temporarily KEPT for the current build cycle, with migration deferred until after deal #1 closes (the "post-precedent" trigger). Spec v1.3 should reconcile — either amend §9 to "KEEP until post-precedent" or amend the Continuity Layer Spec §6 Sentinel row to "KEEP forever." Recommend the former for less spec churn.

**Resolved-by:** Code audit, May 16, 2026.

---

## Insertion log

| Date | Item # | Reason |
|------|--------|--------|
| 2026-05-15 | 8.4 | Alex's "what fills the funnel" question revealed Sentinel-vocabulary-vs-reality gap. Code must inventory intake state in audit |
| 2026-05-15 | 8.5 | This checklist itself needs Code's repo-grounded audit to fill in real status per item. Inventory doc is the vehicle |
| 2026-05-15 | 13 (entire phase) | Sentinel build separated from generic "agent build" because funnel autonomy is foundational to wife retirement |
| 2026-05-15 | 19.8 | Doc generation discipline rule. The "7 billion documents" failure mode gets blocked at the gate |
| 2026-05-15 | 20.1 | Make.com migration vs retention question raised but no clear prior decision found. Captured as open question blocking Phase 8 audit until resolved |
| 2026-05-16 | 3.11a | Phase 4D — Unified Deal Math endpoint distinct from per-record pricing route (Phase 4 partial-build correction) |
| 2026-05-16 | 3.11b | Phase 4E — Two-Track BroCard rendering exists in components but not anchored to Daily UX Spec priority surface (Phase 4 partial-build correction) |
| 2026-05-16 | 9.3 | Named-agent vocabulary in code does not exist. Specs canonical, attribution mismatched. Must precede Phase 9.4 + Phase 13 to maintain coherence |
| 2026-05-16 | 9.11 | Jarvis→Maverick rename of legacy components (JarvisChat/JarvisFeed/JarvisGreeting + 4 jarvis-* API routes). Pre-Maverick naming per Code Briefing §9 |
| 2026-05-16 | 12.6 | Airtable concurrent-source contention causing live Gate 5 sample over-target (Day 1's pattern reproducing under load) |
| 2026-05-16 | 20.2 | Stored_Offer_Price semantics ambiguity surfaced during Phase 11.4 implementation. Logged as v1.3 spec sub-question. |

---

## Skip log

| Date | Item # | Status | Reason |
|------|--------|--------|--------|
| 2026-05-15 | 17 (subset) | SKIPPED-REPLACED | Coaching / Cohorts / Discord / SaaS / DFY permanently out of scope. Alex is a loner |

---

## The bottom line

This document is the operating instruction set for Inevitable. **If we're not working on an item from this checklist, we're either (a) closing a deal in Phase 16, (b) handling a real-world fire that needs documentation as a new insertion, or (c) wasting time.**

After Code's 5/16 audit pass, the high-leverage next actions are:

1. **Phase 11.4 fix** — wire `Stored_Offer_Price` into the pricing-agent + H2 outreach-fire path (~30 line change, unblocks V2.1 pricing discipline visibility)
2. **Phase 12.1 + 12.2** — provision `VERCEL_API_TOKEN` + `GITHUB_PAT` env vars (no code change, immediate briefing improvement)
3. **Phase 12.6** — Airtable concurrent-source contention mitigation (directly relieves Gate 5 P95 overshoot)
4. **Phase 11.1 fix** — Quo quiet-vs-down false-negative (Maverick currently lies about Crier health)
5. **Phase 9.3** — Named-agent vocabulary in code attribution (foundation for Phase 9.4 + Phase 13)
6. **Phase 9.1 + 9.2** — Shepherd panel + priority surface BroCards (Daily UX Spec's foundational UX shift)

Items 1-4 are low-effort high-leverage fixes that should land before any Phase 9 dashboard rework begins. Items 5-6 begin the dashboard rework proper.

---

*Document v1.1 — Code-audited May 16, 2026. Living Artifact. The next version is written when a Claude session refreshes status against repo state, when new items get inserted via the insertion log, or when phases complete and procedural focus shifts.*