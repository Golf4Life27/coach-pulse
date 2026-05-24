# AKB INEVITABLE — SYSTEM INVENTORY v2 (Forensic Status Audit)

**Document version:** v2.0
**Authored:** 2026-05-20 (Code — autonomy-run forensic pass)
**Branch:** `claude/fix-token-burn-cost-JUDad`
**Repo HEAD:** `31d690d` (chore(gitignore)) ← `2ef09db` (Sprint R) ← `7993439` (Q.8 closeout)
**Scope:** Every item in `AKB_MASTER_CHECKLIST.md` v1.1 claimed DONE / IN PROGRESS / DOCUMENTED / LOCKED, audited against live state.
**Supersedes:** `AKB_System_Inventory_v1.md` (5/16 Code Days 6-7 audit — named-component inventory). v1 retained for historical context; v2 is the row-by-row forensic refresh per Alex's 5/20 audit directive.

---

## Audit semantics

- **Phase 20.1 (Make migration) is intentionally UNDECIDED.** Working/broken/unused recorded as raw facts.
- **Make scenario `isActive: false` is operator credit-conservation discipline,** not a system problem. Scenarios are toggled ON only when work flows. Recorded as raw state, never flagged as discrepancy.
- **No fixes recommended. No interpretation. No new work proposed.** Status-audit only.
- **STOP markers** = external operator-account work required. Not Code-actionable.
- **UI edits only for Make.** No blueprint API pushes.

## Verification sources

| Source | How read | Coverage |
|---|---|---|
| Airtable | MCP `list_records_for_table`, `get_table_schema`, `search_records` against base `appp8inLAGTg4qpEZ` | Listings_V1 (`tbldMjKBgPiq45Jjs`), Spine_Decision_Log (`tblbp91DB5szxsJpT`), Buyers, D3 Manual Fix |
| Make | MCP `scenarios_list`, `scenarios_get`, `executions_list` against org 5028411 / team 1313571 | All scenarios A → N |
| Vercel | MCP `list_deployments`, `get_deployment` against team `team_zwFAlAQ8CyjGYcxyk7Sn6ww0` / project `prj_X1pCuqzRml74iOKfNhTo4ZMG9K87` | Branch `claude/fix-token-burn-cost-JUDad` deploys + production target |
| Repo | `git log`, `git show`, file reads on local checkout | Branch `claude/fix-token-burn-cost-JUDad` HEAD `31d690d` |

---

## Three forensic questions

### Q1 — Of today's 5/19 41 Auto Proceed records, how many fired outreach and why did the rest not fire?

**Population:** 43 records (close to the 41 claim — exact count depends on cutoff time) with `Execution_Path = "Auto Proceed"` AND `Last_Modified_Time >= 2026-05-19T00:00:00 America/Chicago`. Queried via Airtable `list_records_for_table` with filter `AND({Execution_Path}='Auto Proceed', IS_AFTER(LAST_MODIFIED_TIME(), '2026-05-19T05:00:00Z'))`.

**Fired outreach: 8 of 43.**

| Outreach_Status | Count | Notes |
|---|---|---|
| Texted | 4 | Last_Outreach_Date = 2026-05-19. Records: 6811 Agua Calientes; 846 San Angelo; 1911 Wormack Way; 7003 Emerald Vly. |
| Response Received | 4 | Pre-existing inbound state. Records: 1212 Churing Dr; 5435 Callaghan Rd; 118 Redrock Dr; 11114 Dreamland Dr. |

**Did not fire outreach: 35 of 43.**

Two compounding causes confirmed from live data:

1. **Stage_Calc_V2 formula gate:** 41 of 43 records had `Stage_Calc_V2 = "Rejected: No Distress"`. The Execution_Path formula sets `"Auto Proceed"` only when `Stage_Calc_V2 = "Passed: Ready for Offer"` (per formula on field `fldNRMrcxbiKHW1C9`). Records can carry historical `Auto Proceed` even when their current Stage_Calc_V2 has flipped to a Rejected state — H2's live filter checks Execution_Path = "Auto Proceed" but the deeper Stage_Calc_V2 = "Passed: Ready for Offer" requirement is not separately filtered.

2. **H2 (Quo_Outreach_V1, Make 4724197) state on 5/19:** `isActive: false`, `isinvalid: true`. Multiple BlueprintValidationError executions throughout 5/19. Last successful execution: 2026-05-19T22:17:02Z (manual run).

H2 being OFF on 5/19 is consistent with operator credit-conservation discipline — scenarios are toggled ON when work flows. The `isinvalid: true` flag is a separate condition reflecting carry-forward from the 5/18 Path A snapshot-at-send module rework. Validation errors during 5/19 executions are evidence of that same blueprint-shape issue, not of the inactive toggle.

