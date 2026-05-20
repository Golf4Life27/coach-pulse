# Active Investigation Queue

Status: parallel-track to belt build
Discipline: each line = a discrete forensic investigation, briefed to Code separately. Findings discovered during one investigation that aren't in scope of THAT investigation are added to "Discovered during prior investigations" — they do NOT get worked silently.

## Active

1. **[INV-001] Distress_Pass evaluation integrity** — COMPLETED 2026-05-20 → `docs/investigations/Distress_Pass_Audit_v1.md` → REMEDIATION SHIPPED (Option α, Spine `rece3J2f0TbHXOuE2`)

2. **[INV-002] Listing_Condition persistence** — COMPLETED 2026-05-20 → `docs/investigations/Listing_Condition_Audit_v1.md` → REMEDIATION SHIPPED (Option A, Spine `recOB75kGmHzkPgKr`) — end-to-end runtime tests deferred to next intake cycle (Scenario A is `isActive: false`)

## Queued

3. **[INV-003] Stage_Calc V1 vs V2 sibling formulas** — INVESTIGATION COMPLETE 2026-05-20 → `docs/investigations/Stage_Calc_V1_V2_Audit_v1.md` → pending operator decision on remediation. Key findings: V1 has ZERO code/Make/operator consumers (vestigial post-V2-refactor artifact); V2 is consumed by exactly one downstream formula (`Execution_Path`); live divergence ~1% (2/200 sampled active records — both V1=Qualified V2=Rejected:Too Small, V2 catches SqFt gate that V1 lacks). Brief's Option A (deprecate V1, add MLS-date branch to V2) is lowest-cost given findings; Option D (keep both, formally scope) effectively rejected by Q4 evidence; operator picks A/B/C/D in chat.

4. **[INV-004] Crier stale-contact false-positive on fresh contracts** — Crier alert "32 days without contact" fired on 23 Fields Ave on 2026-05-20 despite binding agreement dated 2026-05-19 (one-day-old contract). Timestamp calculation likely keying off `Last_Outreach_Date` or similar SMS-only field, not last meaningful contact (which includes the just-signed agreement and presumably-recent email/Quo exchanges). Affects every freshly-contracted deal — false-positive surfaces noise on records that just moved forward. Brief: TBD.

5. **[INV-005] Phase 4B Rehab fallback when scrape + Street View both empty** — Rehab agent silent-blocks when both data paths return null (observed on 23 Fields Ave deal view: "listing scrape + Street View fallback both empty"). Should surface as Tier 1 operator action with manual-condition-input affordance, not a silent block. Related to INV-013 (vision-failure fallback) but a distinct mode: vision succeeds with no input data, vs. vision fails on bad call. Brief: TBD.

6. **[INV-006] Outreach_Status / Stage transition logic on signed contracts** — 23 Fields Ave shows `STAGE: ACCEPTED PENDING PA` on deal-room view, but adjacent dashboard view shows "Negotiating" badge AND RESPONSE DUE alert. Field-state inconsistency across views: stage field updated but downstream consumers (badge, alert system) read stale or different fields. Brief: TBD.

7. **[INV-007] Multi-listing-agent message attribution — CRITICAL** — COMPLETED 2026-05-20 → `docs/investigations/Multi_Listing_Agent_Attribution_Audit_v1.md` → STEP 1 REMEDIATION SHIPPED (Spine `rec5UVLsXktD8M8Mi`) — `/api/conversations/[id]` now consumes `scorePropertyMatch` with the same 0.6 confidence floor the AMBIGUOUS banner uses; visible leak closed. **STEP 2 DESIGN SPEC COMPLETE** → `docs/specs/Attribution_Layer_v1_Spec.md` → pending operator decision on sprint authorization (4-sprint plan; §8 open questions include storage substrate choice). When built, resolves INV-007 Step 2, INV-014, INV-015, INV-016, and the `scorePropertyMatch` unit-test gap.

8. **[INV-008] DD Checklist auto-extraction from comms chain** — DD Checklist shows 0/12 on 23 Fields despite operator stating DDs have been answered in conversation history (Quo + Gmail). No auto-extraction pipeline from comms content → structured DD fields. Manual click-tracking defeats system intent: the answers are already in the chain, the system just doesn't parse them. Brief: TBD.

9. **[INV-009] Date formatting bug — "2001" instead of "2026"** — Conversation panel timestamps render as "5/6/2001" etc. when source dates are 2026-05-06. Likely `formatString` or `Date` constructor issue in deal-room conversation renderer. Probably YY parsing vs YYYY mismatch. Brief: TBD.

10. **[INV-010] RESPONSE DUE alert false-positive contradicting deal stage** — Deal at `STAGE: ACCEPTED PENDING PA` but RESPONSE DUE alert flags "agent waiting on you." Needs stage-aware suppression: certain alerts should not fire past specific stage thresholds. Related to INV-006 but a distinct surface (alert system vs badge rendering). Brief: TBD.

