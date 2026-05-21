# INV-005 Brief — Phase 4B Rehab Fallback When Scrape + Street View Empty

**Author:** Maverick (Owner's Rep)
**Date:** 2026-05-21
**Status:** BRIEFED, awaiting Code audit
**Severity:** HIGH (Appraiser silent-blocks on records with no scrapable photos; 14 active deals currently without rehab data, exposure size unknown)
**Pair-with:** INV-013 (vision-failure 502 fallback) — distinct failure mode, same resolution surface

---

## 1. Symptom

`GET /api/agents/appraiser/rehab/[recordId]` returns HTTP 422 `no_photos_available` when both:
- Listing scrape (Firecrawl/Redfin) returns 0 photos
- Street View fallback returns 0 photos

No rehab fields written. Pricing layer cannot compute Investor MAO. Operator has no system-generated rehab anchor.

Compounding: route also rejects `skip_photos=1` with hardcoded `skip_photos_unimplemented` and comment *"no fallback rehab path without vision; supply photos"*. **Zero manual-input affordance.**

Anchor case: 23 Fields Ave 38109, recordId `rec1HTUqK0YEVb7uA`. Verified at audit-start time (2026-05-21) that 14 active deals had no Appraiser data.

---

## 2. Forensic questions

**Q1 — Production blocking count.**
For all `Live_Status=Active AND Outreach_Status != Dead`, how many would currently return `no_photos_available`? Run `collectPhotos()` against each. Breakdown:
- Empty results with `verificationUrl` populated (scrape pipeline failing despite URL)
- Empty results with incomplete address (Street View can't try)

Deliverable: count + recordId list + cause breakdown.

**Q2 — Photo-source robustness audit.**
Inspect `lib/photo-sources.ts` (or wherever `collectPhotos` lives). Document:
- Listing-scrape strategy (Redfin only, or multi-source?)
- Street View fallback (cone/radius/heading combos?)
- Retry logic on transient failure
- Photo URL caching

Goal: surface low-hanging improvements before committing to manual-input affordance.

Deliverable: documented strategy + improvement candidates filed as separate INV candidates.

**Q3 — Manual-input affordance surface.**
Candidates:
- α: New `AppraiserRehabPanel.tsx` "Override" mode
- β: New `POST /api/agents/appraiser/rehab/[recordId]/manual` route
- γ: Failed-vision Action Queue card with "Set manual rehab" button

Compare on operator workflow + Lost-Phone-Test friction.

Deliverable: surface comparison + recommendation.

**Q4 — Provenance flag.**
Downstream consumers (deal-math, pricing-intelligence, BroCard) need to know if `Est_Rehab` came from vision or manual entry. Schema choices:
- New `Rehab_Source` field (enum: `vision`, `manual_operator`, `manual_partner`)
- Reuse `Rehab_Confidence_Score` semantics
- Add `source` key inside `Rehab_Line_Items_JSON`

Document choice + list of consumers needing the read.

---

## 3. Resolution options (operator picks post-findings)

- **A** — Minimal manual-input affordance (new route + UI override + provenance flag)
- **B** — Improve photo sources first, ship A after
- **C** — **REJECTED on policy grounds** — heuristic auto-fallback violates fabrication prohibition (memory #12) unless explicitly re-authorized
- **D** — Hybrid: A now, B research-tracked

---

## 4. Out of scope (file as separate INVs if confirmed)

- Photo source diversification (Zillow, Realtor.com scrape) — Phase 4B.3 candidate
- INV-013 vision-failure 502 path — distinct from INV-005's no-photos 422 path; resolutions should share manual-input route + provenance flag
- Appraiser hasn't run on 14 active deals — orthogonal invocation-trigger issue, not in INV-005 scope

---

## 5. Constraints

- Forward-going only. No backfill of pre-Inevitable records.
- Proposal-before-commit. Code reports Q1–Q4; operator picks A/B/D.
- Fabrication prohibition. No auto-estimate without source-snippet or evidence.
- Buyer-facing comms discipline — rehab provenance never leaks to buyer surfaces.

---

## 6. Acceptance criteria

1. Q1–Q4 deliverables produced.
2. Operator selects A / B / D.
3. Code implements + writes tests covering: manual write succeeds, manual write sets provenance correctly, vision-path provenance set, deal-math respects manual rehab.
4. Spine entry via `maverick_write_state` (`event_type=principle_amendment`, `attribution_agent=appraiser`).
5. `AKB_MASTER_CHECKLIST.md` updated.
6. `Active_Queue.md` flips INV-005 to SHIPPED.