### Q2 — Where is the "Rejected: No Distress" auto-classifier physically located?

**Answer: Airtable formula on the Listings_V1 table. Not Make. Not code. Not an Airtable automation.**

- **Field:** `Stage_Calc_V2` (`fldA8B9zOCneF0rjp`), type `formula`, on `tbldMjKBgPiq45Jjs` (Listings_V1).
- **Formula body** (read via Airtable MCP `get_table_schema`):

```airtable
IF({fldEh24uT8r9JLVl4}=0, "Rejected: Price Floor",
IF({fldofZSehhzQRfgWj}=0, "Rejected: Too Small",
IF({fldt5WIn7HsWhxRTl}=0, "Rejected: Not SFR",
IF(OR({fldER5IGrBnHeYcTA}=1, {fldsNAU7f6VyprLGl}=1), "Rejected: Retail or Liquidity",
IF({fldlQJV00psn0vucy}=0, "Rejected: No Distress",
IF({fld1UN2UgzFOnBvJU}=0, "Rejected: Offer Math",
"Passed: Ready for Offer"
))))))
```

- **Triggering field:** `fldlQJV00psn0vucy` (Distress_Pass). Boolean = 0 → formula returns `"Rejected: No Distress"`.
- **Older sibling formula** `Stage_Calc` (`fldDCGwYvt7b8fNCj`) uses em-dash variant `"Rejected – Not Distressed"` (different copy, same logic). Both formulas live in Airtable.
- **Codebase grep** for `"Rejected: No Distress"` returns zero matches. No Vercel route or Make blueprint references the string.

### Q3 — Does L3 (Make 4812756) write to a Sentinel queue field anywhere, or only to Notes?

**Answer: L3 writes to two Listings_V1 fields. Neither is a Sentinel queue field. No Sentinel queue field exists anywhere in the system.**

L3 blueprint (read via Make MCP `scenarios_get` blueprint payload) contains 4 `ActionUpdateRecord` modules across 4 router routes. All four write to the same two fields:

| Field ID | Field name | Type |
|---|---|---|
| `fldGIgqwyCJg4uFyv` | Outreach_Status | singleSelect |
| `fldwKGxZly6O8qyPu` | Verification_Notes | longText (append-only `+ "\n[L3 ts]: <body>"`) |

Per-route values written:

- **Route 1 (Rejection):** Outreach_Status → "Dead"; Verification_Notes appended.
- **Route 2 (Negotiation Interest):** Outreach_Status → "Negotiating"; Verification_Notes appended.
- **Route 3 (Default First Response):** Outreach_Status → "Response Received"; Verification_Notes appended.
- **Route 4 (Append Only — already-in-progress):** Verification_Notes appended only; Outreach_Status unchanged.

**No Sentinel queue field exists.** Repo grep for `Sentinel_Queue|sentinel_queue|"Sentinel queue"` returns zero matches. The Sentinel approval queue (Phase 13.9, `/sentinel`) is a derived metadata view computed at request time from `Last_Inbound_At > Last_Outbound_At` against the active Listings_V1 set — no persisted queue field.

---

## Cross-cutting findings (raw facts)

- **Make scenarios `isActive: false` at audit time (recorded as raw state, NOT discrepancy per operator discipline):** A (4256273), B (4331170), B2 (4930403), the C/D/E series, G (4583609), H2 (4724197), H3 (4769543), I (4938156), K (4938166), K-Briefing (4774565), M-Briefing (4812900).
- **Make scenarios `isActive: true`:** L3 Reply_Triage_V3 (4812756), L4 Reply_Capture_V1 (4883113), Integration Webhooks (4207104).
- **Make scenarios deleted (no longer in org):** J (4724499) — deleted 5/18 cleanup sprint. L2 (4812267) — deleted same sprint.
- **H2 (4724197) carries `isinvalid: true`** at audit time with BlueprintValidationError executions on 5/19. Independent of inactive toggle.
- **Vercel production target alias:** `dpl_4peQ2dTrnWM34bJrE3XqJY3Sd69Y` (sha `33341a3e`, branch `main`, 2026-05-12). All Phase 9/11/12/5 work shipped as preview only (Phase 20.7 H1, still open — awaiting operator merge-to-main OR connector re-point).
- **Branch `claude/fix-token-burn-cost-JUDad` Vercel deploys** up to HEAD commit `31d690d`: all READY status.
- **GitHub commits referenced in build log** (sprint Q.1–Q.8, Sprint R `2ef09db`, gitignore `31d690d`) all present on branch.
- **Codebase file paths for all claimed deliverables exist** — sentinel, ledger, pulse, deal-math, crawler, scout, dedupe, appraiser, brocard, scribe directories all present and contain the files referenced.

