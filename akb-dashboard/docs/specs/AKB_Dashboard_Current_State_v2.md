# AKB Dashboard — Current State v2

**Document version:** v2.0
**Authored:** May 16, 2026 (Code, Days 6-7 audit)
**Status:** Component-level inventory of `akb-dashboard/` rendered against `Maverick_Daily_UX_Spec_v1.md` as the target architecture.
**Companion specs:** `AKB_MASTER_CHECKLIST.md`, `AKB_System_Inventory_v1.md`, `Maverick_Daily_UX_Spec_v1.md`, `Maverick_Character_Spec_v1.md`
**Supersedes:** any prior `AKB_Dashboard_Current_State` (v1 not in repo)

---

## Why this document exists

Daily UX Spec §9.3 ("Required: audit pass before build") explicitly mandates this audit before Phase 9 dashboard rework begins. Daily UX Spec §9 enumerates what's *likely* built vs *likely* missing based on conversations; this doc replaces that inference with repo-grounded findings.

The Daily UX Spec is the target architecture. This doc inventories what exists today, what gaps remain, and where the existing implementation already covers spec intent (vs needing new builds).

---

## 1. Top-level structure

### 1.1 Pages (`app/`)

Six routes; total 1,800 LOC.

| Route | File | LOC | Purpose | Spec alignment |
|---|---|---|---|---|
| `/` (ACT NOW) | `app/page.tsx` | 83 | Command Center home | Maps to Daily UX Spec §4 (home page) — but as orchestrator only; does not yet contain agent rooms |
| `/pipeline` | `app/pipeline/page.tsx` | 474 | Pipeline board / deal list | Maps to Daily UX Spec §4.4 pipeline visualization |
| `/pipeline/[id]` | `app/pipeline/[id]/page.tsx` | 414 | Single-deal workspace | Maps to Daily UX Spec §7 deal-detail workspace |
| `/deals` | `app/deals/page.tsx` | 152 | Deals listing | Tactical — not in Daily UX Spec; predates roster vocabulary |
| `/buyers` | `app/buyers/page.tsx` | 94 | Buyers table | Maps to Daily UX Spec §4.2 Scout room (partial) |
| `/buyer-intake` | `app/buyer-intake/page.tsx` | 186 | Buyer intake form | Functional, no UX spec equivalent |
| `/queue` | `app/queue/page.tsx` | 203 | Action queue | Maps to Daily UX Spec §4.3 priority surface (partial) |
| `/system` | `app/system/page.tsx` | 154 | Tasks/system status | Tactical |

**Navigation tabs (`components/Navigation.tsx`):** ACT NOW, PIPELINE, DEALS, BUYERS, QUEUE, SYSTEM. Six tabs total. Daily UX Spec §3.1 + §4 imply a different mental model: the home page IS the factory floor with all agent rooms visible, and dashboard surfaces are agent-anchored rather than entity-anchored. Current tab structure is entity-anchored (Pipeline, Deals, Buyers, Queue) rather than agent-anchored (Sentinel, Crier, etc.).

**Implication:** Phase 9 rework probably keeps these entity tabs as views but adds an agent-room layer to ACT NOW (the home page) per Daily UX Spec §4.2.

### 1.2 Components (`components/`)

25 components, 4,361 total LOC. Largest 6:

1. `cards/ResponseCard.tsx` — 390 LOC (BroCard variant)
2. `JarvisGreeting.tsx` — 360 LOC (legacy naming, see §3 below)
3. `TwoTrackPricing.tsx` — 351 LOC (Phase 4E partial)
4. `PipelineBoard.tsx` — 258 LOC
5. `MorningBriefing.tsx` — 253 LOC
6. `JarvisFeed.tsx` — 230 LOC (legacy naming)

---

## 2. Mapping current components to Daily UX Spec sections

### §3.1 Shepherd panel (persistent Maverick presence)

| Spec requirement | Current state |
|---|---|
| Avatar (German Shepherd, alert posture) on every page | **NOT BUILT** — zero `shepherd`/`german.shepherd` matches in components |
| One-sentence status line in Maverick's voice | **NOT BUILT** as persistent — `JarvisGreeting` (360 LOC) renders a greeting block on home page only |
| Click-avatar opens chat-to-Maverick surface | **PARTIALLY** — `JarvisChat.tsx` (166 LOC) exists as a chat surface, not yet wired to MCP load_state |
| Fixed position, persists across navigation | **NOT BUILT** — components mount per-page |