11. **[INV-011] Make A vs Vercel intake-path divergence** — Discovered during INV-002. The two intake paths handle missing-condition differently (Make: silent drop; Vercel: pass) and handle Reject differently (Make: no row; Vercel: persists row with `Execution_Path = "Reject"`). Produces structurally different state for identical inputs. Worth a separate audit when Belt v1 spec §3.5 "Path 1 vs Path 2" decision lands. Brief: TBD.

12. **[INV-012] Condition_Score is a dead field** — Discovered during INV-002. `Condition_Score` (`fldkE6xgHeCvmyKJy`) declared on Listings_V1 with description "AI assessment of property condition from listing data (1-10 scale)" but zero code paths write it (codebase grep confirms). 0/50 records in 30-day sample populated. Either repurpose (and update description) or remove from schema. Low urgency; cleanup task. Brief: TBD.

13. **[INV-013] Phase 4B Rehab has no vision-failure fallback** — Discovered during INV-002. `/api/agents/appraiser/rehab/[recordId]` returns HTTP 502 with `vision_call_failed` and halts when Anthropic vision call fails — no fallback to any other condition signal. With `Listing_Condition` now persisted (post INV-002 remediation), the fallback would be a one-line addition: `vision.condition_overall ?? listing.listingCondition`. Brief: TBD.

14. **[INV-014] L3 winner-takes-all attribution** — L3 Make Scenario 4812756 (Reply_Triage_V3) Module 3 (`ActionSearchRecords`) uses `maxRecords: 1` with no sort order. When multiple Listings_V1 records share an Agent_Phone (common for multi-listing agents), L3 updates whichever record Airtable returns first — non-deterministic. Inbound messages can be attributed to any of the agent's listings depending on Airtable query order. Foundational to L3 reply-triage correctness. Should be wired through the unified attribution layer that lands in INV-007 Step 2. Brief: TBD.

15. **[INV-015] scan-comms cron fan-out** — `app/api/cron/scan-comms/route.ts` lines 228-262 groups listings by phone and, for each inbound message, creates an Agent_Proposals row for EVERY listing in the group. One Candice reply → 4 pending proposals, all referencing identical inbound body. Produces N duplicate proposals per actual reply; affects Sentinel queue cleanliness and operator review surface noise. Same redesign-path as INV-014 (unified attribution layer, INV-007 Step 2). Brief: TBD.

16. **[INV-016] `scorePropertyMatch` price-match misaligned** — `lib/timeline-merge.ts:54-60` matches body `$N,NNN` patterns against `targetPrice` (= `List_Price`). But H2 outbound bodies (`outreach-fire/route.ts:31-38`) contain the OFFER (≈ 65% × List_Price), not the list price. The +0.3 price-match bonus never fires correctly on H2 outbound. Attribution still works via token-match + "listing at" bonus (which together reach 0.8 confidence on standard H2 sends), but a designed signal is dead weight. Cheap to fix once confirmed with live H2 message bodies (compare against both `List_Price` and `Outreach_Offer_Price`). Brief: TBD.

## Discovered during prior investigations

- **[unnumbered] `scorePropertyMatch` has no unit-test coverage** — Discovered during INV-007 Step 1 remediation. `lib/timeline-merge.test.ts` does not exist. The scorer is now consumed by `mergeTimeline()` AND `/api/conversations/[id]` directly, plus three indirect surfaces (`/api/deal-context`, `/api/multi-listing-detect`, AMBIGUOUS banner). Coverage is overdue. Not a separate audit candidate — better tracked as a test-add ticket alongside whoever picks up INV-016 (since that's the one that requires re-running scorer scenarios).

## Discipline notes

- Investigations are DISCOVERY briefs by default — no fixes, no code changes, no field updates without operator authorization.
- Each investigation produces a written report at `docs/investigations/<topic>_Audit_v<N>.md`.
- Remediation, if authorized, is a separate work item logged in the originating audit report's "Remediation outcome" appendix.
- New findings during an investigation get appended to this queue's "Discovered during prior investigations" section before the investigation closes.

**Naming discipline:** When an investigation surfaces new findings during its work, Code adds them to "Discovered during prior investigations" using temporary local numbering. Operator promotes them to formal queue items with assigned INV-NNN numbers in the same commit as the next queue update. Prevents numbering collisions; queue file is single source of truth for INV identifiers.

**Backfill policy:** Pre-Inevitable Crawler 1.0 records (created by prior system iterations) are NOT backfilled by remediations. Forward-going behavior changes apply to records created after the remediation date. Historical records age out via normal deal lifecycle. Purging/archiving pre-Inevitable records is a separate operator decision flagged for future consideration.
