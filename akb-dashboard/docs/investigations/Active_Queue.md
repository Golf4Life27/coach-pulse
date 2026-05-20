# Active Investigation Queue

Status: parallel-track to belt build
Discipline: each line = a discrete forensic investigation, briefed to Code separately. Findings discovered during one investigation that aren't in scope of THAT investigation are added to "Discovered during prior investigations" — they do NOT get worked silently.

## Active

1. **[INV-001] Distress_Pass evaluation integrity** — COMPLETED 2026-05-20 → `docs/investigations/Distress_Pass_Audit_v1.md` → REMEDIATION IN PROGRESS (Option α, this commit)

## Queued

2. **[INV-002] Listing_Condition persistence** — signal is filtered at intake (Scenario A condition gate: Poor/Disrepair/Average) but never persisted to Listings_V1 record. Discovered during INV-001 (Distress_Pass audit). High-leverage: once persisted, enriches Distress_Bucket inputs and unblocks Phase 4B Rehab calibration. Brief: 2026-05-21.

3. **[INV-003] Stage_Calc V1 vs V2 sibling formulas** — both formulas exist on Listings_V1 with identical gate logic but different rejection-string copy. Discovered during INV-001. Likely migration artifact, V1 deprecation candidate. Lower urgency than INV-002. Brief: after INV-002 ships.

## Discovered during prior investigations

(empty)

## Discipline notes

- Investigations are DISCOVERY briefs by default — no fixes, no code changes, no field updates without operator authorization
- Each investigation produces a written report at `docs/investigations/<topic>_Audit_v<N>.md`
- Remediation, if authorized, is a separate work item logged in the originating audit report's "Remediation outcome" appendix
- New findings during an investigation get appended to this queue's "Discovered during prior investigations" section before the investigation closes
