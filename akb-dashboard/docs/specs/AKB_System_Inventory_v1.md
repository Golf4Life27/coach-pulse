# AKB INEVITABLE — SYSTEM INVENTORY v1

**Document version:** v1.0
**Authored:** May 16, 2026 (Code, Days 6-7 audit)
**Status:** Companion to `AKB_MASTER_CHECKLIST.md`. Inventories every named component across Constitution + Continuity Layer Spec v1.2 + three Maverick specs against actual repo state.
**Companion specs:** `AKB_MASTER_CHECKLIST.md`, `AKB_Dashboard_Current_State_v2.md`, `Inevitable_Continuity_Layer_Spec_v1.2.md`, `Maverick_Character_Spec_v1.md`, `Maverick_Daily_UX_Spec_v1.md`, `Maverick_Capability_Absorption_Reference_v1.md`

---

## Why this document exists

Alex's "what fills the funnel?" question on 5/15 revealed a gap: the system has rich vocabulary (Sentinel, Crier, Sentry, Forge, Scribe, Scout, Pulse, Appraiser, Ledger, Maverick) but no single document showing **which named components are actually shipped, which are partially built, which are specced-only, and which are vision-only.**

This inventory answers that question. Each named entity gets a row with:

- **Spec source** — where the entity is defined
- **Code location** — where (if anywhere) it exists in the repo
- **Status** — vision / specced / partially-built / built / working / broken
- **Attribution mismatch** — does the spec name match the code's `@agent:` tag?
- **Gap** — what's missing for full named-agent realization

Status values:
- **VISION** — described in long-form spec but no formal interface or implementation
- **SPECCED** — formal spec exists with interfaces / behaviors / scope, no code
- **PARTIALLY BUILT** — some code exists, behavior incomplete, attribution inconsistent
- **BUILT** — code shipped, attribution coherent, in production
- **WORKING** — built + validated in production traffic
- **BROKEN** — known bad state, listed in v1.2 backlog or Checklist findings

---

## 1. The named-agent roster (Continuity Layer Spec §6)

The canonical roster from Spec v1.2. Each agent is a logical role; multiple code modules can implement one agent's behavior.

### Attribution audit finding (CRITICAL)

**Zero code attributions use the canonical roster names.** `grep -rni "@agent: sentinel\|@agent: crier\|@agent: sentry\|@agent: forge\|@agent: scribe\|@agent: scout\|@agent: pulse\|@agent: appraiser\|@agent: ledger"` returns no matches. Existing attribution uses operational tags: `maverick`, `phase4c`, `d3-cadence`, `agent-prior-counts`, etc.

This is the load-bearing gap. The Daily UX Spec §4.2 "factory floor with named-agent rooms" cannot map onto a codebase that doesn't tag work by roster name. **Phase 9.3 in the Checklist (inserted 5/16) closes this gap and must precede Phase 9.4 named-agent room rendering.**

### Per-agent inventory

#### Sentinel — Intake (PARTIALLY BUILT)

**Spec sources:** Continuity Layer Spec §6 row 1 + Daily UX Spec §4.2 + Character Spec §2 (Shepherd watches the perimeter)

**Owns:** PropStream ingestion → Listings_V1 record creation, NEVER-list enforcement, dedup, listing verification, multi-listing detection

**Code that implements Sentinel's behavior:**
| Component | Path | State |
|---|---|---|
| Make Scenario A (intake_loader) | Make 4256273 | LIVE — KEEP per Phase 20.1 |
| Make Scenario B (listing_verification) | Make 4331170 | LIVE with 4 pending fixes (Checklist 1.4-1.7) |
| Vercel intake mirror | `app/api/process-intake/route.ts` | BUILT |
| Vercel verify-listing companion | `app/api/verify-listing/route.ts` | BUILT — writes Execution_Path |
| Multi-listing detector | `app/api/multi-listing-detect/route.ts` | BUILT |
| NEVER-list enforcement | Filter in process-intake + Scenario A | WORKING |
| Bulk-dead annotation | `lib/bulk-dead-annotation.ts` | WORKING (1,093 records classified) |

**Attribution mismatch:** Yes. None of these code paths emit `@agent: sentinel` audit events.

