# Active Investigation Queue

Status: parallel-track to belt build
Discipline: each line = a discrete forensic investigation, briefed to Code separately. Findings discovered during one investigation that aren't in scope of THAT investigation are added to "Discovered during prior investigations" — they do NOT get worked silently.

## Active

1. **[INV-001] Distress_Pass evaluation integrity** — COMPLETED 2026-05-20 → `docs/investigations/Distress_Pass_Audit_v1.md` → REMEDIATION SHIPPED (Option α, Spine `rece3J2f0TbHXOuE2`)

2. **[INV-002] Listing_Condition persistence** — COMPLETED 2026-05-20 → `docs/investigations/Listing_Condition_Audit_v1.md` → REMEDIATION SHIPPED (Option A, Spine `recOB75kGmHzkPgKr`) — end-to-end runtime tests deferred to next intake cycle (Scenario A is `isActive: false`)

## Queued

3. **[INV-003] Stage_Calc V1 vs V2 sibling formulas** — both formulas exist on Listings_V1 with identical gate logic but different rejection-string copy. Discovered during INV-001. Likely migration artifact, V1 deprecation candidate. Lower urgency. Brief: TBD.

4. **[INV-004] Crier stale-contact false-positive on fresh contracts** — Crier alert "32 days without contact" fired on 23 Fields Ave on 2026-05-20 despite binding agreement dated 2026-05-19 (one-day-old contract). Timestamp calculation likely keying off `Last_Outreach_Date` or similar SMS-only field, not last meaningful contact (which includes the just-signed agreement and presumably-recent email/Quo exchanges). Affects every freshly-contracted deal — false-positive surfaces noise on records that just moved forward. Brief: TBD.

5. **[INV-005] Phase 4B Rehab fallback when scrape + Street View both empty** — Rehab agent silent-blocks when both data paths return null (observed on 23 Fields Ave deal view: "listing scrape + Street View fallback both empty"). Should surface as Tier 1 operator action with manual-condition-input affordance, not a silent block. Related to INV-013 (vision-failure fallback) but a distinct mode: vision succeeds with no input data, vs. vision fails on bad call. Brief: TBD.

6. **[INV-006] Outreach_Status / Stage transition logic on signed contracts** — 23 Fields Ave shows `STAGE: ACCEPTED PENDING PA` on deal-room view, but adjacent dashboard view shows "Negotiating" badge AND RESPONSE DUE alert. Field-state inconsistency across views: stage field updated but downstream consumers (badge, alert system) read stale or different fields. Brief: TBD.

7. **[INV-007] Multi-listing-agent message attribution — CRITICAL** — INVESTIGATION COMPLETE 2026-05-20 → `docs/investigations/Multi_Listing_Agent_Attribution_Audit_v1.md` → pending operator decision on remediation. Root cause: five independent attribution behaviors across the system (deal-context, conversations, L3, scan-comms, multi-listing-detect). Recommended path (c) — surgical fix at `/api/conversations/[id]` to close visible leak + architectural redesign (persist attribution at ingest in a `Comms_Attribution` table) to close all five paths.

8. **[INV-008] DD Checklist auto-extraction from comms chain** — DD Checklist shows 0/12 on 23 Fields despite operator stating DDs have been answered in conversation history (Quo + Gmail). No auto-extraction pipeline from comms content → structured DD fields. Manual click-tracking defeats system intent: the answers are already in the chain, the system just doesn't parse them. Brief: TBD.

9. **[INV-009] Date formatting bug — "2001" instead of "2026"** — Conversation panel timestamps render as "5/6/2001" etc. when source dates are 2026-05-06. Likely `formatString` or `Date` constructor issue in deal-room conversation renderer. Probably YY parsing vs YYYY mismatch. Brief: TBD.

10. **[INV-010] RESPONSE DUE alert false-positive contradicting deal stage** — Deal at `STAGE: ACCEPTED PENDING PA` but RESPONSE DUE alert flags "agent waiting on you." Needs stage-aware suppression: certain alerts should not fire past specific stage thresholds. Related to INV-006 but a distinct surface (alert system vs badge rendering). Brief: TBD.

