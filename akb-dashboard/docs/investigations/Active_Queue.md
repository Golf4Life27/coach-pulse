# Active Investigation Queue

Status: parallel-track to belt build
Discipline: each line = a discrete forensic investigation, briefed to Code separately. Findings discovered during one investigation that aren't in scope of THAT investigation are added to "Discovered during prior investigations" — they do NOT get worked silently.

## Active

1. **[INV-001] Distress_Pass evaluation integrity** — COMPLETED 2026-05-20 → `docs/investigations/Distress_Pass_Audit_v1.md` → REMEDIATION SHIPPED (Option α, Spine `rece3J2f0TbHXOuE2`)

2. **[INV-002] Listing_Condition persistence** — INVESTIGATION COMPLETE 2026-05-20 → `docs/investigations/Listing_Condition_Audit_v1.md` → pending operator decision on remediation (Options A / B / C; recommendation: A)

## Queued

3. **[INV-003] Stage_Calc V1 vs V2 sibling formulas** — both formulas exist on Listings_V1 with identical gate logic but different rejection-string copy. Discovered during INV-001. Likely migration artifact, V1 deprecation candidate. Lower urgency than INV-002. Brief: after INV-002 ships.

## Discovered during prior investigations

- **[INV-004 candidate] Make A vs Vercel intake-path divergence** — Discovered during INV-002. The two intake paths handle missing-condition differently (Make: silent drop; Vercel: pass) and handle Reject differently (Make: no row; Vercel: persists row with `Execution_Path = "Reject"`). Produces structurally different state for identical inputs. Worth a separate audit when Belt v1 spec §3.5 "Path 1 vs Path 2" decision lands.

- **[INV-005 candidate] Condition_Score is a dead field** — Discovered during INV-002. `Condition_Score` (`fldkE6xgHeCvmyKJy`) declared on Listings_V1 with description "AI assessment of property condition from listing data (1-10 scale)" but zero code paths write it (codebase grep confirms). 0/50 records in 30-day sample populated. Either repurpose (and update description) or remove from schema. Low urgency; cleanup task. May resolve naturally if INV-002 Option C ever revisited.

- **[INV-006 candidate] Phase 4B Rehab has no vision-failure fallback** — Discovered during INV-002. `/api/agents/appraiser/rehab/[recordId]` returns HTTP 502 with `vision_call_failed` and halts when Anthropic vision call fails — no fallback to any other condition signal. With Listing_Condition persisted (post INV-002 remediation), the fallback would be a one-line addition. Without INV-002 remediation, the gap is harder to close. Worth re-evaluating after INV-002 ships.

## Discipline notes

- Investigations are DISCOVERY briefs by default — no fixes, no code changes, no field updates without operator authorization
- Each investigation produces a written report at `docs/investigations/<topic>_Audit_v<N>.md`
- Remediation, if authorized, is a separate work item logged in the originating audit report's "Remediation outcome" appendix
- New findings during an investigation get appended to this queue's "Discovered during prior investigations" section before the investigation closes