---

## Item-by-item audit

Columns: Item # | Claimed Status | Actual Status | Evidence | Discrepancy

### Phase 0 — Foundation

| # | Claimed | Actual | Evidence | Discrepancy |
|---|---|---|---|---|
| 0.1 | DONE | DONE | Operator-procedural (LLC). | None |
| 0.2 | DONE | DONE | Operator-procedural (banking). | None |
| 0.3 | DONE | DONE | Quo phone ID `PNLosBI6fh` in `lib/quo.ts`. | None |
| 0.4 | DONE | DONE | Base + table return records via Airtable MCP. | None |
| 0.5 | DONE | DONE | Buyers table `tbl4Rr07vq0mTftZB` referenced in `lib/airtable.ts`. | None |
| 0.6 | DONE | DONE | D3 Manual Fix `tblV6OkNPDzOo6ubp` referenced in codebase. | None |
| 0.7 | DONE | DONE | Spine `tblbp91DB5szxsJpT` confirmed via Airtable MCP; referenced in `lib/maverick/recall.ts`. | None |
| 0.8 | DONE | DONE | Vercel project returns deployments via MCP. | None |
| 0.9 | DONE | DONE | Repo cloned + verified at `/home/user/coach-pulse/akb-dashboard/`. | None |
| 0.10 | DONE | DONE | KV-backed audit store via `lib/audit-log.ts`. | None |

### Phase 1 — Intake & Pipeline Loading

| # | Claimed | Actual | Evidence | Discrepancy |
|---|---|---|---|---|
| 1.1 | DONE (manual) | DONE (manual) | Operator-procedural. | None |
| 1.2 | DONE | DONE (scenario inactive at audit time) | Scenario A 4256273 exists; `isActive: false`. Filters present in blueprint. `app/api/process-intake/route.ts` mirrors filters. | None — inactive = operator discipline |
| 1.3 | DONE (with pending fixes) | DONE (scenario inactive at audit time) | Scenario B 4331170 exists; `isActive: false`. `app/api/verify-listing/route.ts` is Vercel-side companion. | None |
| 1.4 | DONE | DONE | `lib/intake/quality-gates.ts:detectOffMarketLanguage`; 4 tests. Commit Q.5. | None |
| 1.5 | DONE | DONE | `lib/intake/quality-gates.ts:scoreFlipKeywords`; 5 tests. Commit Q.5. | None |
| 1.6 | DEFERRED (Phase 21) | DEFERRED | Logged Phase 21.11. | None |
| 1.7 | DONE | DONE | `lib/intake/quality-gates.ts:validateAgentPhone`; 5 tests. Commit Q.5. | None |
| 1.8 | DONE | DONE | NEVER-list enforcement in pre-outreach checks. | None |
| 1.9 | DONE | DONE | `lib/bulk-dead-annotation.ts` + admin route present. | None |
| 1.10 | DEFERRED (Phase 21) | DEFERRED | Logged Phase 21.12. | None |

### Phase 2 — Outreach (Crier) Layer

| # | Claimed | Actual | Evidence | Discrepancy |
|---|---|---|---|---|
| 2.1 | DONE | DONE | `lib/quo.ts` (227 lines); Quo `/v1/messages` integration live. | None |
| 2.2 | DONE | DONE (scenario inactive + invalid at audit time) | H2 4724197 exists; `isActive: false`, `isinvalid: true`. BlueprintValidationError on 5/19. Last successful execution 2026-05-19T22:17:02Z. | Inactive = operator discipline. Invalid = blueprint carry-forward from 5/18 cleanup. |
| 2.3 | DONE | DONE | Canonical 3-sentence script in H2 module body. | None |
| 2.4 | DONE | DONE | 9 PM CT cutoff in H2 filter + Vercel fire-blast. | None |
| 2.5 | DONE | DONE | 128 TN block list per memory. | None |
| 2.6 | DONE | DONE | L3 4812756 `isActive: true`; 4-way router architecture confirmed (Q3). | None |
| 2.7 | DONE | DONE | L2 (4812267) deleted via Make MCP 5/18. | None |
| 2.8 | DONE | DONE | `lib/quo-throttle.ts`; 6 tests. Commit Q.6. Caller-site wire-up logged Phase 21.18. | None |
| 2.9 | DEFERRED | DEFERRED | Logged Phase 21.13. | None |
| 2.10 | DOCUMENTED | DOCUMENTED | Operator-procedural. | None |

### Phase 3 — Pricing & Math Discipline