11. **[INV-011] Make A vs Vercel intake-path divergence** — Discovered during INV-002. The two intake paths handle missing-condition differently (Make: silent drop; Vercel: pass) and handle Reject differently (Make: no row; Vercel: persists row with `Execution_Path = "Reject"`). Produces structurally different state for identical inputs. Worth a separate audit when Belt v1 spec §3.5 "Path 1 vs Path 2" decision lands. Brief: TBD.

12. **[INV-012] Condition_Score is a dead field** — Discovered during INV-002. `Condition_Score` (`fldkE6xgHeCvmyKJy`) declared on Listings_V1 with description "AI assessment of property condition from listing data (1-10 scale)" but zero code paths write it (codebase grep confirms). 0/50 records in 30-day sample populated. Either repurpose (and update description) or remove from schema. Low urgency; cleanup task. Brief: TBD.

13. **[INV-013] Phase 4B Rehab has no vision-failure fallback** — Discovered during INV-002. `/api/agents/appraiser/rehab/[recordId]` returns HTTP 502 with `vision_call_failed` and halts when Anthropic vision call fails — no fallback to any other condition signal. With `Listing_Condition` now persisted (post INV-002 remediation), the fallback would be a one-line addition: `vision.condition_overall ?? listing.listingCondition`. Brief: TBD.

## Discovered during prior investigations

- **[INV-014 candidate] L3 winner-takes-all on multi-listing-agent phone matches** — Discovered during INV-007. Make Scenario 4812756 (Reply_Triage_V3) Module 3 (`ActionSearchRecords`) uses `maxRecords: 1` with no sort order. When multiple Listings_V1 records share an Agent_Phone (common for multi-listing agents), L3 updates whichever record Airtable returns first — non-deterministic. Updates to Outreach_Status and Verification_Notes may land on the wrong listing. Should be wired through the same attribution layer as the INV-007 Step 2 redesign.

- **[INV-015 candidate] scan-comms cron fan-out on multi-listing-agent inbound** — Discovered during INV-007. `app/api/cron/scan-comms/route.ts` lines 228-262 groups listings by phone and, for each inbound message, creates an Agent_Proposals row for EVERY listing in the group (`for (const listing of matchedListings)`). One Candice reply → 4 pending proposals, all referencing identical inbound body. Operator triages 4 cards when only one is real. Same redesign-path as INV-014.

- **[INV-016 candidate] `scorePropertyMatch` price-match likely misaligned** — Discovered during INV-007. `lib/timeline-merge.ts:54-60` matches body `$N,NNN` patterns against `targetPrice` (= `List_Price`). But H2 outbound bodies (`outreach-fire/route.ts:31-38`) contain the OFFER (≈ 65% × List_Price), not the list price. So the +0.3 price-match bonus likely never fires correctly on H2 outbound. Needs live verification with a sample of H2 message bodies. Cheap to fix once confirmed (compare against both List_Price and Outreach_Offer_Price).

## Discipline notes

- Investigations are DISCOVERY briefs by default — no fixes, no code changes, no field updates without operator authorization.
- Each investigation produces a written report at `docs/investigations/<topic>_Audit_v<N>.md`.
- Remediation, if authorized, is a separate work item logged in the originating audit report's "Remediation outcome" appendix.
- New findings during an investigation get appended to this queue's "Discovered during prior investigations" section before the investigation closes.

**Naming discipline:** When an investigation surfaces new findings during its work, Code adds them to "Discovered during prior investigations" using temporary local numbering. Operator promotes them to formal queue items with assigned INV-NNN numbers in the same commit as the next queue update. Prevents numbering collisions; queue file is single source of truth for INV identifiers.

**Backfill policy:** Pre-Inevitable Crawler 1.0 records (created by prior system iterations) are NOT backfilled by remediations. Forward-going behavior changes apply to records created after the remediation date. Historical records age out via normal deal lifecycle. Purging/archiving pre-Inevitable records is a separate operator decision flagged for future consideration.
