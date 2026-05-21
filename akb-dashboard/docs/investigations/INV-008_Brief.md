# INV-008 Brief — DD Checklist Auto-Extraction from Comms Chain

**Author:** Maverick (Owner's Rep)
**Date:** 2026-05-21
**Status:** BRIEFED, awaiting Code audit
**Severity:** MEDIUM (parser already runs; gap is persistence — operator workload + state-machine asymmetry)
**Pair-with:** INV-006 (same architectural pattern: system has the signal, canonical field doesn't reflect it)

---

## 1. Symptom

`lib/dd-parser.ts` already runs on every `/api/dd-status/[recordId]` fetch. Detects informally-answered DD items via regex against inbound timeline. Returns `ddInformalAnsweredItems` + per-item evidence (snippet + timestamp).

**No write-back to formal `DD_Checklist` field.** Informal hits live only in API response. Operator must manually tick every DD item even when the answer is in the chain.

Consequences:
- State-machine asymmetry: `ddCheckedItems` = formal ∪ informal at API read time; only `DD_Checklist` (formal) persists. Different consumers see different truths.
- Operator workload: every DD answer in inbound = manual tick (~12 ticks/deal × ~50 deals/month = 600 clicks/month)
- Cross-surface inconsistency: Make scenarios, exports, raw Airtable views see one truth; dashboard sees another
- Volley logic risk: `nextVolleyToFire()` skips volleys when informally answered, but operator manual unchecks can produce divergence

INV-008 is INV-006's twin in a different field. Both ask: when the system has the signal, should the canonical Airtable field auto-update?

---

## 2. Forensic questions

**Q1 — Parser accuracy audit.**
For each of the 12 DD V3.0 items, run parser against historical inbound data and document:
- True-positive rate (parser said answered, operator agrees)
- False-positive rate
- False-negative rate

Sample size: ≥20 records with `Outreach_Status` ∈ {Response Received, Negotiating, Offer Accepted} and non-trivial inbound history.

Deliverable: per-item TP/FP/FN scorecard. Items <90% TP flagged as "do not auto-persist."

Pre-investigation read of `RULES` array (lib/dd-parser.ts):
- High-confidence patterns: Vacancy/Occupancy, Utility Status (specific tokens)
- Medium-confidence: Roof Age, HVAC Age, Electrical, Plumbing Age (topic mention vs disclosure)
- HIGH false-positive risk: Water Heater Age (matches bare `\bwater\s+heater\b`)
- Not yet inspected: 6 other items — Q1 verifies

**Q2 — Cross-source drift cohort.**
For all active records:
- How many have ≥1 informal-only item?
- How many have ≥5?
- Max informal-only count on a single record?

Deliverable: drift cohort size + distribution.

**Q3 — Architectural placement.**
- α: Inline write in `/api/dd-status` GET handler (anti-pattern: side effect on GET)
- β: Dedicated cron reconciler (mirrors INV-006 pattern — pure helper + thin orchestration shape)
- γ: Triggered on L3 Reply_Triage inbound arrival (best latency, cross-service coordination cost)
- δ: Operator-approval queue UI — parser hits surface as one-click suggestions (lowest risk, highest workload reduction)

Document operator workflow each implies + Lost-Phone-Test alignment.

Deliverable: surface comparison + recommendation.

**Q4 — Provenance + undo.**
- How to distinguish auto-ticked vs operator-ticked?
- If operator unchecks auto-ticked item, does reconciler re-tick? (Stomp risk.)
- Audit trail format — Notes line per auto-tick with source snippet + timestamp?

Mirrors INV-006's idempotency-via-Notes-marker design. Likely reusable.

Deliverable: provenance + override + undo matrix.

---

## 3. Resolution options (operator picks post-findings)

- **A** — Operator-approval queue only (Q3-δ). Parser output = one-click suggestions, nothing auto-writes
- **B** — Cron reconciler for high-confidence items only (Q3-β + Q1 filter)
- **C** — Cron reconciler for all items
- **D** — Hybrid: B now + tighten parser rules over time, graduate items as TP rates pass threshold
- **E** — Decline / keep parser decorative

Maverick's lean: D mirrors INV-006's hybrid pattern. Cron architecture reuses INV-006 infrastructure (pure-helper + Notes-marker idempotency).

---

## 4. Out of scope

- DD volley template content (`lib/dd-volley.ts`)
- DD scorecard / `canCounter` / `canSignPA` gating
- Pattern rule tightening for lower-confidence items (distinct workstream)
- PA / Purchase Agreement signing flow

---

## 5. Constraints

- Forward-going only
- Proposal-before-commit
- Operator override priority (manual edits always win)
- Quo + Gmail = canonical comms truth; parser is metadata layer (Belt v1 §6)
- Fabrication prohibition — only persist what regex matched against real timeline text + source snippet evidence

---

## 6. Acceptance criteria

1. Q1–Q4 deliverables produced.
2. Operator selects A / B / C / D / E.
3. Code implements + tests if A–D.
4. Spine entry via `maverick_write_state` (`event_type=principle_amendment`, `attribution_agent=scribe` — DD Checklist is Scribe's domain).
5. `AKB_MASTER_CHECKLIST.md` updated.
6. `Active_Queue.md` flips INV-008 to SHIPPED.

---

## 7. Compounding payoff

~50 deals/month × ~12 DD items = ~600 ticks/month. If auto-persist covers half at high confidence, ~300 operator clicks/month removed. Direct Lost-Phone-Test progress.
