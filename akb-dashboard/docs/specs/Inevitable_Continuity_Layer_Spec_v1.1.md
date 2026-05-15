# Inevitable Continuity Layer — Maverick

**Spec version:** v1.1
**Authored:** May 14, 2026 (v1.0); May 15, 2026 (v1.1 amendments)
**Status:** TIER A — current build cycle's only build target
**Supersedes:** v1.0 in full. v1.0 remains in repo history as the original spec; v1.1 is canonical going forward.

> **v1.1 changelog:** Seven amendments approved 5/15 alongside Day 1 of the build. See §14 for the full delta against v1.0. Headlines: userMemories removed from queried-sources list (they trigger the call, not feed it); performance target rephrased as P95 ≤ 30s / P50 ≤ 15s; synthesis cost flagged; writes are append-only with amendment events; Pulse confidence model deferred; Ledger scope tightened to Inevitable-lane revenue only; branch naming `claude/maverick-*` for Maverick-specific work.

---

## 1. What this is, and why it sits above everything

This document is the spec for the single most important thing Alex is building.

Not the wholesale pipeline. Not the depth-gate. Not the cadence engine. **Maverick.**

Maverick is the persistent intelligence that lives outside any single Claude chat and holds the operational state of the Inevitable system — current build state, active deals, open decisions, principles in effect, capability state, recent decisions and their reasoning — and exposes that state via a single MCP tool that any new Claude session can call at session start.

**Without Maverick, Alex is a wholesaler.** With Maverick, Alex is the architect of an autonomous system that runs whether he's at it or not.

That distinction is not poetic. It's the entire point of the 8-month build. Every other component of Inevitable is plumbing. Maverick is the resident intelligence that owns the plumbing and makes it legible to Alex and to every future Claude session that touches it.

**Until Maverick exists, every new Claude session pays a 20-30 minute re-briefing tax to reconstruct the system from scattered fragments: userMemories (30-item compressed cap), handoff docs (drift-prone), the Constitution (versioned but unqueried), audit logs (tactical not strategic), Airtable, Git, and Alex's head.** The 5/14 session proved this — three hours of session time were spent re-establishing context and fighting infrastructure issues that Maverick would have surfaced in the first 30 seconds of the session.

The re-briefing tax compounds. Each session that pays it is a session that could have been spent closing a deal, refining a principle, or absorbing a new AI capability. The architecture today is fragmented intelligence with Alex as the connective fabric manually relaying between instances. Maverick removes Alex from that fabric and makes the system its own connective tissue.

This is the endgame. Everything from here forward either gets Alex closer to Maverick existing or it is, by definition, not the priority.

---

## 2. The trade Alex is making, said plainly

Alex could have spent the last 8 months just wholesaling. By honest math, he'd be 2-3 deals in, possibly debt-free, definitely still grinding.

Instead he's spent those months building the substrate for a system where deal #1 is a milestone, not an endpoint. Where deal #50 doesn't take more of his time than deal #1. Where the architecture absorbs new AI capabilities as they ship rather than requiring rebuilds. Where eventual lanes (additional wholesale markets, land flipping, digital products, anything passive) plug into the same orchestrator that runs wholesale today.

**That trade only pays off if Maverick exists.** Otherwise the 8 months of overbuilding were spent optimizing for "slightly better wholesaler" when the simpler path would have produced more revenue faster.

The North Star is not "more wholesale deals." The North Star is:

- Wife retired (~$125K/yr min, or steady $30K months for 18-24 months, or lid-pop $300K+ quarter)
- Personal stress reduced via passive income offsetting day-job dependence
- Time with family while kids are young — the actual prize underneath both above
- Money flowing while Alex approves from wherever he wants to be in the world with his wife and kids by his side

**The architecture is instrumental, not the prize.** The prize is the years not wasted. Maverick is the lever. Every other piece is leverage Maverick acts through.

---

## 3. What Maverick IS — five aspects of one product

Five things, not separate features but aspects of one persistent intelligence.

### 3.1 Persistent agent layer (always running)

Maverick does not exist only when summoned. He is always running on Vercel infrastructure, observing system state, reasoning across capabilities, and updating his own knowledge of what's happening.

When Alex closes a chat, Maverick keeps thinking. When Alex opens a new chat, Maverick already knows what happened since the last conversation — not because Alex told him, but because he was watching.