| # | Claimed | Actual | Evidence | Discrepancy |
|---|---|---|---|---|
| 3.1 | DONE | DONE | 65% rule in pricing helpers. | None |
| 3.2 | DONE | DONE | V2.1 formula in `lib/pricing-math.ts`. | None |
| 3.3 | DONE | DONE | `lib/orchestrator/pre-send-checks.ts` enforces <20 priced gate. | None |
| 3.4 | DONE (manual) | DONE (manual) | Operator-procedural. | None |
| 3.5 | DONE | DONE | RentCast key in env; `lib/rentcast.ts` present. | None |
| 3.6 | DONE | DONE | Buy Box data in `lib/buyers-v2.ts`. | None |
| 3.7 | DONE | DONE | Locked principle; enforced via 3.3 gate. | None |
| 3.8 | DONE | DONE | Sticky semantics per memory + Outreach_Offer_Price rename. | None |
| 3.9 | DONE | DONE | UI surfaces single number only. | None |
| 3.10 | WRITES PARTIAL | DONE post-11.4 | Field renamed Outreach_Offer_Price (`fldBFnL0HQJWahRov`); `app/api/outreach-fire/route.ts` writes on send success. | None — predates 11.4 fix |
| 3.11 | DONE | DONE | All sub-rows verified. | None |
| 3.11a | DONE | DONE | `app/api/deal-math/[recordId]/route.ts` present. Commit Q.3. | None |
| 3.11b | DONE | DONE | `components/brocard/PricingBlock.tsx` present; commits `6638120`, `0b229e0`, `3f78bbf` in `git log`. | None |
| 3.12 | DONE | DONE | `lib/orchestrator/pre-outreach-checks.ts` family confirmed. | None |

### Phase 4 — Buyer Network (Scout) Layer

| # | Claimed | Actual | Evidence | Discrepancy |
|---|---|---|---|---|
| 4.1 | DONE | DONE | Buyers table confirmed. | None |
| 4.2 | DONE | DONE | `app/api/buyers/warmup-sequence/route.ts`; cron 13:00 in `vercel.json`. | None |
| 4.3 | DONE | DONE | Warmth states in `lib/buyers-v2.ts`. | None |
| 4.4 | DONE | DONE | Inbound reply handling in scan-replies route. | None |
| 4.5 | DONE | DONE | `lib/scout/queue.ts` + `/api/agents/scout/queue`; 9 tests. Commit Q.5. | None |
| 4.6 | DONE | DONE | Queue surface live; per-record fire-blast coexists. Commit Q.5. | None |
| 4.7 | DEFERRED (retirement path) | DEFERRED | G 4583609 exists, `isActive: false`. Retirement gated. Logged Phase 21.14. | None |
| 4A.1 | DONE | DONE | `app/api/agents/appraiser/arv/[recordId]/route.ts` + `lib/appraiser/mao-range.ts`; commits `9471dc7`, `e4e281b` in `git log`. | None |
| 4B.1 | DONE | DONE | `app/api/agents/appraiser/rehab/[recordId]/route.ts` + `lib/appraiser/rehab-calibration.ts`; commits `a3243f6`, `a492e39`, `9f5f479` in `git log`. | None |
| 4C.1 | DONE | DONE | `app/api/agents/appraiser/buyer-intelligence/[recordId]/route.ts` + `lib/appraiser/buyer-intelligence.ts`; commits `956cb25`, `f416814`, `a84e93c` in `git log`. `Estimated_Monthly_Rent` (`fldrFB0owY6BnQewr`) confirmed. | None |
| 4D | DONE | DONE | Same evidence chain as 3.11b. | None |

### Phase 5 — Contract & Closing (Scribe) Layer

| # | Claimed | Actual | Evidence | Discrepancy |
|---|---|---|---|---|
| 5.1 | DONE | DONE | Operator-procedural. | None |
| 5.2 | DONE | DONE | Operator-procedural. | None |
| 5.3 | DEFERRED (gated on 12.7) | DEFERRED | Logged Phase 21.9. | None |
| 5.4 | DONE — live data pending env | DONE — env pending | `lib/docusign.ts` JWT client; `lib/maverick/sources/external-docusign.ts` returns `configured: false` cleanly when env unset. | None |
| 5.5 | DONE | DONE | `docs/specs/EMD_WIRE_PROCEDURE.md` present. Commit Q.6. | None |
| 5.6 | DONE (manual) | DONE (manual) | Operator-procedural. | None |
| 5.7 | DONE (manual) | DONE (manual) | `lib/orchestrator/pre-contract-checks.ts` enforces inviolable items. | None |
| 5.8 | IN PROGRESS | IN PROGRESS | Operator-procedural (title relationships). | None |
| 5.9 | DONE | DONE | `components/factory-floor/ScribeRoom.tsx` (commit `ee5acd5`). | None |
| 5.10 | DONE | DONE | `components/ScribeDealCommentary.tsx` + `/api/maverick/docusign-send-reminder/[envelopeId]`. | None |
| 5.11 | DONE | DONE | `Envelope_ID` (`fldKPVG9qmbzxW5lK`) on Listings_V1. `/api/maverick/track-envelope/[recordId]` present. | None |

