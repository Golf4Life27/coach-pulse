> **How to report to Alex:** follow `.claude/skills/plain-language-reporting/SKILL.md` (repo root) in every session — scoreboard line first, plain language, decisions as yes/no with defaults.

@AGENTS.md

# Load the spine first — every session, before acting

These are the as-built truth and the hard rules. Read them before touching anything:

1. **`docs/INVARIANTS.md`** — the hard rules (geographic exclusions IL/MO/SC/NC/OK/ND, sticky offers, pessimistic rehab bounds, operator gates, the Firecrawl spend brake). Never break one; if a change appears to require it, stop and escalate to the operator.
2. **`docs/handoffs/AS_BUILT.md`** — entry points (routes/crons), data flow, where state lives (Airtable / Vercel KV), what is gated dark (`H2_OUTREACH_HARD_DISABLE` et al.), and the honest known-broken/unverified list.
3. **`docs/handoffs/SYSTEM_HANDOFF.md`** — the operator narrative + charter.

To eyeball the gate + pricing spine without secrets: `npm run dry-run-trace`.

# Send discipline — HARD RULES (incident 2026-07-30, Canfield, Spine recJesmOUJXksQ11V)

An operator manual apology (sent from the Quo app, never ingested into notes) was
followed by a Claude-driven close-out into the same thread — the batch agent had
HELD the send and was overridden on a misread ruling. These rules are code and
contract, not preference:

1. **The live thread outranks record notes — always.** `sendGuarded` enforces
   this physically (thread-truth check: unrecorded outbound or unseen inbound in
   the live Quo thread → REFUSE). Any Claude-driven send that bypasses the gate
   (raw REST from a session) MUST pull the live thread tail for that number in
   the same turn and read it before sending. Record notes are history, never
   send-authority.
2. **Least-send interpretation.** A terse operator statement about a thread maps
   to the reading that sends LESS. If two plausible readings differ in whether a
   message fires, ask one line first. (Two misreads on 2026-07-30 — "Contingent"
   on 8th Ct, "peppered him" on Canfield — both converted context into sends.)
3. **Agent holds are re-verified, never overruled from memory.** If a subagent
   refuses or holds a send, overriding requires re-checking the hold's premise
   against LIVE thread data — a recollection of an operator ruling is not
   sufficient grounds.

# Write the spine back — the moment you make a durable decision (not at session end)

Continuity failed for months because sessions LOAD Maverick at open but never WRITE
back — so the spine silently drifts behind reality and the next session inherits
**stale** truth (worse than empty: it looks authoritative). The read path works; the
write path was discretionary and got skipped. Do not let that recur:

- The instant you ship a durable decision, principle change, or build event, **call
  `mcp__Maverick__maverick_write_state` immediately** — not at session end. Sessions end
  abruptly; compaction and crashes eat un-written context. One decision = one write, as
  it happens.
- **A git commit that changes doctrine, pricing, gates, or system behavior IS a durable
  decision** — write it to the Maverick spine in the same breath as the commit (a
  `build_event`, `principle_amendment`, `decision`, or `deal_state_change`).
- Keep the file spine current too: `docs/INVARIANTS.md`, `docs/handoffs/AS_BUILT.md`,
  `docs/handoffs/SYSTEM_HANDOFF.md`, `docs/system/SYSTEM_FACTS.md`.
- A **Stop hook** (`.claude/hooks/maverick-continuity-check.sh`) refuses to let a session
  end with commits but no spine write — it is a backstop, not permission to defer. Write
  as you go.

# Delegate the build work down-tier — operator ruling 2026-09-06 (Spine recZ8ukn1iLKpVHeT)

Operator, verbatim: "Deploy lower level agents to fix that to save Fable credits. That
needs to be a rule established." Model spend is under the same cash constraint as EMD.

- **Bounded engineering work goes to a subagent on a lower-tier model** via the Agent
  tool — `model: "sonnet"` by default, `"haiku"` for mechanical work (renames, fixture
  updates, log reads). That covers: a bug fix with a known cause, a new test, a refactor,
  a lane or route change, a backfill script, a docs edit. Anything touching more than one
  file or needing a new test goes down-tier; a one-line pattern or typo may stay in-session.
- **The session model keeps the judgment work:** diagnosis from the evidence trail
  (audit_log, Vercel logs, the record, spine, git), deciding what the fix should be,
  reviewing the subagent's diff before merge, any number that reaches a seller (pricing
  doctrine), operator-facing reports, and every spine write.
- **The brief is the deliverable of the parent.** Give the subagent: the evidence, the
  failing case, the constraints (YAGNI, never loosen a test or a gate, no model names in
  code/commits), the validation commands (`npx vitest run`, `npx tsc --noEmit`), and the
  exact git mechanics (branch, commit trailers, push; the parent opens the PR).
- **Merge stays with the parent:** read the diff, run the checks, open the PR, drive it to
  green, merge under the standing default, verify the deploy, write the spine.
- If a subagent's result fails review twice, the parent takes the task over — no loops.

> Note: `AGENTS.md` (imported above) says **Hobby / daily-cron cap** — that is **STALE**. Production is Vercel **Pro** (sub-daily crons are live in `vercel.json`; see AS_BUILT §0). Don't architect around a daily-cron limit that no longer applies.