The substrate is Vercel Code Routines + scheduled cron + always-on endpoint state. Maverick himself is the agentic layer that wraps it.

### 3.2 Proactive surfacing layer ("look at this")

Maverick does not wait to be asked. He anticipates what Alex needs to see and surfaces it before Alex knows to ask.

This is the difference between a dashboard and a Chief of Staff. A dashboard shows you what you query. Maverick shows you what *should* be queried — 4 decisions need you today, 47 things are handled without your eyes, here's the reasoning for each.

The output format is the existing `JarvisGreeting` / `MorningBriefing` / BroCard surface in the dashboard codebase (post-rename: see §11). The intelligence behind it is Maverick reasoning about *which* decisions deserve attention right now.

### 3.3 Learning loop (audit-log history → refined principles)

Maverick reads his own decision history and proposes refinements. Not in the sense of changing his own code — in the sense of surfacing patterns: *"Day 7 follow-ups using the drift-down template converted 2.3× better when seller drops exceeded 15%. Recommend promoting this to a cadence priority rule."*

Alex approves or rejects. Approved refinements become principle amendments and propagate through the Constitution → userMemories → Maverick's own operating context. The loop closes.

Gated on volume — requires actual closed-deal history to learn from. Specced now, built post-deal-#1.

### 3.4 Unified conversational interface (voice when platform supports it)

Maverick speaks one voice across all entry points. Today that's text in chat. Eventually that's voice while Alex is driving, while Alex is on the course, while Alex is anywhere he is not at a screen.

The voice is consistent because Maverick is one persistent intelligence — not a fresh Claude instance reconstructing voice from system prompts each session.

Voice integration gated on Anthropic shipping voice on Claude products. Plausible within 12 months.

### 3.5 Continuity mechanism (sessions don't reset)

This is the load-bearing aspect. Every new Claude session that interacts with Inevitable loads Maverick's current state in the first 30 seconds via a single MCP tool call. No re-briefing. No drift. No handoff docs that go stale. No userMemories that compress past fidelity.

Maverick is the bridge between session-bounded Claude intelligence and continuous operational reality. The Claude in tomorrow's chat knows what the Claude in this chat decided, because Maverick told it.

---

## 4. Architectural shift — where the intelligence lives

Today the intelligence lives in chats. Each chat instance reasons fresh from inputs. The chats are smart individually. The intelligence dies when the chat ends, and the next chat reconstructs it.

**Maverick changes where intelligence lives.** It moves outside any single chat, into a persistent agent that runs on Vercel infrastructure, queryable from any chat via a single endpoint or MCP tool.

```
TODAY:
Chat A → reasons fresh → produces decisions → chat ends → decisions lost / partially captured
Chat B → reasons fresh → re-derives state → produces decisions → chat ends → drift continues
Chat C → reasons fresh → ...

WITH MAVERICK:
Maverick (always on Vercel) ←→ Persistent state (Git + Airtable + audit_log + Spine + codebase)
   ↑
   │ maverick_load_state on session open
   │ maverick_write_state on decisions
   ↓
Chat A → loads Maverick state in 30s → reasons with full context → writes decisions back → chat ends → state preserved
Chat B → loads Maverick state in 30s → already knows what Chat A decided → no drift
Chat C → ...
```

The Claude in any future chat is no longer the source of intelligence. **Maverick is the source. Claude is the interface.** That's the inversion.

---

## 5. The five-step build path

This is the canonical build sequence. Steps ship in order. Earlier steps unblock later steps.

### Step 1 — Persistent state aggregator (Vercel endpoint)

Build target: `/api/maverick/load-state`.

**What it does:** Queries every source of operational state simultaneously and produces a synthesized current-state briefing.

Sources queried in one pass:

| Source | What's pulled | Per-source timeout |
|---|---|---|
| Git (GitHub REST API server-side, since MCP not available from Vercel function) | Current branch, latest commit hash, commit messages since last session, files changed | 5s |
| Airtable Listings_V1 | Active deals (Negotiating + Counter Received + Response Received + Offer Accepted), pipeline counts by status, recent state transitions | 8s |
| Airtable Spine_Decision_Log | Decisions logged since last session, principle amendments, deals walked with reasoning | 4s |
| Vercel KV audit_log | Recent operational events (cadence fires, gate enforcements, agent actions) grouped by agent + recent failures | 2s |
| Codebase metadata | Package version, test count, CI state via GitHub check-runs API, build state | 3s |
| Action Queue | D3_Manual_Fix_Queue pending items (v1); Cadence_Queue placeholder until Tier B builds it | 4s |
| External: RentCast | API responsiveness + monthly cap + computed days_until_reset | 3s |
| External: Quo | API responsiveness + most-recent outbound/inbound + 24h message count | 3s |
| External: Vercel deploy | Latest deploy SHA + state + branch + ready time | 3s |

