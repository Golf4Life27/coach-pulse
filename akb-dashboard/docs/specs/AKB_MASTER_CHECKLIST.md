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
| 3.2 | V2.1 negotiation pricing (`Investor_MAO = Buyer_Median − Est_Rehab`) | DONE | CRITICAL | Per Spine 65% Rule + Offer Discipline. (5/18 rename: `Buyer_Tx_Median` → `Buyer_Median` — Tx prefix was Texas-only launch artifact; system is nationwide. No active code or Airtable formula referenced the old name — current Investor_MAO formula on Listings_V1 uses Real_ARV_Median (fldoNZxSZqQsCLIW6). This row was the only stale ref in the repo. INEVITABLE_Constitution_v3.docx + Make scenarios J/G/D may still carry the old token — flagged as Phase 12.8.) |
| 3.3 | <20 priced transactions = Manual Review gate | DONE | CRITICAL | Sentry enforces. (CODE 5/16: enforced in `lib/orchestrator/pre-send-checks.ts` family) |
| 3.4 | InvestorBase per-property CSV exports | DONE (manual) | HIGH | ~50/week bottleneck, no API yet |
| 3.5 | RentCast API integration (AS-IS value) | DONE | CRITICAL | Key in password manager, NOT for ARV. (CODE 5/16: live briefing shows `api_responsive: true`, monthly cap 1000, 16 days until reset, ~0 burn) |
| 3.6 | Buy Box Cartel buyer max offer reference | DONE | HIGH | Empirical anchoring, no universal multiplier |
| 3.7 | HARD RULE: no fabricated multipliers | DONE | CRITICAL | Locked after 4/26 80% MAO near-disaster |
| 3.8 | OfferPrice stickiness (no auto-revise down on seller moves) | DONE | CRITICAL | Per memory |
| 3.9 | Buyer-facing comms: show ONE number only | DONE | CRITICAL | Never disclose spread/fee/contract price |
| 3.10 | `stored_offer_price` field on Listings_V1 | **WRITES PARTIAL** | CRITICAL | (CODE 5/16: status corrected. Field IS written by `app/api/admin/d3-backfill-offer-fields/route.ts` admin one-shot route. NOT written on the live H2 outreach-fire path — that's the broken-discipline finding (Finding #9 / item 11.4). Live briefing's `active_deals` was empty tonight so could not validate in-flight values, but Phase 4 pricing route computes Your_MAO without persisting to Stored_Offer_Price.) |
| 3.11 | Phase 4 — Hyper-Local Math Layer | **PARTIALLY BUILT** | HIGH | (CODE 5/16: status corrected from "LOCKED, NOT STARTED" — Phase 4A + 4B + 4C have shipped. `app/api/agents/pricing/[recordId]/route.ts` orchestrates all three with computeDualTrackPricing. `app/api/arv-intelligence/[zip]/route.ts` ARV engine live. `app/api/rehab-calibration/route.ts` rehab tier engine live. Live briefing audit shows `phase4c` agent fired in last 24h. Phase 4D `/api/deal-math/[recordId]` and Phase 4E BroCard render NOT YET — see new items 3.11a + 3.11b below.) |
| 3.11a | Phase 4D — Unified Deal Math endpoint (`/api/deal-math/[recordId]`) | **NOT STARTED** | HIGH | (CODE 5/16: INSERTED. Pricing-route is per-record but not the canonical `/api/deal-math/` namespace endpoint specced in Phase 3.11.) (5/18 v1.3 amendment per Alex: endpoint must return a **range** `[V2.1 floor, seller-motivation-adjusted target]`, not a single number. 65% opens the door; DD reveals whether to drop to ~61% (worse rehab) or push to ~71% (clean deal, motivated seller). V2.1 math is the never-go-below floor; `Seller_Motivation_Score` field (1-5 rubric, new 5/18) is the modifier. Returned shape: `{ floor: number, target: number, list_price: number, modifier_inputs: { motivation_score, rehab_confidence, ... } }`. BroCard render (3.11b) must surface the range, not collapse it.) |
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
| 4A.1 | Appraiser ARV endpoint (standalone) + v1.3 MAO range envelope | **DONE** | HIGH | (CODE 5/18 Commit I.) Sub-commits: I.1 (`9471dc7`) endpoint + helpers + lib mappings + 18 tests; I.2+I.3 (`e4e281b`) briefing aggregator wire (ListingsActiveDeal +5 ARV fields with freshness classification) + Appraiser room ARV coverage section + deal-detail ARV panel with comps table. **Architecture:** standalone GET `/api/agents/appraiser/arv/[recordId]` separate from the Pricing Agent's 4A/4B/4C composition — both coexist this sprint per Alex's "eventually retire K's write-back logic so Vercel owns all writes" framing. **Math:** `lib/appraiser/mao-range.ts` pure helpers — `classifyArvConfidenceByCount` (HIGH 5+, MED 3-4, LOW <3 → Manual Review per Phase 4A.1 spec, separate from `lib/arv-intelligence.ts`'s internal cluster-quality rubric which stays in audit) + `computeMaoRange` returning v1.3 envelope `{ floor, target, list_price, soft_ceiling, exceeds_soft_ceiling, modifier_inputs }`. Floor = MAX(arv_mid − est_rehab − wholesale_fee, 0). Target = floor in Phase 4A.1 — seller-motivation-modifier formula deferred to Phase 13 (Sentinel auto-fills `Seller_Motivation_Score`). Soft ceiling = 75% of List per spec. **Airtable writes:** Real_ARV_Low/High/Median, ARV_Confidence, ARV_Comp_Count, ARV_Comp_Avg_PrSqFt, ARV_Comp_Details_JSON (capped 95K chars), ARV_Validated_At. Skippable via `?skip_write=1`. **Validation anchor:** 1219 E Highland Blvd 78210 with ARV $165K + Rehab $60K + default Wholesale $15K → MAO floor $90K (locked in `lib/appraiser/mao-range.test.ts`). **UI surfaces:** Appraiser factory-floor room shows ARV coverage rollup across active deals (current / stale >30d / missing / LOW conf) with tier 1 override when any LOW-confidence deal exists; deal-detail page renders ARV panel with V2.1 floor + comp count + avg $/sqft + click-to-expand comps table + "Run ARV" / "Refresh" action + soft-ceiling caution flag. Held: I.4 wrap (THIS commit — Checklist transitions only, no code). |

---

## Phase 5 — Contract & Closing (Scribe) Layer (FORWARD)

| # | Item | Status | Severity | Notes |
|---|------|--------|----------|-------|
| 5.1 | DocuSign account + workflow established | DONE | CRITICAL | Receiving envelopes from sellers' agents |
| 5.2 | Manual contract review process | DONE | CRITICAL | Working today — tonight's 23 Fields review caught redline gap |
| 5.3 | Contract auto-draft (Buyer side) | NOT STARTED | HIGH | |
| 5.4 | DocuSign API integration | **DONE — live data pending DOCUSIGN_* env provisioning** | HIGH | (CODE 5/18 Commit G.) Phase 5 Scribe foundation shipped. **Correction:** the string `ab943441-29da-4bcb-8d3f-19efc0412d6c` referenced in `lib/orchestrator/pre-contract-checks.ts` and earlier checklist notes as the "DocuSign MCP server UUID" is actually Alex's DocuSign **account_id** (verified live via `getUserInfo`). The MCP server UUID is `e1ba5bca-4a68-49ef-8d49-3d9708fda8e8`. Conflation came from 5/13 announcement notes; nothing functional broke. **Architecture (Path A — JWT, chosen via decision question 5/18):** production talks to DocuSign REST API v2.1 directly via hand-rolled JWT bearer auth in `lib/docusign.ts`. No new npm deps (Node `crypto.createSign` RS256). DocuSign MCP is used only for Claude-side development inspection, not by production code. **Live calls require Alex to provision** `DOCUSIGN_INTEGRATION_KEY` + `DOCUSIGN_USER_ID` + `DOCUSIGN_PRIVATE_KEY` (Phase 12.7 below); until then, the new `lib/maverick/sources/external-docusign.ts` source returns `configured: false` cleanly and the Scribe surfaces render "Standing by — DocuSign credentials pending" without erroring. **22 client tests** cover JWT signing shape, envelope/recipient classifiers, summarizeEnvelope (pending recipient + awaiting hours + awaiting_is_alex), rollupEnvelopes (counts + max awaiting). `lib/orchestrator/pre-contract-checks.ts:79` `blocked_on: docusign_mcp_wire_in` resolves once Alex provisions JWT creds — pure data-layer unblock from this commit. |
| 5.9 | Scribe room on factory floor | **DONE** | HIGH | (CODE 5/18 Commit G.2 — `ee5acd5`.) `components/factory-floor/ScribeRoom.tsx` replaces the Phase 9.4 Standing-By stub. Reads DocuSign rollup from `BriefingProvider` (one state read, multiple views). Surfaces active count, awaiting-you count + max awaiting hours, signed-7d, voided/dead. Tier overrides per spec: >72h awaiting Alex → tier 3 (Phase 9.7 SMS-escalation eligible); >24h → tier 2. When `configured: false`, room renders "Standing by — DocuSign credentials pending (Phase 12.7)" — accurate empty state, not a fake. Click-through to DocuSign documents index URL when configured. |
| 5.10 | Scribe deal-detail commentary panel | **DONE** | HIGH | (CODE 5/18 Commit G.3.) `components/ScribeDealCommentary.tsx` on `app/pipeline/[id]/page.tsx` alongside MaverickDealCommentary. Three rendering states: (1) envelope tracked + found in briefing → status, awaiting recipient, last-action time, "Open in DocuSign" deep link, "Send reminder" button (only when awaiting a non-Alex recipient), Untrack affordance; (2) envelope tracked but outside the 30-day briefing window → GUID + window-explainer note + Untrack; (3) no envelope tracked → "Track in Scribe" input + Track button. **`/api/maverick/docusign-send-reminder/[envelopeId]`** (POST, dashboard-session auth) wires the reminder action through `sendReminder` from `lib/docusign.ts`; emits `agent=scribe event=envelope_reminder_sent`/`envelope_reminder_failed` audits. All envelope reads come from the shared `BriefingProvider` — no second briefing call path. |
| 5.11 | Listing↔Envelope attribution (Path A — explicit field) | **DONE** | HIGH | (CODE 5/18 Commit G.3.) Path A chosen over Path B (recipient/address heuristics) because GUID match is deterministic and Alex's link discipline beats fuzzy matching. **`Envelope_ID` field created via Airtable MCP** on Listings_V1 (`tbldMjKBgPiq45Jjs`, new field id `fldKPVG9qmbzxW5lK`, type singleLineText, nullable, description references this row). Wired into `LISTING_FIELDS` + `LISTING_NAME_MAP` in `lib/airtable.ts` and the `Listing` type in `lib/types.ts`; 4 test fixtures updated (Phase-11.2-style cascade). **`/api/maverick/track-envelope/[recordId]`** (POST, dashboard-session auth) writes via `updateListingRecord({Envelope_ID})` — accepts a GUID matching RFC 4122 hyphenated regex (paste-from-wrong-clipboard guard) or null (untrack). Emits `agent=scribe event=envelope_tracked`/`envelope_untracked`/`envelope_track_failed` audits. Forward-only — existing in-flight envelopes (e.g., 23 Fields) get backfilled manually by Alex clicking Track once per active deal. |
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
| 9.4 | Named-agent rooms on home page (Sentinel/Crier/Sentry/etc) | **DONE** | HIGH | (CODE 5/17 Commit C — 9.4a foundation + 9.4b rooms.) **9.4a (73f3b81):** `BriefingProvider` React context wraps the dashboard layout inside AuthGate, owns a single visibility-gated poll of `/api/maverick/load-state` (Phase 11.7 convention), shares state with all consumers via `useBriefing()`. ShepherdPanel refactored to a pure view of that context — no second briefing call path anywhere. Briefing schema extended with `audit_summary.recent_events: RecentAuditEvent[]` (cap 50) so rooms can render last-N activity per agent; synthesizer prompt strips this field via `buildRequestBody` to keep the Claude call at its prior token ceiling. **9.4b (2efc7cb):** nine rooms land on the home page above existing surfaces. Pipeline row in workflow order — Sentinel → Sentry → Appraiser → Crier. Support row — Scout (active) + Forge / Scribe / Ledger / Pulse (standing-by stubs). `lib/maverick/agent-room.ts` is the pure projection: tier inference (failures → tier 2, uncertain/success → tier 1, idle → tier 0), recent-events filter capped at 5, `formatRelativeTs` for "5m ago" labels. Room-specific signals elevate via `tierOverride`: Quo unresponsive lifts Crier to tier 2; manual-fix > 0 lifts Sentry to tier 1; RentCast burn ≤7d → Appraiser tier 1, ≤3d → tier 2. Click-through routes wired (Crier→/queue, Sentinel→/pipeline, Sentry→/queue, Appraiser→/pipeline, Scout→/buyers). Stubs accurately render "Standing by" + ship-phase note per spec rule "Empty rooms accurately communicate roster presence + agent inactivity"; the same StandingByRoom auto-upgrades to active rendering when events appear for that agent. 446/446 tests passing (+14 agent-room.ts coverage). Next.js build clean. Held: Phase 9.6 live motion (Commit D), 9.7 SMS escalation (blocked on 12.3), 9.8 deal-detail+recall (Commit D). |
| 9.5 | Severity tier visual treatment (Tier 0/1/2/3) | **DONE (minimum)** | HIGH | (CODE 5/16 Commit B. `lib/maverick/severity.ts` defines `TIER_VISUAL` (border + text + bg + dot + label) for all four tiers. `inferPrioritySignals(briefing)` classifies signals from load-state structured payload: source-down counts, Quo health, RentCast burn rate, MCP P95 over-target, recent_failures, open_decisions, active_deals. Signals sort tier-descending. 17 new tests in `severity.test.ts`. Tier 3 modal + SMS push (Daily UX Spec §5.4) deferred to 9.7 + 12.3.) |
| 9.6 | Live motion / animation (cards flowing between agent stations) | **DONE** | MEDIUM | (CODE 5/17 Commit D.2 — `da7744c`.) Subtle pulse animation on factory-floor rooms when an agent's `audit_summary.by_agent` count increases between briefing polls. Driven by `diffAgentActivity(prev, curr)` (pure helper in `lib/maverick/agent-room.ts`, +5 tests) — returns the set of agents whose count went up; decreases are ignored as window-rollover artifacts. BriefingProvider holds prev counts in a ref, computes the diff on each successful fetch, exposes `pulsedAgents: Set<string>` on context; 1.8s timer auto-clears. AgentRoom consumes the set, sets local `pulsing` boolean, removes after 1.6s (local timer prevents re-render restart). CSS `@keyframes maverick-agent-pulse` in `globals.css` — 2px upward translate + emerald glow ring, 1.6s ease-out. Animation lives entirely inside `@media (prefers-reduced-motion: no-preference)` — reduced-motion users see the same DOM with the pulse class but no rendering, no fallback class swap needed. Subtle by design; only fires on real state transitions, never decorative. |
| 9.7 | Out-of-band SMS escalation (Stage 4 → Alex's phone) | **DONE (A2P pending at carrier)** | HIGH | (CODE 5/18 Commit E.) Phase 12.3 unblocked this — Alex's personal escalation number `+16302505865` is live in the Quo workspace; A2P 10DLC registration is pending at the carrier (1-7 days typical), so outbound SMS will queue at Quo and hold at the carrier until A2P clears. No code changes needed when A2P clears; alerts simply start delivering. **Architecture:** `lib/maverick/sms-escalation.ts` is the orchestrator — pure helpers (`deriveSignalKey`, `formatStage4Message`, `parseDailySends`, `pruneRecentSends`, `tierThreeSignalsFrom`) + DI'd `evaluateStage4Escalation`. Trigger surface: synchronous after-briefing hook fired only when `authKind === "dashboard_session"` OR `"oauth"` — wired into both `app/api/maverick/load-state/route.ts` (dashboard fetches) and `app/api/maverick/mcp/route.ts` via a new `HandlerDeps.onLoadStateBriefing` callback (MCP OAuth tools/call). Cron + bearer_dev + none are no-ops inside the evaluator (defense-in-depth with the existing Phase 11.6 cron gate). **No new cron-fired endpoints**, no polling — runs on user-triggered briefing refreshes only. **Dedup:** per-signal-key KV entry (`mav:sms:signal:<key>`) with TTL = cooldown minutes; same signal across consecutive briefings → at most one SMS. Default 30-min cooldown, env override via `MAVERICK_SMS_PER_SIGNAL_COOLDOWN_MIN`. **Rolling cap:** JSON-encoded send-timestamp list at `mav:sms:daily:sends` with 24h TTL; `pruneRecentSends` filters to the rolling 24h window on each evaluation. Default cap 5 SMS / 24h, env override via `MAVERICK_SMS_DAILY_CAP`. **Suppressions:** every cooldown-hit or cap-hit emits `agent=maverick event=sms_rate_limited` audit with `inputSummary.reason ∈ {cooldown, daily_cap}` — Phase 14 Pulse breadcrumb pattern. **Sends:** `agent=crier event=sms_escalation_sent` with `externalId=quo_message_id` for the future delivery-verification loop. **Failures:** `agent=crier event=sms_escalation_failed` with full error context; Quo API exceptions never bubble to the load-state response; KV cooldown is NOT written on failure so the next briefing retries cleanly. **Quo integration:** reuses existing `sendMessageWithId(to, content)` in `lib/quo.ts` — sender is `QUO_PHONE_ID` (Crier outbound number), recipient is `MAVERICK_STAGE4_SMS_TARGET` (default `+16302505865`). **Message shape (per spec):** `"🐕 Maverick — TIER 3\n<headline>\n<reason>\n@AGENT"`. 26 tests covering auth gating, tier filtering, dedup, cap, failure handling, audit telemetry. Total suite 492/492. **A2P delivery status:** Quo dashboard exposes registration progress — Alex monitors carrier-side approval; until it clears, alerts queue at Quo (visible in workspace inbox) but don't fan out to the carrier. |
| 9.8 | Deal-detail page enhancements (Maverick commentary, related-deal recall) | **DONE** | HIGH | (CODE 5/17 Commit D.1 — `9e85757`.) Anchored to 251 Cliffwood reference (and any deal). **Commentary panel:** `lib/maverick/deal-commentary.ts` is a pure deterministic projection (+15 tests) — filters briefing's `recent_events` by `recordId`; layers Crier-silence rules (tier 2 at ≥14d, tier 1 at 7-13d for Negotiating/Response Received deals); surfaces failures attributed to the deal (cap 2); emits a tier 1 "recent activity" attestation when only successes exist. `components/MaverickDealCommentary.tsx` reads the shared `BriefingProvider` context (no new fetch), collapsed-by-default card with severity-tier border, click-to-expand reasoning, Maverick avatar + voice headline. Empty state renders "Maverick is watching this deal" — never fabricates content. **Recall panel:** `app/api/maverick/recall/route.ts` is a thin HTTP wrapper over the existing `lib/maverick/recall.ts` (same auth model as load-state — dashboard session first, OAuth waterfall fallback, Phase 11.6 cron gate mirrored). `components/RelatedDealsRecall.tsx` is **user-triggered only** (no auto-fetch, no polling — deliberate Phase 11.6/11.7 posture). Default query: listing agent name; falls back to address; editable. Hits spine + audit + listings sources. Click-through navigation when the result is a listings/deals record. Both panels wired into `app/pipeline/[id]/page.tsx` (commentary above Jarvis context strip; recall at bottom of left column). |
| 9.9 | German Shepherd avatar | **DONE** | MEDIUM | (CODE 5/16: Alex provided the canonical asset — a photo of the real-life Maverick (German Shepherd, the dog Maverick the AI is named after per Character Spec §2). Cropped + resized via sharp from `public/IMG_5337.jpeg` (3024×4032 iPhone source) → square 2782×2782 centered on the head → resized to 256×256 (`public/maverick-avatar.webp`) + 512×512 retina (`public/maverick-avatar@2x.webp`). Wired into `components/ShepherdPanel.tsx` replacing the 🐕 emoji placeholder in both collapsed pill (24×24) + expanded header (28×28). Severity tier dot now overlays the avatar's upper-right corner. Per Character Spec §6.1: "alert but not aggressive. Ears up, eyes on the perimeter, body relaxed" — this image lands exactly there.) |
| 9.10 | Auto-allow `maverick_load_state` permission (currently "Needs approval") | NOT STARTED | LOW | Friction reduction once trust established |
| 9.11 | Jarvis→Maverick rename of components | **DONE** | MEDIUM | (CODE 5/16 audit insertion → 5/16 Commit A; corrected in Commit B.1 — missed the JarvisGreeting header `<h2>Jarvis · Act Now</h2>` (line 313); now "Maverick · Act Now". LLM self-identity strings updated: `lib/jarvis-system-prompt.ts` "You are Jarvis" → "You are Maverick" ×4. User-visible UI strings updated in JarvisChat + JarvisFeed + JarvisGreeting header. @deprecated JSDoc added to 3 components + 4 jarvis-* API routes pointing to Phase 9.1 / 9.2 / 10 replacements. File paths retained for backwards-compatible imports — actual file rename + deletion happens when Shepherd panel (9.1) + priority surface (9.2) supersede.) |

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
| 11.2 | Finding #7: `last_outreach_date` SMS-only — add `last_email_outreach_date` field | **DONE (with documented attribution gap)** | HIGH | (CODE 5/18 Commit F.) Originally surfaced after the 23 Fields negotiation with Candice Hardaway false-staled while email exchange was active. **Schema:** `Last_Email_Outreach_Date` field created via Airtable MCP on Listings_V1 (`tbldMjKBgPiq45Jjs`, new field id `fld4Jzjs8etKact6g`, type dateTime, ISO format, America/Chicago tz, nullable). Wired into `LISTING_FIELDS` + `LISTING_NAME_MAP` in `lib/airtable.ts` and the `Listing` type in `lib/types.ts`. **Write side:** `SendOpts` in `lib/gmail.ts` gains an optional `listingRecordId?: string`. When set AND the live send confirms successful (not draft, not failed), `sendEmail` calls `updateListingRecord(recordId, {Last_Email_Outreach_Date: nowIso})` and emits `agent=crier event=last_email_outreach_written` audit (failures audited as `last_email_outreach_write_failed` but never bubble to the caller — the email already sent). **Read side:** `lib/maverick/deal-commentary.ts` gains pure helper `latestContactIso(listing)` that returns the actual max() across all four contact timestamps (`lastInboundAt`, `lastOutboundAt`, `lastOutreachDate` SMS, `lastEmailOutreachDate`). Replaces the prior fallback-chain (`a ?? b ?? c`) which could pick an OLDER timestamp when a newer one existed on a different field — the root mechanism of the 23 Fields false-stale. `DealCommentaryListing` extended with the new field; `inferDealCommentary` updated to use `latestContactIso` for the silence-detection branch. Deal-detail page wired to pass the new field through. **Tests (9 new, 501/501 total):** SMS-only / email-only / mixed-SMS-newer / mixed-email-newer (23 Fields canonical) / inbound-newest / all-null / unparseable-tolerated + dedicated `inferDealCommentary` regressions confirming the 23 Fields scenario no longer surfaces as tier-2 and the all-old version still does. **Attribution gap (forward-only writes per sprint scope):** the existing five `sendEmail` call sites are all buyer-side (`warmup-sequence`, `intake`, two `fire-blast` paths) and have no listing recordId in scope — they don't write the new field, which is correct (these emails aren't attributable to listings). The deal-detail page's "Send Formal Offer Email" button is a `mailto:` link that opens Gmail externally; Alex's manual sends from there cannot write back. New listing-attributable programmatic sends (Scribe contract dispatch when Phase 5 ships, future Crier email cadence, etc.) will Just Work by passing `listingRecordId`. Inbound-reply ingestion is also Phase 13/Sentinel territory — not in scope here. |
| 11.3 | Finding #8: Scribe must read DocuSign API directly (not PDF exports) | NOT STARTED | MEDIUM (HIGH at Scribe ship) | (CODE 5/16: **UNBLOCKED** — DocuSign MCP now live, see 5.4 above.) |
| 11.4 | Finding #9: `stored_offer_price` universally null — V2.1 pricing discipline broken | **DONE** | HIGH | (CODE 5/16: shipped in this sprint. Two write paths wired: (a) `app/api/agents/pricing/[recordId]/route.ts` persists `Stored_Offer_Price: your_mao_flipper` when phase4c succeeds + value > 0; (b) `app/api/outreach-fire/route.ts` (both new-outreach + multi-listing handlers) writes `Stored_Offer_Price: offerNum` + `List_Price_At_Send: listing.listPrice` on send success, mirroring d3-backfill semantics with data_source="live_send". Surfaces in next pricing-agent run + next H2 send. Open sub-question logged as Phase 20.2.) |
| 11.5 | Make blueprint API: "right()" doesn't exist | DOCUMENTED | LOW | Use substring instead |
| 11.6 | Cron-burn safeguard on `/api/maverick/load-state` + MCP route | **DONE** | CRITICAL | INSERTED 5/17 BECAUSE 48hr unattended Sat-Sun window burned ~4.8M tokens / ~$15-30 of Anthropic credits via paired aggregator (1.5K) + synthesizer (8.2K) calls every ~6 min. (CODE 5/17 cron inventory: `vercel.json` contains 5 crons, all DAILY (`0 X * * *` once-per-day) — none hit `/api/maverick/load-state`. Vercel Hobby plan hard-caps crons at once-per-day per `AGENTS.md` (`0 */6 * * *` rejected at deploy on commit `2e0d054`), so a 6-min Vercel cron literally cannot exist in this repo. Daily crons left intact: `propose-actions` 9am, `scan-comms` 10am, `scan-replies` 11am, `warmup-sequence` 1pm, `recompute-agent-prior-counts` 8am — all part of working pipeline machinery, none caused the burn. **Most likely cause:** backgrounded dashboard tab where the 90s `ShepherdPanel.tsx` setInterval got browser-throttled to ~6min cadence (Chromium clamps background timers but does not pause them). Also-possible: external uptime monitor, persistent claude.ai/loop keepalive, cold-start cache misses. **Commit B.2 (446aa90):** `MAVERICK_CRON_ENABLED` env var (default false) gates `auth.kind==="cron"` callers in both load-state (503 + `load_state_cron_gated`) and MCP (503 + `mcp_cron_gated`). Phase 14 breadcrumb: `pulse_event:"non_user_synthesis"` console.warn on fresh synthesis from non-`dashboard_session` caller. **Commit B.3 (THIS):** ShepherdPanel `setInterval` now visibility-gated via `lib/maverick/visibility-polling.ts` — the architectural fix that closes the actual failure mode (backgrounded tabs auth as `dashboard_session`, so the cron gate would not have caught them). Promoted to DONE. |
| 11.7 | Browser polling visibility-state convention | **DONE** | HIGH | INSERTED 5/17 BECAUSE Phase 11.6 root-cause analysis showed the cron gate alone wasn't enough — backgrounded dashboard tabs authenticate as `dashboard_session` and would burn tokens through any number of cron safeguards. Convention spec'd in `Maverick_Daily_UX_Spec_v1.md §10.5`: any client `setInterval`/polling loop that triggers a server call must gate the call on `document.visibilityState === "visible"`. Canonical helper: `lib/maverick/visibility-polling.ts` (`startVisibilityGatedPolling`). Pure-function, unit-tested without jsdom, drop-in for any client polling effect. Mandatory for Phase 9.4 (agent rooms), 9.6 (live motion), 9.8 (deal detail) and any future polling client surface. Enforce in code review for Phase 9.4+. |

---

## Phase 12 — Infrastructure Provisioning Gaps (FORWARD)

| # | Item | Status | Severity | Notes |
|---|------|--------|----------|-------|
| 12.1 | Vercel API token (`VERCEL_API_TOKEN` env var) | NOT STARTED | MEDIUM | Deploy state currently blind in briefings. (CODE 5/16: confirmed via live briefing — `vercel.api_token_configured: false`, all deploy fields UNKNOWN.) |
| 12.2 | GitHub Personal Access Token (`GITHUB_PAT`) | NOT STARTED | MEDIUM | Git source returns empty without it. (CODE 5/16: confirmed via live briefing — `branch_resolved: false`, `latest_commit: null`, `commits_since_count: 0` even though there have been commits in the last 24h.) |
| 12.3 | Personal phone escalation channel (Stage 4 SMS path) | **DONE — A2P 10DLC pending at carrier** | HIGH | (5/18) Alex provisioned `+16302505865` as Maverick's personal escalation number in the Quo workspace; live as of today. A2P 10DLC registration is pending at the carrier (1-7 day window typical, carrier-dependent). Until A2P clears, outbound from this path will be accepted by Quo (HTTP 202) but held at the carrier — alerts visible in the Quo workspace inbox but not fanned out to Alex's phone. No code changes needed when registration clears; delivery starts flowing automatically. Phase 9.7 SMS escalation now built against this number (`MAVERICK_STAGE4_SMS_TARGET` env, default `+16302505865`). |
| 12.4 | Scenario J fix — manual Make UI edit (HTTP module empty body) | **OBSOLETE — J deleted** | MEDIUM | (5/18 cleanup sprint) J (4724499) deleted via Make MCP after Alex rotated the exposed Anthropic key. Replaced by `/api/verify-listing` in the dashboard per the Phase 20.1 retirement plan. |
| 12.5 | Anthropic Console organization-level API spend monitoring | NOT STARTED | MEDIUM | Pulse routine eventually monitors this |
| 12.8 | INEVITABLE_Constitution_v3.docx + Make scenarios — manual `Buyer_Tx_Median` → `Buyer_Median` token cleanup | **CLEAR — rename audit done by Alex** | LOW | INSERTED 5/18 with Phase 20.2 v1.3 amendment. Alex's 5/18 Make audit confirmed zero `Buyer_Tx_Median` references in any Make scenario. Constitution.docx manual rename remains Alex's task (project knowledge file, not in repo). Original concern (Make scenarios + Constitution.docx carrying stale token) is closed for Make; docx is the only outstanding piece. |
| 12.9 | Make blueprint secret exposures — H2 OpenPhone + Scenario I ScraperAPI hardcoded keys | NOT STARTED | MEDIUM | INSERTED 5/18 cleanup sprint. Surfaced while reading H2 + I blueprints for the v1.3 patch / Anthropic key rotation. Same exposure class as the Anthropic-in-J key (hardcoded in Make blueprint, visible to anyone with workspace access). (a) Scenario I (4938156 Photo_Rehab_Estimator_V1) Module 3 ScraperAPI URL query param `api_key=...d43c9803`. (b) H2 (4724197 Quo_Outreach_V1) Module 2 OpenPhone Authorization header `...0c76d`. Both still active. Mitigation: rotate ScraperAPI key + OpenPhone key in their respective consoles; replace hardcoded values in Make blueprints (via MCP or UI). Same procedure as the 5/18 Anthropic rotation. Alex's call when to fire. |
| 12.7 | DocuSign JWT integration credentials | NOT STARTED | HIGH | INSERTED 5/18 BECAUSE Phase 5 Scribe shipped via Commit G with full JWT client code but live data is gated on Alex provisioning the integration. Steps: (1) DocuSign Admin Console → Apps & Keys → Add App; (2) generate RSA keypair, save private key; (3) grant impersonation for Alex's user; (4) note the integration key (UUID); (5) set Vercel env: `DOCUSIGN_INTEGRATION_KEY` (UUID), `DOCUSIGN_USER_ID` (Alex's `8999bf2c-e9d0-41b4-9625-9730e321d2db` per `getUserInfo`), `DOCUSIGN_PRIVATE_KEY` (full PEM with BEGIN/END markers). Account ID + base URI defaulted in code (`ab943441-...` + `https://na4.docusign.net`). Once env lands, the briefing's `external_signals.docusign.configured` flips to true on the next refresh, the Scribe room lights up, and the deal-detail panel surfaces live envelope state. ~15-20 min in DocuSign Admin Console. |
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
| 20.2 | **`Stored_Offer_Price` semantics — historical vs operative.** | **RESOLVED 5/18 — both, via two-field split.** | (was blocking Phase 11.4 dual reading; now unblocked) | The v1.2 spec collapsed two semantic surfaces into one field. v1.3 amendment splits them: **Outreach_Offer_Price** (sticky 65%-of-List at outreach time, never overwritten — door-opener semantics, the funnel filter for motivated sellers) and **Contract_Offer_Price** (operative ceiling at negotiation/DD stage, can be ABOVE or BELOW outreach price because DD reveals whether to drop (worse rehab) or push (clean deal + motivated seller)). Hard floor on contract: V2.1 math (Investor_MAO − Wholesale_Fee). Soft ceiling: none, but >75% of List triggers Maverick caution flag on deal-detail. Plus new `Seller_Motivation_Score` (1-5 rubric) field — manually scored now, automated by Sentinel in Phase 13 — drives the seller-motivation modifier on the Phase 4D Unified Deal Math range endpoint. Commit H (5/18) shipped: Airtable rename of `Stored_Offer_Price` → `Outreach_Offer_Price` (field id preserved, all data carried), new `Contract_Offer_Price` (fldfJWuEIHqaRuWq3) + `Seller_Motivation_Score` (fldfEVJijfPOBulpc) fields, write-path split (outreach-fire writes Outreach_Offer_Price sticky-gated; Pricing Agent writes Contract_Offer_Price), Listing type updated, briefing surface updated, 523/523 tests. Orphan empty `_orphan_outreach_offer_price_5_18` (fldhl0njOHREJQ6Gd) left in Airtable for Alex to delete via UI (MCP can't drop fields). |
| 20.3 | **Auth waterfall caller types — dashboard browser is a fourth surface.** Spec v1.2 §6.8 names three: OAuth opaque token (claude.ai), CRON_SECRET (Vercel crons), MAVERICK_MCP_TOKEN (dev/CI shell). The dashboard browser is a fourth — same-origin fetch with no Authorization header, authenticated via the existing AuthGate's `akb-auth=authenticated` cookie (sameSite=strict, httpOnly, secure). Discovered 5/16 Commit B because the Shepherd panel's `/api/maverick/load-state` fetch hit the Day-2 bearer-only gate and 401'd. | **RESOLVED-IN-PATCH 5/16 (Commit B.1)** | (was blocking Shepherd panel data load) | Resolved in `lib/maverick/oauth/auth-waterfall.ts` via new `hasDashboardSession(cookie)` helper. Load-state route checks dashboard cookie first; falls through to the OAuth waterfall for non-browser callers. MCP route is unchanged — dashboard cookie does NOT grant MCP access (different threat model: MCP is for external Claude clients; load-state is read-only briefing data). v1.3 spec should fold the dashboard surface into the canonical auth model + decide whether other Maverick endpoints (write_state, recall) should also accept dashboard session. |
| 20.5 | **Quota-burn anomaly detection — Pulse must watch for system-driven token consumption exceeding human-activity baseline.** 5/17 unattended Sat-Sun window burned ~4.8M tokens (paired aggregator + synthesizer calls every ~6 min) from a source still unidentified after Phase 11.6 cron-inventory audit. The exact failure mode Pulse (Phase 14) is supposed to surface and didn't because Pulse isn't built yet. Pulse must (a) baseline expected token volume from `dashboard_session`-attributed calls vs system-attributed calls, (b) alarm when fresh-synthesis cadence exceeds a documented ceiling, (c) integrate the `pulse_event:"non_user_synthesis"` console breadcrumbs landed in Commit B.2 as the data trail. Owner: Phase 14 Pulse build. Until Pulse ships, `MAVERICK_CRON_ENABLED=false` is the safety floor. | **OPEN** | Phase 14.3 (quota burn monitoring) | INSERTED 5/17 BECAUSE the 48hr burn was the exact failure mode Pulse exists to prevent. Phase 14.3 currently scopes Anthropic burn to RentCast/Quo-style external-quota tracking; this entry extends that scope to *internal* token consumption — the synthesizer's own cost when called by non-humans. |
| 20.7 | **Continuity-layer-stale-deployment + missing write-state discipline.** Two compounding failures discovered 5/18: (H1) Vercel project's only `target: "production"` deployment is `dpl_4peQ2dTrnWM34bJrE3XqJY3Sd69Y` (sha 33341a3e, branch main, 2026-05-12) — BEFORE Phase 9 work began. All Commit B.2 → G.3 deployments (15+ across Phase 9.4 / 9.6 / 9.7 / 9.8 / 11.6 / 11.7 / 11.2 / 5.1 / 5.2 / 5.3 / 5.4) shipped as `target: null` previews; production alias still resolves May 12 code. (H2) `lib/maverick/write-state.ts` exists + tested but no caller invoked it after any commit since the 5/16 audit; Spine_Decision_Log had zero entries for the entire Phase 9-11-12-5 build. Result: Claude sessions opening via the connector got multi-week-stale briefings AND zero recall hits for tonight's work. Same failure-mode class as Phase 11.6/11.7 (silent divergence from reality). | **DONE — H2 closed; H1 awaiting Alex's connector repoint OR merge-to-main** | (continuity-layer trust budget; everything downstream of recall depends on it) | INSERTED 5/18 BECAUSE the system silently lied. H2 resolved this session via 10 backfill build_event writes (parent reco15HtXmy2PvrY9, plus phase entries for 9.3+9.11, 9.1+9.2+9.5, 9.9, 11.6+11.7, 9.4, 9.6+9.8, 9.7+12.3, 11.2, 5 Scribe). H1 has two fix paths: (a) repoint Claude.ai MCP connector to the branch-stable alias `coach-pulse-git-claude-fix-token-b-efd89f-golf4life27s-projects.vercel.app` — auto-tracks the latest preview push, lowest blast radius; (b) merge `claude/fix-token-burn-cost-JUDad` to main → Vercel re-deploys production. Recommendation: Path (a) until Phase 9/11/12/5 has full browser-eyes-on validation across a couple of refresh cycles, then merge. Discipline going forward: every Code commit on this branch includes a `maverick_write_state` call as part of the commit ritual until a git post-commit hook automates it. |

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
| 2026-05-16 | 20.3 | Dashboard browser fetch is a fourth auth surface beyond OAuth/CRON/bearer. Surfaced during Commit B live deploy when Shepherd panel hit load-state 401. RESOLVED-IN-PATCH (Commit B.1) via same-origin cookie path; v1.3 spec to fold into canonical auth model. |
| 2026-05-17 | 11.6 | 48hr unattended Sat-Sun window burned ~4.8M tokens via paired aggregator+synthesizer calls every ~6 min. Cron inventory confirmed `vercel.json` is clean (5 daily crons, none hit load-state; Hobby plan blocks sub-daily). Source of cadence unidentified; surviving hypotheses logged. `MAVERICK_CRON_ENABLED` gate (default false) + Phase 14 breadcrumb shipped Commit B.2. |
| 2026-05-17 | 20.5 | Quota-burn anomaly detection raised as architectural requirement for Pulse. The 5/17 burn was the exact failure mode Phase 14 exists to prevent and proves Pulse's scope must extend to internal-synthesis cost (not just external-API quotas). Owner: Phase 14 Pulse build. |
| 2026-05-17 | 11.7 | Browser polling visibility-state convention. Phase 11.6 cron gate did not cover backgrounded dashboard tabs (auth as `dashboard_session`, not `cron`). Convention spec'd in `Maverick_Daily_UX_Spec_v1.md §10.5`; canonical helper `lib/maverick/visibility-polling.ts`. ShepherdPanel migrated as the reference implementation. Mandatory for Phase 9.4+ client polling components. |
| 2026-05-18 | 12.3 | Alex provisioned `+16302505865` in the Quo workspace as Maverick's personal escalation number. A2P 10DLC registration pending at carrier (1-7 day window). Unblocks Phase 9.7 SMS escalation build — Commit E lands the code today against this target. |
| 2026-05-18 | 11.2 | Commit F lands the `Last_Email_Outreach_Date` schema + max() staleness math. Airtable field created via MCP (`fld4Jzjs8etKact6g` on Listings_V1). Attribution gap documented: only programmatic `sendEmail` calls with `listingRecordId` set populate the field; mailto: manual sends from the deal-detail page cannot write back (Phase 13/Sentinel-adjacent — out of scope). 23 Fields regression test locked in. |
| 2026-05-18 | 5.9 / 5.10 / 5.11 / 12.7 | Commit G lands Phase 5 Scribe. Three sub-commits: G.1 foundation (`lib/docusign.ts` JWT client + new 10th briefing source + 22 tests), G.2 ScribeRoom on factory floor, G.3 Envelope_ID field + deal-detail panel + send-reminder/track-envelope routes. Architectural decision logged: production uses Path A (JWT via DocuSign REST API directly) rather than MCP, because MCP is a Claude-side protocol unreachable from Vercel functions. Live data gated on Phase 12.7 credential provisioning (Alex's task in DocuSign Admin Console). Old "MCP server UUID" string `ab943441-...` corrected — that was Alex's account_id all along. |
| 2026-05-18 | 20.7 | Continuity-layer drift surfaced when an Alex Claude session opened with maverick_load_state referencing a 2-week-stale branch and maverick_recall returning zero for tonight's work. H1 (deployment): Vercel production target is `dpl_4peQ2dTrnWM34bJrE3XqJY3Sd69Y` (sha 33341a3e, main, May 12); every Phase 9-11-12-5 commit shipped as preview only. H2 (discipline): no maverick_write_state calls had been made since 5/16; Spine_Decision_Log had zero entries for ~14 commits of work. H2 fixed this session via 10 backfill build_event writes. H1 fix path: Alex repoints connector to `coach-pulse-git-claude-fix-token-b-efd89f-golf4life27s-projects.vercel.app` OR merges branch to main. Future Code commits include a write_state call as ritual. |
| 2026-05-18 | 20.2 / 3.2 / 3.11a / 12.8 | Commit H — Phase 20.2 closed via two-field split (Outreach_Offer_Price sticky 65%-of-List at door-opener time; Contract_Offer_Price operative offer at negotiation/DD, can be above or below outreach). Airtable: rename `Stored_Offer_Price` → `Outreach_Offer_Price` (field id `fldBFnL0HQJWahRov` preserved, data carried); new `Contract_Offer_Price` (`fldfJWuEIHqaRuWq3`) + `Seller_Motivation_Score` (`fldfEVJijfPOBulpc`). Phase 4D endpoint amendment to return a range `[V2.1 floor, motivation-adjusted target]`. Buyer_Tx_Median → Buyer_Median doc-only correction (zero live code references; Make scenarios + Constitution.docx flagged as Phase 12.8 manual follow-up). 523/523 tests. Orphan `_orphan_outreach_offer_price_5_18` (fldhl0njOHREJQ6Gd) left in Airtable for manual UI deletion. |
| 2026-05-18 | 12.4 / 12.8 / 12.9 / 4A.1 | Cleanup sprint + Commit I (Phase 4A.1 ARV endpoint). **Cleanup:** H2 (4724197) module 3 patched via Make MCP to snapshot Outreach_Offer_Price = {{1.MAO_V1}} at SMS send (Path A "Snapshot-at-send" per Alex's 5/18 decision; verified post-push isinvalid:false). Anthropic key rotated by Alex (Console + Make I); Vercel uses separate Jarvis key (no env update needed). J (4724499) + L2 (4812267) deleted via Make MCP. New Phase 12.9 row added for the OTHER Make blueprint secrets surfaced during the audit (Scenario I ScraperAPI key + H2 OpenPhone key hardcoded). **Commit I:** standalone Appraiser ARV endpoint `/api/agents/appraiser/arv/[recordId]` shipped across three sub-commits — I.1 (`9471dc7`) endpoint + `lib/appraiser/mao-range.ts` pure helpers + 18 tests including the 1219 E Highland $90K validation anchor; I.2+I.3 (`e4e281b`) briefing aggregator wire (ListingsActiveDeal gains 5 ARV fields) + Appraiser room ARV coverage rollup + deal-detail ARV panel with comps table. Phase 4A.1 → DONE; v1.3 range envelope `{floor, target, list_price, soft_ceiling, exceeds_soft_ceiling, modifier_inputs}` lands here. 541/541 tests passing. Phase 19.8 Spine wrap via direct Airtable fallback (Maverick MCP intermittently disconnected): Spine rows `recoZqd3zTklediUO` (cleanup) + `recCqTItoptQ3L8dL` (Phase 4A.1). |

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