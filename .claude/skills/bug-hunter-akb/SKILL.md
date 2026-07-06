---
name: bug-hunter-akb
description: Hunt bugs in the AKB Inevitable system the way a senior debugger would — reproduce server-side first, read the AKB evidence trail in order (audit_log, Vercel logs, the record itself, Spine history, git), fix the cause not the symptom, prove the original failing case now passes, then pair the fix with a Spine write. Use whenever something is broken — "hunt this bug", "debug this properly", "why is this failing", "it's still broken", "you said it was fixed" — and with extra suspicion on any second report of the same bug.
---

# Bug Hunter — AKB

The default failure mode of AI debugging is a guess wearing a fix's clothes: "I can see the likely problem," a plausible change, "that should sort it," and the real bug alive under a patch. In this system that pattern has a signature move all its own — **re-queueing the job until it passes** — and it once burned four hours of API calls at five-minute intervals. This skill is the procedure that prevents the spiral.

## The one rule

**Never fix what you haven't reproduced — server-side, on demand.** A fix without a reproduction is a hope. If the bug can't be made to happen at will, *reproduction is the current task*, not fixing. And per the standing operational rule: Code operates — the reproduction is a route, a script, or a server-side run. The operator is never handed a curl.

## When it triggers

- Anything broken: an error, a wrong output, a flow that stopped, an agent looping.
- The second report of the same bug — fires this skill with heightened suspicion of the first "fix."
- Works in one environment, fails in another.

## The method

### 1. Reproduce on demand

The exact failure, at will, server-side: the route hit, the input record, the state that triggers it. Capture the *actual* output — full error text, never a paraphrase. If it won't reproduce: gather what's missing or add the instrumentation that will catch it next occurrence, and say plainly "not reproduced yet" instead of fixing blind.

### 2. Read the AKB evidence trail — in this order

1. **audit_log** — agent, event, record, timestamps. The loop shape, the first failure, what changed between fail and pass.
2. **Vercel logs** — runtime + build, around the audit timestamps.
3. **The record itself** — including embedded histories (`read_history` JSON, Notes timelines). Records remember what logs forget.
4. **Spine recall** — prior decisions and amendments touching this path. Yesterday's "bug" is sometimes last month's ruling.
5. **git log/diff since last known-good** — if it used to work, something changed; the diff is evidence, not archaeology.

When errors cascade, walk back to the **first** one. The loudest error is usually a casualty, not the cause.

### 3. Hypotheses, one at a time

Rank candidate causes. Test the cheapest as an *experiment* — "if this is the cause, I expect to see X" — then look. Instrument the boundary between working and broken with temporary logging. One variable per test; changing three things and watching the bug vanish teaches nothing and usually plants the next one.

### 4. Fix the cause, not the symptom

Gate before any change: **explain in one sentence why the code produced exactly this behavior.** If the fix doesn't follow from the explanation, the cause hasn't been found. Banned moves — they hide bugs instead of fixing them:

- a try/catch that makes the error quiet
- a fallback value that masks the failure
- special-casing the one input that failed
- retry-until-pass
- **re-queueing or re-scheduling a job to "clear" it** — the house speciality; a job that re-runs forever without a done-gate is a bug, not a retry policy

### 5. Prove it, then hunt siblings

Re-run the step-1 reproduction — the exact failing case must now pass. Exercise the neighbors of the change. Then, while the cause is fresh, sweep the codebase for the same mistake pattern elsewhere — causes have siblings.

### 6. Leave a trace

Remove temporary instrumentation. Keep the reproduction as a test where the suite allows — and the suite stays green. Write the one-line cause note. **A shipped fix is a commit paired with a `maverick_write_state` build_event** — an unlogged fix is a lesson the system will pay for twice.

**Escalation rule:** three hypotheses dead in a row → stop, don't thrash. Package the hunt log (reproduction, ruled-out list, evidence) and take it to the smartest model available. The evidence transfers; the log is exactly what lets a stronger model finish in one pass.

## The standards

- No code changed before reproduction — or before an explicit "can't reproduce, here's what I need."
- Every hypothesis stated *before* it's tested; one variable at a time.
- The fix explained cause-first, in a sentence the owner understands.
- "Should be fixed" never appears. "The case that failed now passes" does — with the re-run shown.
- Instrumentation removed, cause note written, Spine write paired, suite green.

## The output

The bug fixed, plus the short hunt log: reproduction · cause in one sentence · what changed and why · proof the original case passes · siblings found (or "none").

## The honest limits

- Races, ghosts, and environment-specific failures resist on-demand reproduction. Degrade honestly: closest-possible repro, instrument the gap, state the confidence level — never claim certainty.
- A manual gives a smaller model the right *order*; it doesn't grant a senior's nose for the weird. That's what the three-dead-hypotheses escalation is for.
- If the code does exactly what a wrong spec told it to, that's not a bug — it's an operator decision (Type 2C). Surface it; don't "fix" doctrine in a debug session.

---
*v1.0 · 2026-07-06 · AKB-native prose. Supersede only via a logged Spine build_event referencing this version — never a silent edit.*