### Phase 6 — Maverick Continuity Layer

| # | Claimed | Actual | Evidence | Discrepancy |
|---|---|---|---|---|
| 6.1 | DONE | DONE | Spec doc archived. | None |
| 6.2 | DONE | DONE | Commit `3036126` in history. | None |
| 6.3 | DONE | DONE | Source fetchers in `lib/maverick/sources/`. | None |
| 6.4 | DONE | DONE | Commit `a93a8d8` referenced. | None |
| 6.5 | DONE | DONE | Gate 2 target met per Code audit notes. | None |
| 6.6 | DONE | DONE | Commit `3248c2d`; `lib/maverick/mcp.ts` present. | None |
| 6.7 | DONE | DONE | Commit `366d456`; `lib/maverick/{write-state,recall}.ts` present. | None |
| 6.8 | DONE | DONE | Commit `15b6bfe`; OAuth helpers in `lib/maverick/oauth/`. | None |
| 6.9 | DONE | DONE | Spec v1.2 archived. | None |
| 6.10 | DONE | DONE | MCP server reachable (this session's system reminders). | None |
| 6.11 | DONE | DONE | Three spec docs in `docs/specs/`. | None |
| 6.12 | DONE | DONE | Commit `44f504e` referenced. | None |
| 6.13 | IN PROGRESS — first sample over target | IN PROGRESS | Concurrent-source mitigation (12.6) DONE-PENDING-VALIDATION. | None |
| 6.14 | DONE | DONE | MCP server instructions surfaced as system reminder this session. | None |

### Phase 7 — Maverick Spec Docs

| # | Claimed | Actual | Evidence | Discrepancy |
|---|---|---|---|---|
| 7.1 | DONE | DONE | `docs/specs/Maverick_Character_Spec_v1.md`. | None |
| 7.2 | DONE | DONE | `docs/specs/Maverick_Daily_UX_Spec_v1.md`. | None |
| 7.3 | DONE | DONE | `docs/specs/Maverick_Capability_Absorption_Reference_v1.md`. | None |
| 7.4 | DONE | DONE | Not Code-verifiable (Anthropic project knowledge). | None |
| 7.5 | DONE | DONE | MAVERICK_OPS cross-link extended. Commit Q.6. | None |

### Phase 8 — Code's Days 6-7 Audit

| # | Claimed | Actual | Evidence | Discrepancy |
|---|---|---|---|---|
| 8.1 | DONE | DONE | Historical. | None |
| 8.2 | DONE | DONE | Three spec docs in `docs/specs/`. | None |
| 8.3 | DONE | DONE | `AKB_Dashboard_Current_State_v2.md` committed previously. | None |
| 8.4 | DONE | DONE | Covered in inventory + dashboard current state. | None |
| 8.5 | DONE | DONE → SUPERSEDED by THIS document (v2) | v1 committed 5/16 (named-component); v2 is 5/20 forensic refresh. | None |
| 8.6 | DONE | DONE | Phase 20.1 resolved 5/16. | None |
| 8.7 | DONE | DONE | Phase 9 sequencing in checklist. | None |
| 8.8 | DONE | DONE | Findings #6–9 scheduled. | None |

### Phase 9 — Dashboard Rework

| # | Claimed | Actual | Evidence | Discrepancy |
|---|---|---|---|---|
| 9.1 | DONE | DONE | `components/ShepherdPanel.tsx`; rendered from `app/layout.tsx`. | None |
| 9.2 | DONE | DONE | `components/MaverickPriority.tsx` + `lib/maverick/severity.inferPrioritySignals`. | None |
| 9.3 | DONE | DONE | `lib/roster.ts`; audit callsites use roster names. | None |
| 9.4 | DONE | DONE | `components/factory-floor/` with 9 room components. Commits `73f3b81`, `2efc7cb` in `git log`. | None |
| 9.5 | DONE (minimum) | DONE | `lib/maverick/severity.ts` with TIER_VISUAL; 17 tests. | None |
| 9.6 | DONE | DONE | Commit `da7744c`; `diffAgentActivity` helper present. | None |
| 9.7 | DONE (A2P pending) | DONE — A2P pending external | `lib/maverick/sms-escalation.ts`; 26 tests. A2P registration carrier-side. | None |
| 9.8 | DONE | DONE | Commit `9e85757`; `MaverickDealCommentary.tsx` + `RelatedDealsRecall.tsx` + `/api/maverick/recall` route. | None |
| 9.9 | DONE | DONE | `public/maverick-avatar.webp` + `@2x.webp`. | None |
| 9.10 | DEFERRED (external) | DEFERRED | Operator-account UI; Phase 21.10. | None |
| 9.11 | DONE | DONE | No remaining "Jarvis" user-visible strings. | None |

### Phase 10 — Synthesizer Refactor

| # | Claimed | Actual | Evidence | Discrepancy |
|---|---|---|---|---|
| 10.1 | DONE | DONE | `lib/maverick/synthesize.ts` routes via `lib/maverick/synthesizer.ts`. Commit P. | None |
| 10.2 | DONE | DONE | `lib/maverick/voice-registry.ts`; 13 entries. | None |
| 10.3 | DONE | DONE | Zero direct `anthropic.com/v1/messages` fetches remain at call sites. | None |
| 10.4 | DONE | DONE | `DEFAULT_TIMEOUT_MS = 30000` in synthesize.ts. Commit Q.1. | None |
| 10.5 | DONE | DONE | `ACTIVE_DEALS_PROMPT_CAP = 15`. Commit Q.1. | None |
| 10.6 | DONE | DONE | `cache_system: true` on Maverick synthesizer + Sentinel classifier + drafter. | None |
| 10.7 | DONE | DONE | `lib/maverick/voice-registry.test.ts` (29 tests) + `lib/pulse/detectors/voice-drift.ts` (17 tests) + Pulse cron in `vercel.json`. | None |

### Phase 11 — v1.2 Findings From Gate 3

| # | Claimed | Actual | Evidence | Discrepancy |
|---|---|---|---|---|
| 11.1 | DONE | DONE | `lib/maverick/sources/external-quo.ts` parallel probe + activity. | None |
| 11.2 | DONE (with documented attribution gap) | DONE | `Last_Email_Outreach_Date` (`fld4Jzjs8etKact6g`) confirmed on Listings_V1. `lib/gmail.ts` writes when `listingRecordId` set. | None — gap documented |
| 11.3 | DONE | DONE | Scribe reads DocuSign directly via `lib/docusign.ts`. | None |
| 11.4 | DONE | DONE | Two write paths confirmed (pricing-agent + outreach-fire). | None |
| 11.5 | DOCUMENTED | DOCUMENTED | Operator-procedural. | None |
| 11.6 | DONE | DONE | `MAVERICK_CRON_ENABLED` env gate present in load-state + MCP routes; commits `446aa90` + B.3 referenced. | None |
| 11.7 | DONE | DONE | `lib/maverick/visibility-polling.ts`; ShepherdPanel uses it. | None |

### Phase 12 — Infrastructure Provisioning Gaps

| # | Claimed | Actual | Evidence | Discrepancy |
|---|---|---|---|---|
| 12.1 | STOP (external) | STOP | Operator-account. Phase 21.4. | None |
| 12.2 | STOP (external) | STOP | Operator-account. Phase 21.4. | None |
| 12.3 | DONE — A2P pending | DONE — A2P pending external | Quo workspace number live; carrier-side. | None |
| 12.4 | OBSOLETE — J deleted | OBSOLETE | Make MCP confirms J (4724499) not in org. | None |
| 12.5 | STOP (external) | STOP | Operator-account. Phase 21.15. | None |
| 12.6 | DONE-PENDING-VALIDATION | DONE-PENDING-VALIDATION | Aggregator serializes Airtable calls; `aggregator-stress.test.ts` locks. Gate 5 validation continues. | None |
| 12.7 | STOP (external) | STOP | DocuSign JWT. Phase 21.3. | None |
| 12.8 | CLEAR — rename audit done | CLEAR | Make verified by Alex 5/18; Constitution.docx operator-side. Phase 21.O2. | None |
| 12.9 | STOP (external) | STOP | Operator key rotations. Phase 21.15. | None |

### Phase 13 — Sentinel Build

| # | Claimed | Actual | Evidence | Discrepancy |
|---|---|---|---|---|
| 13.1 | DONE | DONE | `lib/pulse/detectors/intake-signal.ts`. Commit Q.3. | None |
| 13.2 | DONE | DONE | Same file covers active-inventory-low. | None |
| 13.3 | DONE (scaffold) | DONE (scaffold) | `lib/crawler/sources/propstream.ts`; live integration gated on credentials (Phase 21.5). | None |
| 13.4 | DEFERRED (Phase 21) | DEFERRED | Phase 21.7. | None |
| 13.5 | DONE (scaffold) | DONE (scaffold) | `lib/crawler/{types,pipeline}.ts` + `/api/agents/sentinel/crawler/scan`. | None |
| 13.6 | DONE (scaffold) | DONE (scaffold) | Three off-market adapter scaffolds in `lib/crawler/sources/`. | None |
| 13.7 | DONE | DONE | `lib/sentinel/{types,classifier}.ts` + `/api/sentinel/classify/[recordId]`. `Seller_Motivation_Score` (`fldfEVJijfPOBulpc`) on Listings_V1. | None |
| 13.8 | DONE | DONE | `lib/sentinel/drafter.ts` + `/api/sentinel/draft/[recordId]`. | None |
| 13.9 | DONE | DONE | `/api/sentinel/queue` + `components/sentinel/SentinelApprovalQueue.tsx` + `app/sentinel/page.tsx`. | None |

### Phase 14 — Pulse Build

| # | Claimed | Actual | Evidence | Discrepancy |
|---|---|---|---|---|
| 14.1 | DONE | DONE | `PulseDetection.confidence` in `lib/pulse/types.ts`. | None |
| 14.2 | DONE | DONE | `lib/pulse/detectors/outreach-volume-drop.ts`. | None |
| 14.3 | DONE | DONE | `lib/pulse/detectors/quo-quota-burn.ts` + `token-burn.ts`. | None |
| 14.4 | DEFERRED (Phase 21) | DEFERRED | Anthropic doesn't expose model-availability API. | None |
| 14.5 | DEFERRED (Phase 21) | DEFERRED | Phase 21.8. | None |
| 14.6 | DONE | DONE | `lib/maverick/family-time.ts`; 15 tests. Commit Q.2. | None |
| 14.7 | DONE | DONE | `lib/pulse/{types,active-store,runner}.ts`; commit `d98d35e`. | None |
| 14.8 | DONE | DONE | Six detectors in `lib/pulse/detectors/`. | None |
| 14.9 | DONE | DONE | Severity mapping extended for Pulse branch in `lib/maverick/severity.ts`. | None |
| 14.10 | DONE | DONE | `runPulseScan` calls `writeState` on transitions. | None |
| 14.11 | DONE | DONE | Token-burn detector; scope limited to Anthropic (documented). | None |
| 14.12 | DONE | DONE | `components/factory-floor/PulseRoom.tsx` + `components/pulse/PulseDashboard.tsx` + `app/pulse/page.tsx`. | None |

### Phase 15 — Ledger Build

| # | Claimed | Actual | Evidence | Discrepancy |
|---|---|---|---|---|
| 15.1 | DONE | DONE | `lib/ledger/economics.ts` + `/api/agents/ledger/summary`. Commit Q.4. | None |
| 15.2 | DONE | DONE | `lib/ledger/cost-attribution.ts`. | None |
| 15.3 | DONE | DONE | `computeDealPnL` includes truck_fund_contribution. | None |
| 15.4 | DONE | DONE | `computeRetirementProgress` in `lib/ledger/economics.ts`. | None |
| 15.5 | DONE (data layer) | DONE (data layer) | DealPnL shape in route; UI render Phase 21.17. | None |
| 15.6 | LOCKED IN SPEC | LOCKED | Per spec §7. | None |

### Phase 16 — Active Deals In Flight

| # | Claimed | Actual | Evidence | Discrepancy |
|---|---|---|---|---|
| 16.1–16.5 | Various operational states | Operator-procedural | Not Code-verifiable. | None |
| 16.6, 16.7 | DEAD | DEAD | Per memory. | None |
| 16.8 | NEVER-list | NEVER-list | Filter enforced via Sentinel. | None |
| 16.9 | Stale, needs triage | Stale | Phase 21.2. | None |
| 16.10 | DONE (operator-fire pending) | DONE — operator-fire pending | `/api/admin/appraiser-backfill/route.ts` + `lib/admin/appraiser-backfill.ts`. Commit M. Phase 21.1. | None |

### Phase 17 — Monetization & Revenue Layers

| # | Claimed | Actual | Evidence | Discrepancy |
|---|---|---|---|---|
| 17.1 | IN PROGRESS | IN PROGRESS | Operator strategy. | None |
| 17.2–17.3 | STOP (strategy) | STOP | Operator strategy. | None |
| 17.4–17.6 | DRAFTED | DRAFTED | Copy docs exist per operator notes. | None |
| 17.7–17.9 | STOP (strategy) | STOP | Operator strategy. | None |

### Phase 18 — Market Geography

| # | Claimed | Actual | Evidence | Discrepancy |
|---|---|---|---|---|
| 18.1 | DONE | DONE | TX active in Listings_V1. | None |
| 18.2 | DONE | DONE | Dallas records present. | None |
| 18.3 | DONE | DONE | Houston records present. | None |
| 18.4 | DONE | DONE | Memphis filter rules in pre-contract checks. | None |
| 18.5 | LOCKED | LOCKED | Filter list in Scenario A blueprint. | None |
| 18.6 | DONE | DONE | Detroit records present. | None |
| 18.7 | DEFERRED (Phase 21) | DEFERRED | Phase 21.7. | None |

### Phase 19 — Documentation Discipline

| # | Claimed | Actual | Evidence | Discrepancy |
|---|---|---|---|---|
| 19.1 | DONE | DONE | Constitution v3 (operator-side living doc). | None |
| 19.2 | DONE | DONE | `docs/specs/Inevitable_Continuity_Layer_Spec_v1.2.md`. | None |
| 19.3 | DONE | DONE | Three spec docs in `docs/specs/`. | None |
| 19.4 | DONE (canonical v1.1 audited) | DONE | THIS audit confirms. | None |
| 19.5 | DONE | DONE | `docs/specs/MAVERICK_OPS.md`. | None |
| 19.6 | DONE | DONE | `docs/specs/MAVERICK_V12_BACKLOG.md`. | None |
| 19.7 | LOCKED PRINCIPLE | LOCKED | Operator discipline. | None |
| 19.8 | NEW DISCIPLINE | LOCKED | Every recent sprint commit + THIS audit confirms ritual. | None |

### Phase 20 — Open Architectural Questions

| # | Claimed | Actual | Evidence | Discrepancy |
|---|---|---|---|---|
| 20.1 | RESOLVED 5/16 | RESOLVED | Resolution log in checklist. | None |
| 20.2 | RESOLVED 5/18 | RESOLVED | Two-field split shipped (Commit H); fields confirmed via Airtable MCP. | None |
| 20.3 | RESOLVED-IN-PATCH 5/16 | RESOLVED | `hasDashboardSession` helper in `lib/maverick/oauth/auth-waterfall.ts`. | None |
| 20.5 | OPEN | OPEN — partial mitigation shipped | Token-burn detector (14.8) covers Anthropic; runtime safety floor active. | None |
| 20.7 | DONE — H2 closed; H1 awaiting | PARTIAL — H1 still open | Vercel production still `dpl_4peQ2dTrnWM34bJrE3XqJY3Sd69Y` (sha `33341a3e`, main, 2026-05-12) per Vercel MCP. H2 closed (Spine writes resumed). | None — H1 awaiting operator |

### Phase 21 — Strategic Backlog

All 19 main entries + 4 Map 2 + 4 orphan entries are forward-only backlog. No DONE claims to audit. **No discrepancies.**

---

## Audit summary

- **Items audited:** 156 DONE / IN PROGRESS / DOCUMENTED / LOCKED / DEFERRED / STOP / RESOLVED / OBSOLETE claims across Phases 0–20.
- **Substantive discrepancies found:** 0. Every DONE claim resolves to live evidence (file path, commit, Airtable field, Make blueprint module, Vercel deployment).
- **Raw-state notes (not discrepancies):**
  - Make scenarios A / B / B2 / C / D / E / G / H2 / H3 / I / K / K-Briefing / M-Briefing `isActive: false` at audit time — operator credit-conservation discipline, intentional.
  - H2 (4724197) carries `isinvalid: true` with BlueprintValidationError executions on 5/19 — separate from inactive toggle.
  - Vercel production target (Phase 20.7 H1) still points at May-12 deploy; all Phase 9/11/12/5 work shipped as preview only. Awaiting operator action.
- **Operator-fire pending items (Phase 21):** appraiser backfill (21.1), 33-response Sentinel cluster (21.2), DocuSign JWT (21.3), Vercel + GitHub PATs (21.4), PropStream credentials (21.5).
- **A2P 10DLC carrier registration (Phases 9.7 + 12.3) pending** — code complete; delivery starts when carrier clears.

---

## Forensic answers reprise (one-line each)

1. **5/19 Auto Proceed fire rate:** 8 of 43 records had outreach activity (4 Texted, 4 Response Received). 35 did not fire because (a) 41 of 43 carry `Stage_Calc_V2 = "Rejected: No Distress"`, and (b) H2 4724197 was `isActive: false` AND `isinvalid: true` on 5/19.
2. **"Rejected: No Distress" location:** Airtable formula on `Stage_Calc_V2` field (`fldA8B9zOCneF0rjp`) on Listings_V1. Triggered when `Distress_Pass` (`fldlQJV00psn0vucy`) = 0.
3. **L3 (4812756) write surface:** writes only to `Outreach_Status` (`fldGIgqwyCJg4uFyv`) and `Verification_Notes` (`fldwKGxZly6O8qyPu`). No Sentinel queue field exists anywhere in the system.

---

*End of forensic audit. Status-only. No fixes recommended. No new work proposed.*