**Gap:** Sentinel-as-a-named-entity exists only in vocabulary. The funnel-monitoring Sentinel from Phase 13.1 (briefing-routine surfacing inventory state) is NOT BUILT. PropStream automation (Crawler 1.0) is VISION.

---

#### Crier — SMS dispatch (PARTIALLY BUILT)

**Spec sources:** Continuity Layer Spec §6 row 2 + Daily UX Spec §4.2 + Character Spec §3 (Crier is dark — Quo unresponsive)

**Owns:** Quo `/v1/messages` API, send-rate throttle, outbound cadence, deliverability monitoring, reply routing

**Code that implements Crier's behavior:**
| Component | Path | State |
|---|---|---|
| Quo API wrapper | `lib/quo.ts` (227 LOC) | WORKING |
| Outreach fire | `app/api/outreach-fire/route.ts` | WORKING |
| Outreach safety check | `app/api/outreach-safety-check/route.ts` | WORKING |
| Make H2 outreach scenario | Make 4724197 | LIVE — retires when Acquisition Agent ships + 30d stability |
| Make L3 reply triage | Make 4812756 | LIVE — KEEP forever per Phase 20.1 |
| Make L4 outbound capture | (Make scenario) | LIVE — KEEP forever per Phase 20.1 |
| Quo throttle (15/hour) | NOT BUILT | SPECCED (Checklist 2.8) |
| Cadence_Queue async dispatch | NOT BUILT | SPECCED (Checklist 2.9) |
| Mark-texted endpoint | `app/api/mark-texted/route.ts` | BUILT |

**Attribution mismatch:** Yes. Outreach-fire writes audit entries but not as `@agent: crier`.

**Gap:** Throttle + Cadence_Queue are the load-bearing missing pieces. Quo currently fires send-by-send without rate-control, which is why 15/hour is "recommended but not enforced."