**Gap:** Foundational UX element. Checklist 9.1 + 9.9. Likely the single highest-leverage build in Phase 9.

**Suggested path:** New `components/ShepherdPanel.tsx` rendered in `app/layout.tsx` so it persists across all pages. Wires to `mcp__Maverick__maverick_load_state` for status line. Reuses `JarvisChat.tsx` as the chat surface (renamed to `MaverickChat.tsx` per 9.11).

### §3.2 Directional indicators

| Spec requirement | Current state |
|---|---|
| Maverick avatar tilts toward areas needing attention on other pages | **NOT BUILT** |

**Gap:** Built after §3.1 ships. Soft directional cue in the Shepherd panel.

### §4.1 Factory-floor layout (named-agent rooms on home page)

| Spec requirement | Current state |
|---|---|
| Home page divided into named-agent rooms | **NOT BUILT** — current home (`app/page.tsx`) is 83 LOC, renders `MorningBriefing + PipelineBoard + OutreachPanel + JarvisFeed + JarvisChat + JarvisGreeting + ActionQueue` as a stack |
| Per-agent live activity indicator | **NOT BUILT** |
| Per-agent recent output (last 3-5 actions) | **PARTIALLY** — `JarvisFeed.tsx` shows recent Maverick proposals across the system but not split by agent |
| Per-agent health indicator | **PARTIALLY** — `BriefingStrip.tsx` (128 LOC) likely renders source health (Maverick's source_health field) |
| Drill-down to per-agent detail page | **NOT BUILT** |

**Gap:** The factory-floor layout is the biggest UI shift required by Daily UX Spec. Current home page is more "list of widgets" than "place with rooms."

### §4.2 Per-agent rooms (the 10 named agents)

Inventoried in `AKB_System_Inventory_v1.md` §1. Summary for dashboard purposes:

| Agent | Backend status | UI presence today |
|---|---|---|
| Maverick | WORKING | None — Shepherd panel not built |
| Sentinel | PARTIALLY BUILT (unnamed in code) | None |
| Crier | PARTIALLY BUILT (unnamed) | `OutreachPanel.tsx` (165 LOC) is closest — shows outreach activity but doesn't credit Crier |
| Sentry | BUILT (unnamed) | Implicit in pipeline gate states but no Sentry-branded surface |
| Forge | PARTIALLY BUILT | Buyer warmup drafts visible in `BuyerOutreachQueue.tsx`; not credited to Forge |
| Scribe | NOT BUILT | None |
| Scout | PARTIALLY BUILT | `BuyerOutreachQueue.tsx` + `/buyers` page closest |
| Pulse | MOSTLY VISION | None |
| Appraiser | BUILT (unnamed) | `TwoTrackPricing.tsx` (351 LOC) renders Phase 4 output — not credited to Appraiser |
| Ledger | NOT BUILT | None |

### §4.3 Above-the-fold priority surface

| Spec requirement | Current state |
|---|---|
| 0-5 BroCards representing what needs Alex's eyes | **PARTIALLY BUILT** — `ActionQueue.tsx` (104 LOC) renders an action queue; `JarvisFeed.tsx` renders proposal feed. Neither is wired to Maverick aggregator's priority output |
| Stage 4 / Stage 3 / standard tier visual differentiation | **NOT BUILT** — current BroCards (`cards/DDCard`, `DealCard`, `ResponseCard`, `StaleCard`, `HoldButton`) use status-based styling, not Maverick severity tiers |
| Confidence × urgency sort | **NOT BUILT** — current sorts are by recordId / date |
| "All clear" state when nothing needs Alex | **PARTIALLY** — `JarvisGreeting.tsx` renders a greeting that varies but doesn't track empty-priority-surface |

**Gap:** Daily UX Spec calls this *"the most important UX surface on the entire dashboard."* Currently the action queue is the closest analog but doesn't pull from `maverick_load_state`. Wiring this is Checklist 9.2, likely the second-highest leverage Phase 9 item after 9.1.

### §4.4 Pipeline visualization

| Spec requirement | Current state |
|---|---|
| Deals as cards moving through stage columns | **BUILT** — `PipelineBoard.tsx` (258 LOC) renders a stage-column pipeline |
| Real-time, no refresh button | **PARTIAL** — `app/page.tsx` has a manual refresh button + refreshKey state; pipeline updates on refresh, not push |
| Deal-card slide animation on state change | **NOT BUILT** — current cards re-render statically |
| Dead-column with reason visible | **PARTIAL** — bulk-dead annotation exists in data layer; dashboard treatment uncertain |
| Stage 4 glow on critical cards | **NOT BUILT** |

**Gap:** Structure exists but animation + severity treatment missing. Checklist 9.6.

### §5 Severity tiers (Tier 0/1/2/3)

| Spec requirement | Current state |
|---|---|
| Tier 0 — routine handled silently | Likely YES (no current UI mechanism that interrupts for routine activity) |
| Tier 1 — standard BroCard in priority surface | PARTIAL (BroCards exist; tier system doesn't) |
| Tier 2 — Stage 3 priority signal w/ orange indicator, posture shift | **NOT BUILT** |
| Tier 3 — Stage 4 modal popup + SMS push | **NOT BUILT** |

**Gap:** No severity-tier system in dashboard today. Phase 9.5 design pass required.

### §6 Sub-agent visual presence

| Spec requirement | Current state |
|---|---|
| Per-agent visual signature (icon, state, count, health pulse) | **NOT BUILT** |
| Per-agent detail page | **NOT BUILT** |
| Agent-to-agent handoff visualization | **NOT BUILT** |

**Gap:** Entire concept depends on Phase 9.3 (named-agent vocabulary in code) and Phase 9.4 (agent rooms).

### §7 Deal-detail workspace

| Spec requirement | Current state |
|---|---|
| Property card | **BUILT** — `app/pipeline/[id]/page.tsx` (414 LOC) + `PropertyDetailsPanel.tsx` (115 LOC) |
| Math card (MAO, ARV, rehab, comp pull) | **BUILT** — `TwoTrackPricing.tsx` (351 LOC) renders dual-track |
| Conversation timeline | **BUILT** — `ConversationThread.tsx` (66 LOC) + `timeline-merge.ts` lib |
| Action surface (BroCards specific to this deal) | **BUILT** — `cards/DDCard`, `DealCard`, `ResponseCard`, `StaleCard`, `HoldButton` |
| Status indicators (gate, depth, cadence, dates) | **BUILT** — distributed across the page components |
| Maverick commentary panel | **NOT BUILT** — no per-deal Maverick reasoning surface yet |
| Related-deal recall | **NOT BUILT** — `maverick_recall` MCP tool exists; UI wiring does not |

**Gap:** Deal-detail page is the most-built surface in the dashboard — Alex's "251 Cliffwood gold standard" comment confirms. Missing pieces are the Maverick-specific layers (commentary + recall). Phase 9.8.

### §8 Out-of-band SMS escalation

| Spec requirement | Current state |
|---|---|
| Stage 4 → SMS push to Alex's personal phone | **NOT BUILT** |
| Reply handler for OK/DEFER/ACT/SKIP/OPEN | **NOT BUILT** |
| Alert_Log table | **NOT EXISTING** |
| Throttle (≤3 Stage 4 per day, dedup by event type) | **NOT BUILT** |

**Gap:** Entire subsystem unbuilt. Daily UX Spec §10.3 sequencing puts this at step 6. Estimated 1-2 days new build. Checklist 9.7 + 12.3.

---

## 3. Legacy "Jarvis" naming pass

Pre-Maverick naming persists in the codebase. Per Code Briefing §9: "Jarvis is the old name being replaced." Inventory:

### Components

| File | LOC | Replaced by (per Daily UX Spec) |
|---|---|---|
| `components/JarvisGreeting.tsx` | 360 | Folds into Shepherd panel (§3.1) — likely retire |
| `components/JarvisFeed.tsx` | 230 | Becomes priority surface (§4.3) feed — rename to `PrioritySurface.tsx` |
| `components/JarvisChat.tsx` | 166 | Becomes Shepherd panel chat surface — rename to `MaverickChat.tsx` |

### API routes

| File | Purpose | Replaced by |
|---|---|---|
| `app/api/jarvis-audit/route.ts` | Audit log read | Maverick's audit_summary field via load_state |
| `app/api/jarvis-brief/route.ts` | Morning brief data | Maverick `/api/maverick/load-state` (already wired) |
| `app/api/jarvis-chat/route.ts` | Chat backend | Maverick MCP — but UI chat may stay |
| `app/api/jarvis-send/route.ts` | Send-action endpoint | Likely retire or rename to maverick-action |

**Approach:** Rename + backwards-compatible re-exports during Phase 9.11 to avoid breaking imports during the dashboard rework. Pre-Phase-9 cleanup not required since current functionality works.

---

## 4. What's surprisingly already built

Crediting the existing dashboard so Phase 9 rework doesn't accidentally rebuild things that work:

1. **BroCard system is mature** — five card types in `components/cards/` totaling 816 LOC. Reusable for Daily UX Spec priority surface.
2. **Deal-detail workspace is the closest-to-spec page** — 414 LOC, all major spec sections covered except Maverick commentary + related-deal recall.
3. **Pipeline visualization exists** — `PipelineBoard.tsx` 258 LOC provides the stage-column structure. Animation + severity treatment is the gap, not the foundation.
4. **Action queue concept exists** — `ActionQueue.tsx` + `JarvisFeed.tsx` together implement a proposal-and-action surface. Needs rewiring to Maverick, not rewriting.
5. **Property details panel is solid** — `PropertyDetailsPanel.tsx` 115 LOC, reusable in deal-detail Maverick commentary.
6. **Conversation thread + timeline merge** — already handles cross-channel (SMS + email) merging in `timeline-merge.ts`.

**Implication:** Phase 9 is rewiring + design pass + Shepherd panel build, not greenfield. The dashboard skeleton is intact.

---

## 5. Top architectural gaps (ordered by leverage)

### 5.1 Shepherd panel doesn't exist (Phase 9.1)
Daily UX Spec's foundational UX element. Currently Maverick has no persistent visual presence. Every other Phase 9 item builds on this.

### 5.2 Priority surface isn't wired to Maverick (Phase 9.2)
ActionQueue + JarvisFeed exist but don't pull from `maverick_load_state`. Wiring this surfaces Maverick's prioritization in the dashboard immediately.

### 5.3 No named-agent attribution in code (Phase 9.3)
Sentry, Appraiser, Sentinel, Crier, etc. exist functionally but emit operational audit tags (`phase4c`, `d3-cadence`) not roster names. Blocks agent-room rendering. Estimated 1-day rename pass.

### 5.4 No severity tier system in UI (Phase 9.5)
Tier 0/1/2/3 differentiation absent. BroCards style by status, not by Maverick's prioritization. Required for Tier 3 critical alerts to feel different from Tier 1.

### 5.5 No out-of-band escalation channel (Phase 9.7 + 12.3)
Stage 4 alerts have nowhere to push. Requires separate phone number provisioning + reply-handler endpoint + Alert_Log table.

### 5.6 No live motion (Phase 9.6)
Cards re-render but don't animate. Required for "agents working" visual that resonated with Alex from the TikTok dashboard.

### 5.7 No Maverick commentary on deal-detail (Phase 9.8a)
Deal-detail page is otherwise spec-complete but lacks the "Maverick's reasoning on this deal" panel.

### 5.8 No related-deal recall on deal-detail (Phase 9.8b)
`maverick_recall` MCP tool exists; UI hook into deal-detail page doesn't.

### 5.9 Pipeline rework: dead-column treatment + Stage 4 glow (Phase 9.6 sub-items)
Pipeline shows stages but doesn't visualize dead/critical states.

### 5.10 German Shepherd avatar (Phase 9.9)
Cosmetic but identity-anchoring. Lower priority than functional items.

---

## 6. Build sequence recommendation

Aligned with Daily UX Spec §10.3 but refined based on this audit's evidence:

| Order | Phase | Item | Effort estimate | Why this order |
|---|---|---|---|---|
| 1 | 11.4 | Wire `Stored_Offer_Price` to pricing-agent + H2 path | ~30 LOC | Unblocks deal-flow visibility before any UI work |
| 2 | 12.1 + 12.2 | Provision `VERCEL_API_TOKEN` + `GITHUB_PAT` | No code | Immediate briefing improvement |
| 3 | 12.6 | Airtable concurrent-source contention mitigation | Small refactor | Relieves Gate 5 P95 overshoot |
| 4 | 11.1 | Quo quiet-vs-down false-negative fix | ~20 LOC | Maverick lies about Crier health today |
| 5 | 9.3 | Named-agent vocabulary in code attribution | 1 day | Foundation for 9.4 and Phase 13 |
| 6 | 9.11 | Jarvis→Maverick component rename | 1 day, parallel with 9.3 | Coherence cleanup |
| 7 | 9.1 | Shepherd panel in `app/layout.tsx` | 2-3 days | Daily UX Spec's foundational element |
| 8 | 9.2 | Priority surface wired to Maverick `load_state` | 2-3 days | Highest user-visible leverage |
| 9 | 9.4 (Crier first) | First named-agent room | 2 days | Most-stable backend, lowest-risk first agent to render |
| 10 | 9.5 | Severity tier visual treatment | 2 days, design-heavy | Required for Tier 3 to feel different |
| 11 | 9.8 | Deal-detail Maverick commentary + related-deal recall | 3 days | Uses existing `maverick_recall` tool |
| 12 | 9.7 + 12.3 | Out-of-band SMS escalation | 1-2 days | Stage 4 channel |
| 13 | 9.4 (remaining agents) | Remaining 5-6 agent rooms | 1 day each | Iterate as backend matures |
| 14 | 9.6 | Live motion / animation | 3 days, design-heavy | Polish; ships after rooms work |
| 15 | 9.9 | German Shepherd avatar | 1 day, design-heavy | Cosmetic-but-identity; ships when ready |
| 16 | 9.10 | Auto-allow `maverick_load_state` permission | <1 day | Friction reduction post-trust |

**Total estimate:** 24-32 days of focused build for Phase 9. With prerequisites (items 1-4) at ~1 day each, the dashboard rework is approximately a 5-week sprint at full focus.

This is bigger than Maverick's Days 1-5 backend build. Plan accordingly.

---

## 7. Risks + dependencies

### Phase 9.3 must precede 9.4
Rendering "agent rooms" requires the audit log to credit work to roster names. Skipping 9.3 and going straight to 9.4 means rooms have to grep audit events for functional tags (`phase4c` → Appraiser) which is brittle and breaks when new code emits new tags.

### Phase 12.6 may be deeper than expected
The 3-Airtable-concurrent-timeout pattern from Day 1 is reproducing under live load. Two options: (a) serialize Airtable calls within aggregator (loses parallelism gains but eliminates contention), (b) raise per-source budgets further. Day 1's bumps (listings 8→15s, spine + queue 4→8s) helped but didn't fully fix. May need a third intervention.

### Phase 9.7 (Stage 4 SMS) depends on a separate Quo number or Twilio
Alex's personal phone needs to receive without colliding with Quo's deliverability metrics. Separate channel required. Not a code-only fix.

### DocuSign MCP integration creates new gate dependencies
Now that DocuSign tools are live (per system reminder this session), the 18 pre-contract checks in `lib/orchestrator/pre-contract-checks.ts` waiting on `blocked_on: docusign_mcp_wire_in` can be implemented. This is Scribe's groundwork (Checklist 5.4).

---

## 8. Recommendations summary

1. **Don't rebuild what works.** BroCard family, pipeline board, deal-detail workspace, conversation thread, property details panel — all keep + rewire, not replace.
2. **Land prerequisites first.** Items 1-4 in §6 above are <1 week of total effort but unblock UI work significantly.
3. **Phase 9.3 (named-agent vocabulary) is the unlock.** Without it, agent rooms can't render coherently. With it, every subsequent UI build inherits the vocabulary cleanly.
4. **Shepherd panel is the foundational UX shift.** Daily UX Spec §3.1's "persistent Maverick on every page" reframes the whole dashboard. Build first.
5. **The dashboard rework is bigger than the Maverick backend build.** ~5 weeks of focused work vs Days 1-5 for backend. Plan capacity.

---

*Dashboard Current State v2.0 — May 16, 2026. Living Artifact. v3 written when Phase 9 ships substantial dashboard rework; re-anchor against then-current Daily UX Spec version.*