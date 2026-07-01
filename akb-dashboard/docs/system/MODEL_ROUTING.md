# Model routing — the right model for each agent/task

> Operator decision (2026-07-01): match model capability to task difficulty so cost
> stays in order and no agent is either too powerful+slow or too weak+ineffective.
> **Maverick is ALWAYS the flagship — never downgraded.** This is a design/doctrine
> artifact for the fully-built system (dashboard ops); the wiring lever is a central
> model registry, so it's a config change, not a rebuild.

## The biggest lever isn't the model — it's keeping the spine in CODE

Most of this pipeline is **deterministic** and runs at ~zero token cost because it's pure
code, not a model call: the pricing math (`per-market-pricer`, `opener-pricing`), every
gate (`isPriceableMarket`, `shouldAutoPromote`, the send guards), the opener composer
(`buildH2Message`), rounding/floor/cap, and self-echo/dedup regex. **Deterministic-first
is the #1 cost control** — model tiering only governs the genuinely *generative /
judgment* legs (understanding a reply, drafting a negotiation, reading rehab photos,
synthesizing the brief). Keep pushing rule-based work into code before reaching for a model.

## Tiers (model IDs as of 2026-07 — confirm pricing on Anthropic's current page)

| Tier | Model ID | Use for |
|---|---|---|
| **Flagship** | `claude-opus-4-8` | Judgment, doctrine, money-gating, orchestration. Accuracy over cost. |
| **Workhorse** | `claude-sonnet-5` | High-volume, bounded generation with strong follow-through. Faster + cheaper. |
| **Utility** | `claude-haiku-4-5-20251001` | Simple classification, extraction, routing, field ops. Cheapest + fastest. |
| **No model** | — (pure code) | Anything rule-based: pricing, gates, composer, rounding, dedup. |

## Agent → tier (proposed map — refine as each agent's duties firm up)

| Agent | Primary job | Model | Why |
|---|---|---|---|
| **Maverick** | Owner's rep, orchestration, morning brief, cross-agent synthesis, continuity | **Opus 4.8** (max effort) | The brain. Operator mandate: **always the best**, never downgraded. |
| **Sentry** | Pre-outreach / pre-send / pre-negotiation gates, math gating | **Opus 4.8** | Money-gating decisions that reach the manual-oversight gate — accuracy > cost. |
| **Appraiser** | ARV-trust adjudication + hard rehab calls | **Opus 4.8** | Feeds the money math; edge-case judgment must be right. |
| **Appraiser** | Routine rehab-vision photo reads | **Sonnet 5** | High-volume, bounded vision. |
| **Crier** | Reply understanding, negotiation/follow-up drafting | **Sonnet 5** | High-volume, needs follow-through. (The first-touch composer is pure code.) |
| **Scout** | Crawl / intake / enrichment | **Sonnet 5** | High-volume, bounded. |
| **Forge** | Contract / template generation | **Sonnet 5** | Structured generation with follow-through. |
| **Scribe** | Dossier / doc synthesis | **Sonnet 5** | Bounded synthesis. |
| **Sentinel** | Watchdog / anomaly monitoring | **Haiku 4.5** → Sonnet 5 on a real anomaly | Cheap steady-state; escalate the leg only when something's off. |
| **Pulse** | Health / status scans | **Haiku 4.5** | Classification. |
| **Ledger** | Bookkeeping / Airtable field ops | **Haiku 4.5** | Simple ops. |

## Mechanism — how it's actually wired

- **One registry, not scattered IDs.** Each agent's model + effort lives in a central
  registry (`lib/maverick/voice-registry.ts` today). Set the tier there per agent; never
  hard-code a model ID in a route. (This is also why the retired-model outage was a
  one-line fix — one registry to repoint.)
- **Effort dial within a tier.** Anthropic exposes adjustable effort; use it to tune
  cost/perf without changing tiers (e.g., Sonnet-low for a trivial draft, Sonnet-high for
  a tricky negotiation).
- **Escalate the leg, not the agent.** When a normally-routine task turns hard (a routine
  reply becomes a real negotiation), route *that call* to Opus explicitly rather than
  upgrading the whole agent.

## Rules that don't bend

1. **Maverick and the money-gates (Sentry, pricing adjudication) never downgrade.**
2. **Tier by difficulty, not importance** — a simple task for an important agent still
   uses a cheap model.
3. **Deterministic-first** — if a rule can express it, it's code, not a model call.
4. **Confirm current pricing/benchmarks** on Anthropic's page before budgeting; the tier
   *ordering* (Opus > Sonnet > Haiku on capability, inverse on cost) is the durable part.