**Known broken:** `external_quo` source reports `api_responsive: false` on quiet windows (Finding #6 / Checklist 11.1). Crier looks dead in Maverick's briefing when it's actually just idle.

---

#### Sentry — Gate enforcement (BUILT — UNNAMED)

**Spec sources:** Continuity Layer Spec §6 row 5 + AKB_Deal_Flow_Orchestrator_Spec (separate doc)

**Owns:** 5-gate pipeline gating (pre-outreach, pre-send, pre-negotiation, pre-contract, pre-close), check enforcement, attribution of blocks

**Code that implements Sentry's behavior:**
| Component | Path | State |
|---|---|---|
| Gate-runner | `lib/orchestrator/gate-runner.ts` | WORKING — emits composite audit per spec §6 |
| Pre-outreach checks | `lib/orchestrator/pre-outreach-checks.ts` | WORKING |
| Pre-send checks | `lib/orchestrator/pre-send-checks.ts` | WORKING |
| Pre-negotiation checks | `lib/orchestrator/pre-negotiation-checks.ts` | WORKING |
| Pre-contract checks | `lib/orchestrator/pre-contract-checks.ts` | PARTIALLY BUILT — 18 items waiting on DocuSign MCP (now unblocked per 5.4) |
| Gate status endpoint | `app/api/orchestrator/gate-status/[recordId]/route.ts` | BUILT |
| Run-gate endpoint | `app/api/orchestrator/run-gate/route.ts` | BUILT |
| Types | `lib/orchestrator/types.ts` | DEFINED |

**Attribution mismatch:** Yes. Gate-runner emits to audit log but lacks the `@agent: sentry` tag.

**Gap:** Sentry is **the most-built-yet-most-unnamed** entity. The implementation is mature; the naming layer is missing. Phase 9.3's rename pass closes this — likely a 1-day refactor.

---

#### Forge — Outreach drafting (PARTIALLY BUILT)

**Spec sources:** Continuity Layer Spec §6 row 4 + Daily UX Spec §4.2 (drafts staged for Crier; depth-aware template selection)

**Owns:** Outbound message template selection, voice-library state, depth-aware template variant choice

**Code that implements Forge's behavior:**
| Component | Path | State |
|---|---|---|
| Outreach script (canonical 3-sentence) | Hardcoded in H2 Make scenario + `outreach-fire` route | DONE |
| Depth-aware template variants | Distributed across outreach-fire path | PARTIALLY BUILT — depth tier exists, "Forge" as orchestrating entity does not |
| Buyer warmup template drafting | `app/api/buyers/warmup-sequence/route.ts` | BUILT — LLM-driven, running daily |
| Draft-followup | `app/api/claude/draft-followup/route.ts` | BUILT |
| Buyer draft-outreach | `app/api/buyers/draft-outreach/route.ts` | BUILT |

**Attribution mismatch:** Yes — emits draft events but not as `@agent: forge`.

**Gap:** Forge's "voice library" concept (distinct from template files) is vocabulary-only. Templates exist but aren't centralized under a Forge namespace.

---

#### Scribe — Contract handling (VISION → SPECCED, NOT BUILT)

**Spec sources:** Continuity Layer Spec §6 row 6 + Daily UX Spec §4.2 + v1.2 finding #8 (Scribe must read DocuSign API directly)

**Owns:** DocuSign envelope state, contract draft generation, signature workflow, redline tracking

**Code that implements Scribe's behavior:**
| Component | Path | State |
|---|---|---|
| Contract auto-draft (Buyer side) | NOT BUILT | NOT STARTED (Checklist 5.3) |
| DocuSign API integration | NOT BUILT | UNBLOCKED — DocuSign MCP now live (Checklist 5.4) |
| Manual contract review process | Alex's manual workflow | WORKING |
| Assignment-clause check | `lib/orchestrator/pre-contract-checks.ts` | BUILT (auto-Sentry side) |
| Pre-contract checks blocked-on docusign_mcp_wire_in | `lib/orchestrator/pre-contract-checks.ts:79` | NOW UNBLOCKED |

**Attribution mismatch:** N/A — Scribe doesn't write audit events yet.

**Gap:** Entire Scribe is unbuilt. With DocuSign MCP just landed in deferred tools (server `ab943441-29da-4bcb-8d3f-19efc0412d6c`, tool schemas `getEnvelope`/`getEnvelopes`/`createEnvelope`/`listRecipients`/`getAgreementDetails`/etc.), the integration is ready when Code prioritizes Scribe build. v1.2 backlog item #8 explicitly notes Scribe must read API not PDF.

---

#### Scout — Buyer pipeline (PARTIALLY BUILT)

**Spec sources:** Continuity Layer Spec §6 row 7 + Daily UX Spec §4.2 (buyer warmth states, recent buy-box captures, matching signals)

**Owns:** Buyers table activity, buyer-deal matching, dispo blast queue, buyer warmup sequences

**Code that implements Scout's behavior:**
| Component | Path | State |
|---|---|---|
| Buyers table schema | Airtable `tbl4Rr07vq0mTftZB` | DONE |
| Buyers v2 lib | `lib/buyers-v2.ts` | BUILT |
| Buyer intake (form-driven) | `app/api/buyers/intake/route.ts` | WORKING |
| Buyer warmup cron | `app/api/buyers/warmup-sequence/route.ts` (daily 13:00 UTC) | WORKING |
| CSV import for buyers | `app/api/buyers/import-csv/route.ts` | BUILT |
| Mark-buyer-emailed | `app/api/mark-buyer-emailed/route.ts` | BUILT |
| Buyer warmth states (cold/warm/active) | In buyers-v2.ts | BUILT |
| Buyer-deal matching | `app/api/buyers/match-to-deal/[recordId]/route.ts` | PARTIALLY BUILT (per-record, not proactive surfacing) |
| Dispo blast (single record) | `app/api/buyers/fire-blast/[recordId]/route.ts` | BUILT |
| Dispo blast queue (G hardening) | NOT BUILT | NOT STARTED (Checklist 4.7) |
| Make Scenario G (dispo) | Make 4583609 | LIVE — retires when Dispo Agent ships |

**Attribution mismatch:** Yes — buyer-related routes emit audit events but not as `@agent: scout`.

**Gap:** Scout-as-proactive-matcher (Daily UX Spec §4.2 "matching signals when a buyer fits a deal") is unbuilt. Match-to-deal is a passive per-record endpoint, not a proactive surfacer in the briefing.

---

#### Pulse — System self-monitoring (PARTIALLY BUILT, mostly VISION)

**Spec sources:** Continuity Layer Spec §6 row 8 + §5 Step 5 + Capability Absorption Reference §4

**Owns:** Routines firing, drift detection, capability state, quota burns, periodic introspection, BroCard-proposed updates

**Code that implements Pulse's behavior:**
| Component | Path | State |
|---|---|---|
| RentCast burn-rate | `lib/maverick/rentcast-burn-rate.ts` | WORKING (cross-source synthesis live in briefing) |
| Quo burn-rate | NOT BUILT | NOT STARTED (Checklist 14.3) |
| Anthropic API burn-rate | NOT BUILT | NOT STARTED (Checklist 14.3) |
| Drift detection (audit patterns) | NOT BUILT | NOT STARTED (Checklist 14.2) |
| Confidence threshold model | NOT BUILT | SPECCED (Checklist 14.1) |
| Model registry monitoring | NOT BUILT | SPECCED (Spec v1.2 §6.9 Phase 2) |
| Cross-context recall surfacing | NOT BUILT | VISION (Joe Schmoe capability) |
| Family-time signal awareness | NOT BUILT | VISION |

**Attribution mismatch:** N/A — Pulse doesn't write audit events yet.

**Gap:** Foundation is laid (burn-rate calc pattern, `maverick_recall` MCP tool), but Pulse-as-a-recurring-routine isn't running. No scheduled cron writes a Pulse audit event. The Capability Absorption Reference §4 describes Pulse as the runner of the absorption pattern — currently a manual Code-session process.

---

#### Appraiser — Valuation (BUILT — UNNAMED)

**Spec sources:** Continuity Layer Spec §6 row + Daily UX Spec §4.2 (ARV calculations, Pricing Agent work, RentCast quota)

**Owns:** ARV computation per ZIP, rehab calibration, comp pulls, pricing math discipline

**Code that implements Appraiser's behavior:**
| Component | Path | State |
|---|---|---|
| ARV Intelligence Engine (per ZIP) | `app/api/arv-intelligence/[zip]/route.ts` | WORKING |
| ARV validation | `app/api/arv-validate/[recordId]/route.ts` | BUILT |
| Pricing Intelligence | `app/api/pricing-intelligence/[zip]/route.ts` | BUILT — emits `@agent: phase4c` |
| Pricing Agent (Phase 4 orchestration) | `app/api/agents/pricing/[recordId]/route.ts` | WORKING — runs Phase 4A + 4B + 4C |
| Rehab Calibration | `app/api/rehab-calibration/route.ts` | BUILT — BBC 5-tier × per-market |
| Two-Track BroCard | `components/TwoTrackPricing.tsx` (351 LOC) | BUILT |
| ARV intelligence lib | `lib/arv-intelligence.ts` | BUILT |
| Rehab calibration lib | `lib/rehab-calibration.ts` | BUILT |
| Pricing math lib | `lib/pricing-math.ts` | BUILT |
| Highland validation | `app/api/agents/validation/highland/route.ts` | BUILT |
| Sturtevant validation | `app/api/agents/validation/sturtevant/route.ts` | BUILT |
| Phase 4D unified `/api/deal-math/[recordId]` | NOT BUILT | NOT STARTED (Checklist 3.11a) |

**Attribution mismatch:** Yes — uses `@agent: phase4c` instead of `@agent: appraiser`.

**Gap:** Appraiser is **the second-most-built-yet-unnamed** entity. Mature implementation, broken naming. Live briefing audit tonight showed `phase4c` agent firing in last 24h, confirming production usage.

---

#### Ledger — Economics (VISION, NOT BUILT)

**Spec sources:** Continuity Layer Spec §6 row + Daily UX Spec §4.2 + Constitution §7 (lane purity) + Character Spec §5.1 (no Whitetail)

**Owns:** Revenue per deal, agent cost attribution, truck fund tracking, wife retirement progress, deal-by-deal P&L

**Code that implements Ledger's behavior:**
| Component | Path | State |
|---|---|---|
| Revenue tracking per deal | NOT BUILT | NOT STARTED |
| Agent cost attribution (LLM spend) | NOT BUILT | NOT STARTED |
| Truck fund tracking | NOT BUILT | NOT STARTED |
| Wife retirement progress meter | NOT BUILT | NOT STARTED |
| Deal-by-deal P&L cards | NOT BUILT | NOT STARTED |
| Lane purity (Whitetail excluded) | Enforced by NOT-building, not by code check | LOCKED IN SPEC |

**Gap:** Entirely unbuilt. Earliest reasonable build moment: after deal #1 ships and there's revenue to ledger.

---

#### Maverick — Overseer (BUILT — CORRECTLY NAMED)

**Spec sources:** Continuity Layer Spec v1.2 (entire doc) + Character Spec + Daily UX Spec §3 (Shepherd panel)

**Owns:** State aggregation, narrative synthesis, MCP server, write_state + recall tools, audit-log integration, capability absorption

**Code that implements Maverick's behavior:**
| Component | Path | State |
|---|---|---|
| 9 source fetchers | `lib/maverick/sources/*.ts` | WORKING |
| Aggregator | `lib/maverick/aggregator.ts` | WORKING |
| Template renderer | `lib/maverick/template.ts` | WORKING |
| Synthesizer | `lib/maverick/synthesize.ts` | WORKING (Sonnet 4.6; Day 8+ refactor to Opus 4.7 per §6.9) |
| MCP server route | `app/api/maverick/mcp/route.ts` | WORKING |
| MCP protocol primitives | `lib/maverick/mcp/protocol.ts` | BUILT |
| MCP tools | `lib/maverick/mcp/tools.ts` (3 tools) | BUILT |
| MCP handlers | `lib/maverick/mcp/handlers.ts` | BUILT |
| write_state | `lib/maverick/write-state.ts` | WORKING (append-only per §6.4) |
| recall | `lib/maverick/recall.ts` | WORKING |
| OAuth subsystem | `lib/maverick/oauth/*.ts` (8 modules) + 6 routes | WORKING |
| Discovery endpoints | `app/.well-known/oauth-*/route.ts` | WORKING |
| Self-instrumentation | `lib/maverick/mcp-latency.ts` | WORKING (first sample over target tonight — Checklist 6.13) |
| RentCast burn-rate | `lib/maverick/rentcast-burn-rate.ts` | WORKING |
| Shepherd panel UI | NOT BUILT | NOT STARTED (Checklist 9.1) |
| German Shepherd avatar | NOT BUILT | NOT STARTED (Checklist 9.9) |

**Attribution match:** YES — emits `@agent: maverick`. Canonical.

**Gap:** Maverick the backend exists and works (Gate 3 closed 5/15 evening). Maverick the visual presence on the dashboard does not exist yet. Daily UX Spec §3.1 "Shepherd panel on every page" is the highest-leverage UI build (Checklist 9.1).

---

## 2. Non-roster components (infrastructure + workflow)

Things in the system that aren't named agents but are operationally load-bearing.

### Make.com scenarios

Per Phase 20.1 retirement plan (resolved 5/16):

| Scenario | ID | Disposition | State |
|---|---|---|---|
| A — Intake | 4256273 | KEEP forever* | LIVE |
| B — Verification | 4331170 | KEEP forever* (4 fixes pending) | LIVE |
| H2 — Outreach | 4724197 | Retire when Acquisition Agent ships | LIVE |
| L3 — Reply triage | 4812756 | KEEP forever | LIVE |
| L4 — Outbound capture | (id) | KEEP forever | LIVE |
| G — Dispo blast | 4583609 | Retire when Dispo Agent ships | LIVE (hardening pending — Checklist 4.7) |
| J — Verify agent | 4724499 | Retire when Negotiation Agent ships | LIVE |
| I — Rehab estimation | (id) | RETIRED — replaced by Pricing 4B subroutine | DEPRECATED |
| K — ARV calc | (id) | RETIRED — replaced by Pricing 4A subroutine | DEPRECATED |

\* Spec v1.2 line 257 contradicts §9 on A + B's long-term fate. Sub-question logged in Phase 20.1 Resolution Log.

### Vercel cron routines

From `vercel.json`:

| Path | Schedule | What it does |
|---|---|---|
| `/api/cron/propose-actions` | 09:00 UTC daily | Surfaces proposed actions for Alex |
| `/api/cron/scan-comms` | 10:00 UTC daily | Scans inbound comms |
| `/api/scan-replies` | 11:00 UTC daily | Reply triage scan |
| `/api/buyers/warmup-sequence` | 13:00 UTC daily | Buyer warmup emails |
| `/api/admin/recompute-agent-prior-counts` | 08:00 UTC daily | Path Y — agent prior count recompute (replaces broken Make populator) |

All daily-cron-only per Vercel Hobby plan cap (per AGENTS.md). Pulse routine (Phase 14) will eventually run as a 6th daily cron.

### External services

| Service | Status | Notes |
|---|---|---|
| Quo (`PNLosBI6fh`) | LIVE | Phone 815-556-9965, carrier registration paid |
| RentCast API | WORKING | Live briefing shows 1000-cap, 16 days to reset, ~0 burn |
| Vercel KV (Upstash Redis) | WORKING | Audit log + OAuth token storage |
| Airtable | WORKING (under contention — see Phase 12.6) | Base `appp8inLAGTg4qpEZ` |
| Gmail API | BUILT | `lib/gmail.ts` exists, used by gate-runner |
| Anthropic API | WORKING | Sonnet 4.6 current (Opus 4.7 deferred to Day 8+) |
| DocuSign MCP | LIVE — NOT WIRED | Server `ab943441-29da-4bcb-8d3f-19efc0412d6c`. Tools surfaced as deferred in this session |
| InvestorBase | EXTERNAL | Manual CSV export ~50/week (Checklist 3.4 bottleneck) |
| PropStream | EXTERNAL | Manual CSV export (Checklist 1.1 bottleneck) |

### Intake pipeline current state (Checklist item 8.4)

**What fills the funnel today:**
1. Alex manually runs PropStream exports (~weekly, manual CSV pulls)
2. CSV uploaded → triggers Make Scenario A (4256273) → records land in Listings_V1
3. Scenario A filters: Poor/Disrepair/Average condition, $3.5K-$250K, regex phone validation, NEVER-list filter, wholesale-restrictive-state filter (IL/MO/SC/NC/OK/ND blocked)
4. Records flow to verification: Make Scenario B (4331170) + Vercel `verify-listing` route writes `Execution_Path`
5. Records hitting `Execution_Path = "Auto Proceed"` queue for H2 outreach

**What's manual:**
- PropStream CSV pulls (Checklist 1.1)
- Scenario B has 4 unbuilt fixes (off-market detection, flip scoring, DOM check, phone validation — Checklist 1.4-1.7)
- 890 records have singleSelect/formula mismatch awaiting bulk cleanup (Checklist 1.10)

**What's automated:**
- Scenario A intake filtering (live)
- Vercel-side companion routes for verify + process-intake
- Dead-record auto-classification (working — 1,093 records classified)
- NEVER-list enforcement (live)
- H2 outreach fire on `Auto Proceed` records (live)

**What's specced but not built:**
- Crawler 1.0 — full on-market MLS automation (Checklist 13.5)
- Crawler 2.0 — off-market motivated seller pipeline (Checklist 13.6)
- PropStream API/scraping replacement (Checklist 13.3)
- Sentinel-as-briefing-routine (Checklist 13.1)
- Sentinel inventory-low triggers (Checklist 13.2)
- Geographic expansion logic (Checklist 13.4)

---

## 3. Test surface inventory

Total: **31 test files, 397 tests passing** (as of commit `44f504e`, Day 5).

By area:

| Area | Test files | Test count (approx) |
|---|---|---|
| Maverick OAuth | 7 | 95 |
| Maverick sources (9 fetchers) | 9 | ~150 |
| Maverick aggregator + synthesizer | 4 | ~40 |
| Maverick MCP (handlers/tools/protocol) | 3 | ~50 |
| Maverick recall + write-state + latency | 3 | ~40 |
| Maverick template + timeout | 2 | ~15 |
| Non-Maverick libs (D3 cadence, prior counts, bulk-dead) | 3 | ~7 |
| **Total** | **31** | **397** |

CI state: `unknown` per live briefing (no GITHUB_PAT to query checks).

---

## 4. Cross-spec coherence audit

How the named-agent roster maps across the four canonical specs:

| Agent | Continuity Layer §6 | Character Spec §3 voice example | Daily UX Spec §4.2 room | Code attribution |
|---|---|---|---|---|
| Maverick | overseer | First-person reference | Persistent Shepherd panel | ✓ `@agent: maverick` |
| Sentinel | intake | (referenced generically) | Sentinel — Intake room | ✗ uses functional tags |
| Crier | SMS dispatch | "Crier is dark — Quo unresponsive" | Crier — SMS dispatch room | ✗ unnamed |
| Sentry | gate enforcement | (referenced generically) | Sentry — Gate enforcement room | ✗ unnamed in `lib/orchestrator/` |
| Forge | outreach drafting | (mentioned) | Forge — Outreach drafting room | ✗ unnamed |
| Scribe | contract handling | (mentioned) | Scribe — Contract handling room | ✗ NOT BUILT |
| Scout | buyer pipeline | (mentioned) | Scout — Buyer pipeline room | ✗ unnamed |
| Pulse | system self-monitoring | (mentioned) | Pulse — System health room | ✗ mostly NOT BUILT |
| Appraiser | valuation | (mentioned) | Appraiser — Valuation room | ✗ `@agent: phase4c` etc. |
| Ledger | economics | (mentioned) | Ledger — Economics room | ✗ NOT BUILT |

**Five of nine non-Maverick agents have working code that just isn't named.** Closing the attribution gap is a low-risk, high-coherence rename pass (Checklist 9.3 + 9.11 — estimated 1-2 days).

---

## 5. Build-state summary

Of the 10 named-agent entities:
- **1 BUILT and correctly named:** Maverick
- **2 BUILT but unnamed:** Sentry (orchestrator family), Appraiser (Phase 4 family)
- **3 PARTIALLY BUILT and unnamed:** Sentinel (intake routes), Crier (Quo + outreach), Scout (buyers)
- **1 PARTIALLY BUILT vision-heavy:** Pulse (RentCast burn-rate only)
- **1 PARTIALLY BUILT specced:** Forge (templates exist, voice library doesn't)
- **2 NOT BUILT:** Scribe (DocuSign MCP now ready), Ledger (post-deal-#1)

The biggest leverage gap: **dashboard surfaces are blind to the work the named agents are doing.** Sentry runs continuously but has no visible "Sentry room." Appraiser computes prices on demand but the dashboard shows Two-Track BroCards without crediting Appraiser. The functional layer is well-built; the experiential layer (Daily UX Spec) needs Code's Day 8+ work.

---

## 6. Recommendations for Day 8+ work

(Full sequence detailed in `AKB_MASTER_CHECKLIST.md` Phase 9. Highlights here:)

**Low-effort high-leverage prerequisites (land before Phase 9 proper):**
1. Phase 11.4 — wire `Stored_Offer_Price` into pricing-agent + H2 paths (~30 LOC)
2. Phase 12.1 + 12.2 — provision `VERCEL_API_TOKEN` + `GITHUB_PAT` (no code)
3. Phase 12.6 — Airtable concurrent-source contention mitigation (small refactor in aggregator)
4. Phase 11.1 — Quo quiet-vs-down false-negative fix (small change in `external-quo` source)

**Phase 9 dashboard rework sequence:**
1. Phase 9.3 — Named-agent vocabulary in code attribution (foundational)
2. Phase 9.11 — Jarvis→Maverick rename of legacy components (parallel cleanup)
3. Phase 9.1 — Shepherd panel (Daily UX Spec §3.1)
4. Phase 9.2 — Priority surface BroCards wired to Maverick (highest user-visible leverage)
5. Phase 9.4 — Named-agent rooms (start with Crier — most-stable component to render)
6. Phase 9.5 — Severity tier visual treatment
7. Phase 9.8 — Deal-detail Maverick commentary + related-deal recall (uses `maverick_recall` MCP tool)
8. Phase 9.7 — Out-of-band SMS escalation
9. Phase 9.6 — Live motion / animation
10. Phase 9.9 — German Shepherd avatar

**Day 8-N estimate:** Phase 9 is a 2-3 week build at minimum. Bigger than the Maverick backend (Days 1-5). Plan accordingly.

---

*Inventory v1.0 — May 16, 2026. Living Artifact. Refresh status values when Phase 9 build lands, Phase 13 Sentinel ships, or Phase 20.1's A+B sub-question resolves. The next version is written by Code after the named-agent vocabulary rename closes the attribution gap.*