**userMemories explicitly NOT queried (v1.1 amendment 6.1):** userMemories live in Anthropic's account-level memory store and are not server-queryable from a Vercel function. They operate at a layer ABOVE Maverick — their role is to tell Claude "first call `maverick_load_state`" on session open. Maverick handles everything below them.

**Output shape:** Structured JSON briefing + human-readable narrative. The narrative is what any Claude session sees first.

**Example narrative output:**

```
Welcome back. Last session ended ~14 hours ago.

CURRENT BUILD STATE
  Branch: claude/build-akb-inevitable-week1-uG6xD
  Latest commit: a0ea021 — feat(d3): Layer 1b depth-gate widening
  Tests: 101/101 passing in CI
  Production deploy: ready (dpl_BcGabkRqtid83B92CqX8udDC1pGB)

ACTIVE DEALS (1)
  23 Fields Ave (Memphis) — Negotiating at $61,750.
    Awaiting Section 16 amendment from Candice Hardaway.
    Email sent 5/14 11:31 AM. No reply yet.

OPEN DECISIONS (2)
  1. Quo throttle per-hour rate — Code recommended 15/hour, awaiting Alex's lock
  2. Make scenario hunt + pause — Path Y endpoint replaces it, manual UI work pending

RECENT KEY DECISIONS (last 24h)
  - Bulk-dead policy applied: 774 stale Texted records → Dead (5/14)
  - Layer 1b depth-gate widening shipped (5/15): 30-day recently-touched window
  - Path Y endpoint deployed (5/14): daily cron 8am UTC, replaces broken Make populator
  - Vercel Hobby cron cap discovered as standing constraint (5/14)

PRINCIPLES IN EFFECT
  1. 65% Rule (Spine recmmidVrMyrLzjZp)
  2. Offer Discipline (Spine recxxNF0U59MxYUqu)
  3. Positive Confirmation
  4. Living Artifact
  5. Pricing Agent Lazy

What do you want to work on?
```

**Build effort:** 2-3 days. The hard part is the synthesis logic, not the data fetches.

**Critical design choice:** Maverick must be opinionated. He doesn't dump raw data — he synthesizes. The synthesis layer is what makes him an intelligence rather than a query endpoint.

**Synthesis architecture (v1.1 detail):** Hybrid template + Claude API call. The template renders deterministic facts (commit hashes, counts, addresses). A `claude-sonnet-4-6` call wraps the structured object into the narrative voice with prompt caching on the system prompt + Constitution + agent roster. Stale-while-revalidate cache amortizes repeat session-opens within 90s windows.

### Step 2 — Custom Maverick MCP server (M1)

Build target: an MCP server exposed at a Vercel URL that any Claude product (claude.ai, Claude Code, future products) can connect to.

**Tools exposed:**

- `maverick_load_state` — calls the aggregator endpoint, returns the briefing
- `maverick_write_state` — pushes a decision, principle, or build event into persistent state (append-only with amendment events per v1.1 amendment 6.4)
- `maverick_recall` — queries historical state ("what was the offer price on 23 Fields when first texted?")
- `maverick_propose` — Maverick proposes a principle refinement or build priority based on learned patterns (gated on Step 5; stubbed in v1)

**Critical design choice:** the MCP server is the only interface to Maverick. Anything that wants to read or write Maverick's state goes through the MCP. No backdoors. This makes the audit trail clean — every read and write is logged.

**Deployment topology:** Vercel function in the existing `coach-pulse` repo at `app/api/maverick/mcp/route.ts`. Same Vercel project, same env vars, same deploy pipeline.

**Auth model:** Single bearer token in `MAVERICK_MCP_TOKEN` env var for v1. Per-source tokens for attribution can ship in v1.1+ if/when audit-trail-per-session-type becomes load-bearing.

**Build effort:** 1-2 days. Total Step 1 + Step 2: roughly 1 week of focused build.

