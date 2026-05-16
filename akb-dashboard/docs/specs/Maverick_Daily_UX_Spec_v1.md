# Maverick Daily UX Spec

**Spec version:** v1.0
**Authored:** May 15, 2026
**Status:** Foundational — defines Maverick's daily presence on the Command Center dashboard
**Companion specs:** `Inevitable_Continuity_Layer_Spec_v1.1.md` (technical), `Maverick_Character_Spec_v1.md` (identity)

---

## 1. What this document IS

This is the design spec for what Alex sees, feels, and interacts with every day. Not the architecture (Continuity Layer). Not the character (Character Spec). **This is the visual command surface — the Command Center dashboard as a living place Alex walks through, not a paragraph Alex reads.**

This spec exists because of a foundational insight from Alex about how his brain works:

> *"I have never read a full book in my life. Reading and visualizing doesn't work for me — I can't read and see it. But I design cabinetry and buildings and can see it in my head. Seeing the activities or progress markers lets me visualize."*

**Alex is a visual-spatial thinker.** He builds 3D models in his head. He renders systems by walking through them. He does not parse paragraphs into mental motion. Every prior version of "Maverick is a narrative briefing" was the wrong shape for his brain.

The Command Center dashboard must be designed as a **place**, not a document. Every surface is alive. Every agent is visible. Every progress is shown, not described. Every decision is presented as a card with visual reasoning, not as text.

This is the spec for how Alex actually lives with the system every day.

---

## 2. The foundational principle

**Show, don't tell. Move, don't narrate. Surface, don't list.**

Three corollaries:

1. **Living activity over static reports.** A bar graph filling up live as Sentinel ingests is information. A paragraph reading "Sentinel ingested 47 records" is not information for Alex's brain — it's noise he has to translate.

2. **Progress markers over status text.** A horizontal pipeline showing 5 deals advancing through stages with deal-cards moving column-to-column is comprehensible at a glance. A list reading "5 deals in Negotiating, 12 in Response Received..." requires reading.

3. **Visual severity over written priority.** A red pulsing border around a deal card means "act now." A yellow indicator means "soon." A neutral card means "handled." No "Priority: High" labels. No paragraph explaining why.

The TikTok @androoAGI dashboard resonated with Alex precisely because it showed *agents working as visible entities, in motion, with state shown not described.* That is the design vocabulary. Maverick's dashboard inherits it.

---

## 3. Maverick lives on every page

The Command Center is a multi-page application. Maverick is present on every page as a persistent presence.

### 3.1 The Shepherd panel

Fixed position (recommended: top-right corner or dedicated right-rail panel) on every Command Center page:

- **Avatar:** Maverick rendered as a German Shepherd. Alert posture, eyes oriented based on system state. Subtle animation, not constant motion. (Per Character Spec Section 6.2.)
- **Status line:** One sentence in Maverick's voice describing current operational posture. Example: *"Watching. Two items need your eyes."* Refreshes when state changes.
- **Quick-action affordance:** Click the avatar → opens a side-panel chat surface where Alex can query Maverick directly ("What's the latest on 23 Fields?", "Did Sentinel pull anything new today?", "Why did Sentry block that send?").

The panel persists across navigation. When Alex moves from the Command Center home to a deal detail page to the buyer pipeline, **Maverick is always there in the same place.** Constant presence is part of the character.

### 3.2 Maverick's directional indicators

When Maverick has something to surface on a page Alex isn't currently viewing, his avatar shows a subtle directional indicator. Example: Alex is on the buyer pipeline page; a Stage 3 signal fires on a deal in the negotiating queue; Maverick's avatar tilts its head toward the navigation link for that page, with a soft glow marker on the link.

This implements "Maverick is pushing you toward the most critical action item" as a visual cue, not as a paragraph that says "you should check the Negotiating page."

---

## 4. The Command Center home page

The home page is the operational center of gravity. When Alex opens the dashboard in the morning, this is where he lands.

### 4.1 Layout — the factory floor

