# INV-009 Brief — Date Formatting Bug (2001 vs 2026)

**Author:** Maverick (Owner's Rep)
**Date:** 2026-05-21
**Status:** BRIEFED, awaiting Code audit
**Severity:** UNKNOWN until reproduced — MEDIUM provisionally; HIGH if Q2 reveals persistence corruption

---

## 1. Symptom (from operator boot)

Conversation panel timestamps render as `5/6/2001` when source dates are `2026-05-06`. Likely YY parsing vs YYYY mismatch in deal-room conversation renderer.

Maverick has NOT personally reproduced. Q1 reproduces.

---

## 2. Pre-investigation findings (commit `38628cd` snapshot)

- Every `year:` formatter in dashboard uses `year: "2-digit"` exclusively. 8 call sites. No 4-digit-year output exists.
- No obvious 2-digit-year parse path found in dashboard.
- `lib/bulk-dead-annotation.ts:60–62` parses dates from formatted strings — but uses explicit 4-digit-year regex anchor `^(\d{4})-(\d{2})-(\d{2})$`. Safe.

**Most-probable failure modes (ranked):**
1. Airtable formula field outputting `DATETIME_FORMAT(field, 'MM/DD/YY')` consumed by downstream JS `new Date(...)`
2. Make scenario emitting 2-digit-year text, piped to JS consumer
3. Hand-edited Notes line being re-parsed
4. Display bug in single component using `toLocaleDateString` with 2-digit-year locale option

---

## 3. Forensic questions

**Q1 — Reproduce.**
Without operator's specific sighting, the bug is a needle in haystack. Approach:
1. Smoke-test every operator-visible date display surface in dashboard (Pipeline list, per-deal page, MorningBriefing, PropertyDetailsPanel, BroCard, timeline rendering)
2. Smoke-test Notes line generation paths (8 sites in `todayStamp()` re-definitions)
3. Smoke-test PropStream CSV intake (`process-intake/route.ts`) with `MM/DD/YY`-formatted test record
4. Smoke-test daysBetween / staleness math
5. Inspect every Airtable formula field on Listings_V1 using `DATETIME_FORMAT` — list each output token pattern

If no reproduction, surface that and request operator's specific sighting (which surface, which deal, which date).

Deliverable: exact surface, exact input, exact output, exact expected.

**Q2 — Root cause + persistence verdict.**
Once reproduced:
- Input data (what produced the wrong year)
- Format/parse step that mangled it
- Display surface that exposed it
- **Persistence verdict**: is the wrong year stored, or only displayed? HIGH severity if persisted; MEDIUM if render-only.

Deliverable: root cause + persistence verdict.

**Q3 — Blast radius.**
Once root cause known:
- How many records affected today?
- How many surfaces display the affected dates?
- Are downstream consumers (staleness math, dd-volley scheduling, EMD alerts, closing reminders) making wrong decisions based on the affected dates?

Deliverable: affected-record count + surface list + downstream-decision impact.

**Q4 — Forward-going prevention.**
- Discipline rule candidate: "All date persistence uses ISO 8601 4-digit-year format. All date display formatters are explicit; no `year: '2-digit'` for any value that may be re-parsed."
- Ban `year: "2-digit"` for non-display contexts project-wide?
- Consolidate `lib/date-format.ts` — replace 8 scattered `todayStamp()` re-definitions with a single audit surface?

Deliverable: discipline rule recommendation + consolidation candidate.

---

## 4. Resolution options (operator picks post-findings)

Cannot specify until Q1+Q2 land. Template:

- **A** — Fix specific bug only
- **B** — Fix + project-wide date discipline rule
- **C** — Fix + backfill corrupted data (required if Q2 = persistence)
- **D** — A+B+C combined

---

## 5. Out of scope

- 8 scattered `todayStamp()` re-definitions — code-duplication smell unrelated to bug per se. Q4 consolidation candidate
- Make scenario date-format conventions — distinct concern, file separately if implicated
- Airtable formula field date conventions — only in scope if Q1/Q2 implicates

---

## 6. Constraints

- Forward-going only by default. Backfill (Option C) is opt-in based on Q3.
- Proposal-before-commit
- No silent fixes — every record correction produces Spine entry naming record + corrected value
- Source-of-truth: if bug touches comms timestamps, Quo/Gmail are canonical, system layer is broken

---

## 7. Acceptance criteria

1. Q1–Q4 deliverables produced (or reproduction failure surfaced with request for operator sighting).
2. Operator selects A / B / C / D.
3. Code implements + tests covering the failing input case.
4. Spine entry via `maverick_write_state` (`event_type=principle_amendment` if discipline rule adopted else `build_event`, `attribution_agent=sentry` or `scribe`).
5. `AKB_MASTER_CHECKLIST.md` updated.
6. `Active_Queue.md` flips INV-009 to SHIPPED.