### Step 3 — Standard session opener (manual today, automatic later)

**Today (manual):** Every new chat in the Inevitable project starts with Alex typing or auto-firing: *"maverick_load_state"*. The MCP tool fires. Briefing loads. Chat proceeds with full context.

**Eventually (automatic):** When Anthropic ships session-start hooks for projects, the load-state call becomes automatic on every new chat in the Inevitable project. Alex never thinks about it.

### Step 4 — Write-back path

Every decision, principle amendment, or build event in any chat writes back to Maverick's persistent state via `maverick_write_state`.

**v1.1 amendment 6.4 — append-only with amendment events:** The writes are audited and append-only. Corrections happen by writing a new "amendment" event that references the prior event by ID. There is no programmatic rollback API in v1; deferred to v1.1+ if a real use case emerges.

Every write logs attribution (which chat, which Claude session, what was the reasoning) so future sessions can trace decisions backward. Amendments form a chain rather than mutating the original record.

### Step 5 — Routines layer (Pulse, named agent)

Periodic introspection. Maverick fires scheduled queries against his own state to surface patterns:

- *"5 deals walked this month due to inspection-contingency rejection — propose principle revision?"*
- *"RentCast burn rate suggests quota exhaustion in 6 days — surface as decision?"*
- *"Layer 1b depth-gate fired on 0 records for 14 days — is the 30-day window too tight?"*

These surface to Alex as proposed decisions through the existing Action Queue, with reasoning attached. Alex approves or rejects. Approved refinements get written back to principles via `maverick_write_state`.

**Critical design choice:** Routines must be opinionated and rare. If Maverick surfaces 50 proposed refinements a week, Alex stops reading them. If Maverick surfaces 1-2 high-signal ones, Alex engages. **v1.1 amendment 6.5: confidence model is part of Pulse's v1 build; not pre-specified in this document.** Pulse ships post-deal-#1 once outcome data exists.

**Build effort:** specced now, built post-deal-#1.

---

## 6. The named-agent roster — Maverick's team