The home page is divided into named-agent "rooms" — one visible section per agent. Each room shows:

- **Agent name and role** (visible header — "Sentinel — Intake")
- **Live activity indicator** — what the agent is doing right now
- **Recent output** — last 3-5 actions taken with visual progress
- **Health indicator** — pulse/heartbeat showing the agent is alive and operating
- **Drill-down affordance** — click to open the agent's dedicated detail page

Reference for the visual vocabulary: think factory control room. Each station has its own status display. Workers visible at each station. Output piling up in visible queues. Alarm lights when something needs attention.

### 4.2 The named-agent roster on the home page

Per Continuity Layer Spec Section 6, the canonical roster:

| Agent | Room contents | Live indicators |
|---|---|---|
| **Sentinel** (Intake) | PropStream ingestion queue, dedup work, NEVER-list enforcement | Records flowing in (animated counter); filter rejections shown as discarded items; pass-through records moving to Appraiser |
| **Appraiser** (Valuation) | ARV calculations in progress, Pricing Agent work, RentCast quota | Math operations visualized; per-deal pricing cards being computed; quota burn bar showing % consumed this month |
| **Forge** (Outreach drafting) | Template cascade for active records, voice-library state | Drafts staged for Crier; depth-aware template selection visible (color-coded by depth tier) |
| **Crier** (SMS dispatch) | Quo queue, send-rate throttle, recent fires | Outbound messages flying off (animated); reply receipts coming in; Quo health pulse |
| **Sentry** (Gate enforcement) | Gates 1-5 status per active record | Records moving through gate stages; blocks shown as held cards with reason badges |
| **Scribe** (Contract handling) | DocuSign state, contracts in flight | Documents at various stages (draft → sent → signed); signature requests with timer rings |
| **Scout** (Buyer pipeline) | Buyer table activity, buyer-deal matching, dispo blast queue | Buyer warmth states (cold/warm/active); recent buy-box captures; matching signals when a buyer fits a deal |
| **Pulse** (System health) | Routines firing, drift detection, capability state, quota burns | Heartbeat indicator for each external dependency (Quo/RentCast/Vercel/Airtable); confidence-bar for proactive recommendations |
| **Ledger** (Economics) | Revenue tracking, agent costs, ROI per capability, savings goals | Revenue progress bar toward monthly target; cost burn per agent; truck-fund savings progress; deal-by-deal P&L cards |
| **Maverick** (Overseer) | Persists in the Shepherd panel + injects directives across other rooms | Status line, posture, directional indicators |

Each room is sized proportional to its current activity. Quiet agents show small footprints. Active agents show larger surfaces with more live detail.

### 4.3 Above-the-fold priority surface

At the top of the home page, above the agent rooms, Maverick maintains a **priority surface** — 0 to 5 BroCards representing what currently needs Alex's eyes.

- **Stage 4 critical** — full-width card with red pulsing border, deadline timer, single action button. Example: "EMD due 2 PM CT — wire $5K to Memphis Title — SEND NOW"
- **Stage 3 priority** — card with orange indicator, action recommendation, reasoning visible
- **Standard BroCard** — neutral card with deal context, recommended action, reasoning, action buttons (Approve / Edit / Walk / Defer)

The priority surface is sorted by Maverick's confidence × urgency. When the surface is empty, Maverick's avatar shows resting posture and a status line like *"All clear. Nothing needs you right now."*

This is the most important UX surface on the entire dashboard. It directly implements Alex's vision:

> *"My clone that does all the sifting and puts the decision I need to make in front of my face with the reasons why or why not to."*

The priority surface IS that.

### 4.4 Beneath agent rooms — the pipeline visualization

Below the agent rooms (or as a dedicated page accessed from the home page), a **pipeline visualization** shows deals as cards moving through stages:

```
[Intake] → [Outreach] → [Response] → [Negotiating] → [Contract] → [Closed]
```

Deal cards visibly move between columns as state changes. When a deal advances, the card slides. When a deal dies, it falls into a "Dead" column with the reason visible. When a deal goes Stage 4, the card glows.

This is real-time. No refresh button. The dashboard is alive.

---

## 5. Severity tiers — what Alex sees, when

Maverick surfaces things at four tiers. Each tier has its own visual treatment:

### 5.1 Tier 0 — Routine handled silently

No visual interrupt. Activity is visible in the relevant agent's room (Sentinel ingesting, Crier dispatching) but no Maverick voice, no BroCard, no notification.

**Examples:** Routine PropStream intake. Standard cadence fires. Buyer warmup sequences. Cleanup of stale records. Background math runs on new leads.

**Why this tier exists:** Most operational activity should be invisible to Alex. The whole point of Maverick is that Alex doesn't have to think about it. Tier 0 is the default — *everything* is Tier 0 unless Maverick has confidence-gated reason to elevate.

### 5.2 Tier 1 — Standard BroCard

Appears in the priority surface (Section 4.3) as a neutral card with reasoning visible. Alex sees it when he opens the dashboard. No push, no popup, no out-of-band notification.

**Examples:** Reply to a buyer inquiry. Counter on a price negotiation. Approval for a new Scenario A intake batch. Routine deal decisions that need Alex's signature but aren't time-critical.

**Why this tier exists:** Most decisions Alex needs to make are in this tier — important but not urgent. The dashboard collects them; Alex acts when he has time.

### 5.3 Tier 2 — Stage 3 priority signal

Appears in the priority surface with orange visual indicator. Persistent dashboard indicator. Maverick's avatar shifts posture/orientation toward the relevant area. Page favicon may pulse if the tab is in background.

**Examples:** Quo deliverability issue affecting outbound. Deal going stale (12+ days no activity in Negotiating). A buyer match signal that's time-sensitive but not critical. RentCast quota approaching threshold.

**Why this tier exists:** Things Alex should see today but won't lose if he doesn't act in the next hour. Visual urgency without being alarmist.

### 5.4 Tier 3 — Stage 4 critical alert

**Modal popup** that blocks the dashboard interaction. Full-width with red pulsing border. Countdown timer if deadline-driven. Single primary action button + override option.

**Simultaneously: SMS push to Alex's personal phone** (separate from Quo number). Message format: *"MAVERICK ALERT: EMD due 23 Fields by 2 PM CT. Action required. Wire instructions in dashboard. Reply OK to acknowledge."*

**Examples:**
- EMD deadline within 4 hours, not yet wired
- Major opportunity matching Alex's archetype (e.g., absentee owner in target ZIP with dated-but-livable profile, 90+ DOM, just dropped price 20%)
- Critical bug or outage affecting outbound capability
- Deal-loss-imminent signal (seller indicates accepting competing offer)
- Compliance signal (assignment clause issue, NEVER-list violation about to fire)

**Throttle:** No more than 3 Tier 3 alerts per day. Deduplication by event type. If Maverick is uncertain whether to fire Tier 3, he doesn't — Tier 2 instead.

**Why this tier exists:** Alex has a wife, kids, and a day job at Whitetail Ridge. He cannot live in the dashboard. Tier 3 is the "you'll lose this if you don't act" layer that gets through anywhere he is.

---

## 6. Sub-agent visual presence

Each named agent is a visible working entity, not a code module. The goal is for Alex to *see his team working*, not to read about what the system did.

### 6.1 Per-agent visual treatment

Each agent has a consistent visual signature. The visual representation is up to design implementation, but should include:

- **Iconic representation** — a clear visual identity for each agent (could be a stylized character icon, a labeled status panel, or a workstation graphic)
- **Activity state indicator** — idle / working / blocked / alert
- **Output count + recent activity** — visible numbers and recent actions
- **Health pulse** — heartbeat or breathing indicator showing the agent is alive
- **Click affordance** — opens detailed agent page with full activity log

### 6.2 Agent activity log (the agent's detail page)

Clicking an agent opens that agent's detail page. The page shows:

- Full activity timeline for the past N hours (configurable)
- Decisions made with attribution (`@agent: crier`, `@agent: sentry`, etc.)
- Errors or blocks with reasoning
- Configuration current state
- Manual override controls if needed

The activity timeline is the visible audit log per agent. This is where Alex confirms his team is working correctly when he wants to inspect.

### 6.3 Agent-to-agent handoffs visible

When Sentinel passes a record to Appraiser, the record visibly moves from Sentinel's queue into Appraiser's queue. When Appraiser passes a math-checked record to Forge, the record moves again. The pipeline of work is visible as cards/items flowing between agents on the home page.

This is the "agents working together" visual that resonated with Alex from the TikTok dashboard. It's not just status — it's *motion between stations*.

---

## 7. The deal-detail workspace

When Alex drills into an individual deal, he lands on a single-deal workspace page. The 251 Cliffwood example Alex cited as "everything I need in one workspace" is the template.

### 7.1 What the deal page shows

For a single deal, in one workspace:

- **Property card** — photo, address, agent contact, current list price, days on market, archetype tag (e.g., "dated-livable absentee")
- **Math card** — Maverick's recommended offer, the 65%-rule reference price, current stored offer, buyer ARV/MAO estimate, comp pull summary
- **Conversation timeline** — every text, email, call, agent comment in chronological order, attributed to the right agent
- **Action surface** — BroCards specific to this deal (e.g., "Send follow-up at $61,750", "Walk the deal", "Defer 48h")
- **Status indicators** — gate state, depth tier, cadence stage, last outreach date, days since inbound, time-since-state-change
- **Maverick's commentary** — a small panel on this page showing Maverick's reasoning specific to this deal ("This deal has gone 14 days without contact — Crier is dark across the board, not deal-specific. Suggested action: verify Quo first, then soft-nudge the agent.")
- **Related-deal recall** — when Maverick remembers context across deals (same agent on a prior deal, same brokerage line, prior buyer interest), show that connection here as a "Related" panel

### 7.2 Deal pages inherit the Shepherd panel

Maverick's avatar persists in the same fixed position. The status line updates to be deal-relevant: *"You're working 23 Fields. I have one note."*

---

## 8. Out-of-band escalation — SMS to Alex's phone

The Stage 4 escalation channel uses Quo (or a separate dedicated number) to text Alex's personal phone when something critical happens.

### 8.1 Phone-side UX

SMS format from Maverick to Alex's personal phone:

```
MAVERICK ALERT (Stage 4)
EMD due 23 Fields Memphis by 2:00 PM CT today.
Wire instructions in dashboard.
Reply: OK to ack, DEFER to push to Tier 2.
```

Replies route back through Quo to Maverick's state layer. "OK" marks the alert acknowledged. "DEFER" downgrades it to Tier 2 (still visible in dashboard but no longer interrupting).

### 8.2 The big-opportunity escalation

Same mechanism for positive Stage 4 events:

```
MAVERICK ALERT (Stage 4 opportunity)
New ingest: 1847 Birch Ln Houston.
Absentee owner, 127 DOM, just dropped price 22%.
Matches your archetype. Crier hasn't fired yet — you call this one.
Reply: ACT to greenlight outreach, SKIP to defer, OPEN for full card.
```

The opportunity alerts are gated even harder than failure alerts. Maverick fires them only when archetype confidence is high AND timing matters.

### 8.3 Quo SMS infrastructure for Maverick alerts

This is a new build, not yet specced in the Continuity Layer Spec. Adding to the v1.2 backlog:

- A dedicated outbound channel (could be Quo inbox or a separate Twilio integration) for Maverick-to-Alex messages
- A throttle and dedup layer
- A reply-handler that updates state when Alex responds
- An Alert_Log table in Airtable for audit trail

Build effort: ~1-2 days. Probably ships after Maverick's MCP server (Day 3 of the locked 5-day build) so the alerts have somewhere to route from.

---

## 9. What's already built vs. what's missing