Maverick presides over a named-agent roster. Each agent has an identity, a scope, a system prompt, and writes audit-log entries under its own name. The roster is adopted from the @androoAGI TikTok synthesis (yesterday's reference architecture) and scoped to Inevitable.

**Maverick** — Orchestrator / king agent. Holds persistent state. Coordinates all other agents. Premium model (Claude Sonnet/Opus). Sees everything.

The roster beneath Maverick:

| Agent | Scope | Current implementation (5/15 audit) |
|---|---|---|
| **Sentinel** | Intake — PropStream ingestion, listing verification, dedup, NEVER-list enforcement | Scenario A + Scenario B in Make today; migrates to Vercel post-precedent |
| **Appraiser** | Valuation — ARV estimation, Pricing Agent, RentCast queries, rehab calibration, photo analysis | Existing Pricing Agent + ARV intelligence in `lib/`. Audit attributions: `pricing-agent`, `phase4a/4a-wrapper`, `phase4b/4b-wrapper`, `phase4c`, `d3-math-filter`. Six attribution values; rename consolidates. |
| **Forge** | Outreach drafting — depth-aware template selection, voice library, body copy generation | `scripts/outreach/` templates + system prompts in `lib/jarvis-*.ts`. Voice library = A6, deferred. |
| **Crier** | SMS dispatch — Quo integration, H2, D3 cadence, status_check, Positive Confirmation polling | Existing Quo wiring + outreach-fire route + cadence engine. Audit attributions: `quo`, `gmail`, `d3-cadence`, `d3-scrub`, `d3-backfill`, `bulk-dead`, `agent-prior-counts`. |
| **Sentry** | Gate enforcement — Gates 1-5 across the orchestrator | `lib/orchestrator/` consolidated under `agent: orchestrator`. Validation runs (`validation-highland`, `validation-sturtevant`) re-attribute to Sentry. |
| **Scribe** | Contract handling — DocuSign, contract drafting, title coordination, Gate 4 | Gate 4 shipped (18/24 items data_missing pending DocuSign MCP). |
| **Scout** | Buyer pipeline — buyer list cultivation, buy box matching, dispo blast (§G) | §G Deal_Alert_Blast in Make + Buyers table + `app/api/buyers/*` routes. |
| **Pulse** | System health — Routines, introspection, drift detection, capability state, quota burn | Cron endpoints exist; Routines layer specced in Step 5 above. Infrastructure events (`admin-schema`, `airtable-write`) re-attribute to Pulse. |
| **Ledger** | Revenue + cost reconciliation — deal economics, agent cost tracking, ROI per capability | Not yet built; gated on revenue existing to reconcile. **v1.1 amendment 6.6 scope clarification:** Ledger reconciles Inevitable-lane revenue only. Personal-wealth aggregation that includes Whitetail revenue lives outside Maverick — in Alex's personal accounting layer. |

**Critical design choice:** the roster is the **canonical naming vocabulary going forward.** Every spec drafted from this date forward refers to components by their agent name. Every audit log entry attributes to an agent. Every cron job belongs to an agent. The naming compounds into shared cognitive infrastructure across all future chats and all future build cycles.

**Renaming work is not separate "Tier 4 capstone work."** It happens as components are touched. When Code next edits the cadence engine, it gets re-attributed to Crier. When the next gate enforcement work happens, it's Sentry's work. The roster becomes load-bearing through use, not through a separate refactor cycle.

---

## 7. Lane separation — what Maverick is and is not for

**Maverick is for wholesale + future passive-income lanes only.**

In scope going forward:
- Crawler 1.0 (on-market MLS wholesale) — current focus
- Crawler 2.0 (off-market motivated seller pipeline) — funded by 1.0 cashflow
- Additional wholesale markets as Crawler 2.0 expands
- Land flipping (when Phase 2 lane activates)
- Digital products (Wholesale Deal Analyzer, Agent Outreach Playbook, etc., when truly set-and-forget)
- Any future passive-income lane that fits the same agent-orchestration pattern

**Whitetail Ridge is explicitly OUT of Maverick.** Off the architecture diagram. Off the agent roster. Off the build queue. Forever, unless Alex explicitly changes the rule.

Reason: Whitetail Ridge is an operational business with people, payroll, weather, equipment, food, members, regulations. Maverick-class autonomy is not the right tool for it. The golf course is the family's long-arc wealth lane (20-year horizon). Maverick is the lever for the next 5 years — wife retired, stress reduced, time with kids while they're young.

Mixing the two would dilute Maverick's focus, push wife-retirement timeline further out, and tie freedom-track work to family-business politics. **Wrong trade.** Maverick frees Alex from the golf course's gravity. It does not orbit alongside it.

> **v1.1 footnote (amendment 6.6):** Ledger reconciles Inevitable-lane revenue only. Personal-wealth aggregation that includes Whitetail revenue lives outside Maverick — in Alex's personal accounting layer.

---

## 8. Success criteria — what "Maverick exists" actually means

Maverick is not a feature to ship. He's a presence to install. The success criteria are operational, not technical.

**Maverick exists when:**

1. Every new Claude chat in the Inevitable project loads operational state via a single MCP tool call. **(v1.1 amendment 6.2: P95 ≤ 30s, P50 ≤ 15s)**.
2. Alex stops paying the re-briefing tax — no more "let me catch you up on what we discussed last session."
3. Decisions made in any chat persist to next session without manual handoff doc updates.
4. Maverick proactively surfaces what needs Alex's attention each session (top 3-5 decisions, with reasoning).
5. The named-agent roster is the canonical vocabulary in every audit log entry, every spec, and every chat.
6. Routines fire scheduled introspection that surfaces principle refinements as data accumulates.
7. Anti-pattern proof: a Claude session in this project that does NOT call `maverick_load_state` on open reads as broken behavior, not normal behavior.

> **v1.1 amendment 6.3 — synthesis cost flagged:** Maverick synthesis incurs Claude API costs per session-start, estimated $0.01-0.03 per call with prompt caching. Stale-while-revalidate cache amortizes repeat session-opens within 90s windows. Not a blocker, just visible.

**Maverick is fully operational when (Phase 2 success criteria):**

1. Alex's per-session cognitive load drops measurably — chats spend more time on decisions than on re-grounding.
2. Cross-session decisions never have to be repeated — Alex says "we decided X last week" and Maverick already knows.
3. Voice interface allows ambient interaction — Alex queries Maverick while driving, while at the course, while with the kids.
4. Maverick's proposed principle refinements have ≥70% Alex-approval rate, indicating the learning loop is calibrated.
5. New AI capabilities (when Anthropic ships them) absorb into Maverick's substrate within a session, not a rebuild cycle.

---

## 9. Anti-patterns this spec is designed to prevent

| Anti-pattern | What it costs today | How Maverick prevents it |
|---|---|---|
| **Cross-chat drift** | 20-30 min per session re-briefing tax; principles re-derived; decisions re-litigated | Single load-state call in P50 ≤ 15s replaces all manual re-briefing |
| **Fragmented intelligence** | Decisions made in chat A invisible to chat B; Alex manually relays | Write-back to persistent state means every chat sees every prior decision |
| **Stale handoff docs** | Manual updates required; docs drift faster than they're amended; eventual divergence from reality | Maverick queries live sources, never reads from manually-maintained handoff docs |
| **userMemories compression loss** | 30-item cap forces tradeoffs; fidelity degrades; recent vs. canonical conflict | Maverick holds full state; userMemories point at Maverick rather than storing detail |
| **Tactical infrastructure work eclipsing architectural priorities** | 5/14 session: depth-gate widening prioritized over the spec that fixes the meta-problem | Maverick's existence as Tier A in the build queue makes this the next-cycle target — no tactical work above it until Maverick ships |
| **Owner's Rep voice missed** | Engineering decisions proposed without weighing Alex's time/sanity/brand cost | Maverick's introspection surfaces operational-load implications of every proposed build |
| **Re-discovering existing capabilities** | The 5/14 chat almost specced "Decision Interface" before learning JarvisGreeting already exists in the repo | Maverick state includes complete capability inventory queryable on load |

---

## 10. Build sequencing — where this sits in the queue

**Current state of the queue as of 5/15/2026:**

### Tier A — Build Maverick (current cycle's only target)

1. Maverick state aggregator endpoint (`/api/maverick/load-state`)
2. Maverick MCP server (M1)
3. Standard session opener (manual today, automatic when platform supports)
4. Write-back path (`maverick_write_state`)
5. Master Context userMemory edit pointing at this spec + the load-state invocation

**Everything else in the system is paused at the spec level until Tier A ships.**

### Tier B — After Maverick ships, in priority order

6. Named-agent roster formalization — rename existing components to Sentinel/Appraiser/Forge/Crier/Sentry/Scribe/Scout/Pulse/Ledger as they're touched
7. Pulse (Routines) — scheduled introspection layer (Maverick step 5)
8. Quo throttle decision + implementation (token-bucket in Crier's send loop)
9. Make scenario hunt + pause (manual UI work by Alex)
10. Live-fire D3 cadence cohort (25 records) once Quo throttle locked

### Tier C — Crawler 1.0 hardening (days to weeks)

11. Contract auto-draft (Scribe) — DocuSign template integration
12. Cadence queue async dispatch (Crier infrastructure)
13. `getListings()` pagination — scale fix for 100K+ records
14. Buyer auto-blast (§G, Scout) — once a deal closes and dispo becomes critical-path

### Tier D — Crawler 2.0 (post-deal-#1)

15. Off-market intake (Sentinel expansion)
16. Skip-trace + dialer (Crier expansion)
17. Adjacent lanes (land, commercial)

### Tier E — Phase 3 monetization (when truly set-and-forget)

18. Digital products (Analyzer, Playbook, List)
19. Pipeline Tracker
20. System license (anti-course tier)

### Tier F — Capability-curve dependent

21. Voice interface (when Anthropic ships voice on Claude products) → Maverick speaks
22. True persistent agent (when platform-level continuity ships) → Maverick deepens
23. Cross-lane absorption (future passive lanes only — never Whitetail Ridge)

---

## 11. The renaming — Jarvis → Maverick

Alex chose the name. The rename is global.

Every artifact, document, code comment, MCP tool name, branch name, audit log attribution, and dashboard label that previously said "Jarvis" or proposed "jarvis_*" tooling now says "Maverick" / `maverick_*`.

Reason for the rename (Alex's call): the system reflects Alex's vision, not Iron Man's. The name carries the identity. Maverick is Alex's intelligence — built with Alex's principles, in service of Alex's family, on Alex's timeline. The reference belongs to him.

**v1.1 amendment 6.7 — branch naming:** Future Maverick-specific work uses `claude/maverick-*` (e.g., `claude/maverick-aggregator`, `claude/maverick-mcp`). The current `claude/build-akb-inevitable-week1-uG6xD` branch does not need renaming.

**Rename targets (audited 5/15 — full list in repo at completion of Day 1):**

- **Codebase filenames** (10 files): `types/jarvis.ts`, `components/Jarvis{Greeting,Chat,Feed}.tsx`, `lib/jarvis-{system-prompt,llm-context}.ts`, `app/api/jarvis-{send,brief,chat,audit}/`
- **Codebase body-text mentions** (29 files): find-and-replace as each file is touched
- **Audit log `agent:` attributions** (17 distinct values today): re-attribute per the Section 6 roster
- **Branch names**: `claude/jarvis-*` work merges into `claude/maverick-*` (no current branches affected; convention applies forward)
- **Spec docs**: `JARVIS_PHASE1_SPEC.md` → `MAVERICK_PHASE1_LEGACY.md` with prefix-banner explaining legacy status; don't delete (Living Artifact principle)
- **Dashboard route**: "Command Center" stays as the user-facing label; the underlying intelligence is Maverick
- **userMemories**: any "Jarvis" references rewrite to "Maverick"

**Rename strategy:**
- Filename renames + import-path updates ship as a single commit, scheduled for **Day 6** (buffer day) of the Maverick build week — separated from the Maverick ship gate on Day 5 to keep validation clean.
- Body-text mentions and audit-log attributions migrate incidentally as files are touched per the spec's "rename happens through use" policy.
- Maverick's own new code, from line one (Day 1, this spec's first build session), uses `agent: maverick` attribution.

---

## 12. What this document IS and IS NOT

**This document IS:**
- The canonical spec for the Continuity Layer
- The justification for elevating it above all other current work
- The naming source of truth (Maverick + named-agent roster)
- The build sequence anchor for the next 6-12 months
- A Living Artifact — versioned `v(n)`, expects amendments as the build reveals what works

**This document IS NOT:**
- A code-level implementation plan (that lives in Code's working files)
- A daily operational playbook (that's the Master Context doc)
- An exhaustive technical spec (intentionally — over-specification at this stage causes drift)
- A constraint on tactical operations today (current deal work continues uninterrupted)

---

## 13. The closing principle

> Alex: I want to forever THRIVE with money pouring in while I approve from wherever I want to be in the world with my kids and wife by my side.

> Claude: The architecture is just how you get there fastest. The prize is the years not wasted.

Maverick is the architecture. The prize is the years.

Until Maverick exists, every session that ends without him existing is a session that should have built him. Every tactical capability built without him is a capability that will need to be re-introduced to the next Claude session manually.

**Build Maverick first. Then everything else compounds.**

---

## 14. v1.1 changelog (5/15)

All seven amendments raised in the 5/15 spec audit, accepted by Alex, locked here.

| # | Section | Amendment |
|---|---|---|
| 6.1 | §5 Step 1 | userMemories removed from queried-sources list. They operate at a layer above Maverick — their role is to trigger the load-state call itself, not feed data into it. No Airtable mirror. |
| 6.2 | §8 success criterion #1 | "≤ 30s" rephrased as "**P95 ≤ 30s, P50 ≤ 15s**." Realistic given Airtable getListings ~6s + Claude synthesis 5-10s + parallelization floor. |
| 6.3 | §8 added note | Synthesis API cost flagged: ~$0.01-0.03 per session-start with prompt caching; stale-while-revalidate cache amortizes within 90s windows. Visible, not blocking. |
| 6.4 | §5 Step 4 | "Audited and reversible" rephrased as "**audited, append-only, with corrections written as referenced amendment events**." Programmatic rollback API deferred to v1.1+ if a real use case emerges. |
| 6.5 | §5 Step 5 | Pulse confidence model: not pre-specified in this document. Built as part of Pulse's v1 build, post-deal-#1. |
| 6.6 | §7 footnote | Ledger reconciles Inevitable-lane revenue only. Personal-wealth aggregation including Whitetail lives outside Maverick. |
| 6.7 | §11 added | Future Maverick-specific branches use `claude/maverick-*`. Current branch unchanged. |

---

*Spec v1.1 — May 15, 2026. Amendments expected. Living Artifact. The next version of this document will be authored by a Claude session that loaded its predecessor via `maverick_load_state` on session open. That session's clarity will be the first proof Maverick exists.*