The Command Center dashboard already exists. Alex confirmed today: *"I do like what we have going here, especially the Bro Cards and I really like the 3rd image for 251 with basically everything I need to know about the property in this one workspace."*

So a real audit is needed before any new build. Inferring from the existing repo and Code's audits:

### 9.1 Likely already built

- **JarvisGreeting / MorningBriefing components** — exist, currently render text-based briefings (will need restyling to be more visual)
- **BroCards** — exist and work, used as decision cards
- **Pipeline board** — exists in some form
- **Deal-detail workspace** — exists, the 251 Cliffwood example proves it
- **Command Center route** — `app/page.tsx` is the home page

### 9.2 Likely missing or incomplete

- **Named-agent rooms on home page** — agents are currently code-module names in audit logs, not visible UI entities
- **Live activity indicators / motion** — current state is mostly static cards, not animated flow
- **Maverick's persistent Shepherd panel** — doesn't exist as a separate persistent component
- **Severity tier visual treatment** — needs design pass to distinguish Tier 0/1/2/3 visually
- **Out-of-band SMS escalation** — not built
- **Inter-agent handoff visualization** — not built
- **Maverick-the-Shepherd avatar** — not built

### 9.3 Required: audit pass before build

Before any new build against this spec, Code must produce an inventory of the current dashboard at component level — what exists, what state, what's working, what's stubbed. Then this spec gets amended with a build sequence that respects what's already there.

**Action item for Code (post-Maverick Days 3-5):** produce `AKB_Dashboard_Current_State_v2.md` with component-level inventory mapped against this Daily UX Spec. The v2 designation indicates this audit happens *with the Daily UX Spec as the target architecture*, not generic.

---

## 10. Build sequencing within the Maverick 5-day plan

The Continuity Layer Spec's 5-day build (Days 1-5) ships the Maverick backend — aggregator, MCP server, write-back, hardening. The dashboard wiring to that backend happens after Gate 5.

### 10.1 Days 1-5 (Continuity Layer) — backend only

No dashboard work. Days 1-5 ship Maverick's intelligence. The dashboard continues to read from Airtable directly until the backend is proven.

### 10.2 Days 6-7 (buffer)

The Continuity Layer Spec reserves these for spec drift + renaming. Add to this buffer:

- Dashboard audit pass — `AKB_Dashboard_Current_State_v2.md`
- Gap analysis vs. this Daily UX Spec
- Sequencing recommendation for dashboard rework

### 10.3 Days 8+ (Dashboard rework — new build phase)

After Maverick exists and the audit completes, dashboard rework begins. Sub-sequence to be specced in a future amendment, but rough order:

1. **Shepherd panel** — Maverick's persistent presence is the foundational UX element
2. **Priority surface BroCards wired to Maverick** — the most leveraged change
3. **Named-agent rooms** — one agent at a time, starting with the most active (Crier likely first)
4. **Severity tier visual treatment** — design pass on Tier 0/1/2/3
5. **Live motion / animation** — converting static cards to flowing pipeline
6. **Out-of-band SMS escalation** — Stage 4 channel
7. **Deal-detail page enhancements** — Maverick's commentary panel, related-deal recall

This list is illustrative, not prescriptive. The Code audit (Day 6-7) will produce the actual sequence.

---

## 11. The closing principle

Alex's brain renders systems by walking through them. The Command Center must be a place he walks through. Every surface must show, not tell. Every agent must be visible. Every decision must arrive with reasoning attached.

Maverick lives inside the dashboard as a German Shepherd watching the perimeter, surfacing what matters, handling what doesn't, and pushing Alex toward the action that protects his family.

**The dashboard is not a tool Alex uses. It's the place where Alex's team works.**

Build it that way.

---

*Spec v1.0 — May 15, 2026. Living Artifact. The visual surface will refine as Alex lives with the system and surfaces what works vs. what doesn't. The next version of this document is written by a Claude session reading user-behavior data, not by a Claude session imagining a dashboard from a spec.*
