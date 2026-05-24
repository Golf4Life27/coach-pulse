# Maverick — model tier registry spec proposal

Draft amendment for v1.2 of `Inevitable_Continuity_Layer_Spec_v1.1.md`. Adds a model tier registry abstraction so future Anthropic model releases land cleanly without code-spread hunt-and-replace.

**Status:** Proposed, not committed work. Locks when Alex marks "Accepted." Ships in the same v1.2 spec update as the OAuth amendment (§6.5 + §6.6).

**Trigger:** The hardcoded `claude-sonnet-4-6` in `lib/maverick/synthesize.ts` is technical debt that compounds with every future LLM call across Pulse, named-agent reasoning, BroCard generation, etc. Surfaced 5/15 while OAuth context was hot and other infrastructure-shaping decisions were on the table.

**Build deferral:** Spec-only this turn. Implementation folds into the natural Day 8+ refactor moment when `synthesize.ts` gets touched for Character Spec prompt anchoring. Not a separate build task.

---

## 1. Three tiers

```typescript
// lib/maverick/model-registry.ts (proposed)

export const TIER_REQUIREMENTS = {
  premium_frontier: {
    description:
      "Strategic reasoning, multi-source synthesis, BroCard generation, " +
      "priority surfacing. Maverick himself speaks from here.",
    minimum_capability: "Opus-class flagship reasoning",
    canonical_callers: [
      "maverick_synthesize",      // Owner's Rep voice synthesis (today: synthesize.ts)
      "pulse_introspection",      // Step 5 scheduled-introspection routines
      "brocard_reasoning",        // Daily UX spec — BroCard composition
    ],
  },
  premium: {
    description:
      "Domain analysis, complex math, contract parsing, document assembly.",
    minimum_capability: "Sonnet-class reasoning",
    canonical_callers: [
      "appraiser_arv_analysis",   // Comp-based ARV + repair-bid analysis
      "scribe_contract_parse",    // Contract → structured Spine field extraction
      "scout_buyer_matching",     // Buyer-to-listing match reasoning
      "ledger_economic_analysis", // Burn rate, lifetime-value, deal-economics math
    ],
  },
  cheap: {
    description:
      "Pattern matching, classification, templated text drafting.",
    minimum_capability: "Haiku-class fast inference",
    canonical_callers: [
      "sentinel_intake_classify", // New-lead intake classification (hot/cold/dead)
      "forge_template_draft",     // Outbound message-template drafting
      "sentry_text_validation",   // Outbound text safety + 10DLC compliance check
    ],
  },
} as const;

export const TIER_CURRENT_MODEL = {
  premium_frontier: "claude-opus-4-7",
  premium: "claude-sonnet-4-6",
  cheap: "claude-haiku-4-5-20251001",
} as const;

export const MODEL_REGISTRY_LAST_REVIEWED = "2026-05-15";

export type Tier = keyof typeof TIER_CURRENT_MODEL;

/**
 * Single source of truth for model selection. Every Claude API call
 * site references this — never hardcode a model string outside
 * model-registry.ts.
 */
export function selectModel(tier: Tier): string {
  return TIER_CURRENT_MODEL[tier];
}
```

Every LLM call site in the codebase imports `selectModel` and references a tier name. `claude-*` model strings appear in exactly one file: `model-registry.ts`. Period.

---

## 2. Standing premium-frontier policy

> *"Maverick (the orchestrator role) ALWAYS occupies `premium_frontier`. When Anthropic releases a new flagship Opus-class model, update `TIER_CURRENT_MODEL.premium_frontier` to that model. Do not gate this on cost analysis — premium tier is mandatory for the strategic intelligence layer. Synthesis, Pulse, and BroCard-reasoning callers inherit this from Maverick."*

This is non-negotiable spec. The strategic-intelligence layer is the single load-bearing surface for Maverick's quality — the briefing every session opens with, the introspection that proposes principle amendments, the prioritization that shapes Alex's day. Downgrading any of those to save tokens is the kind of "smart" cost optimization that compounds into Maverick-feels-dumb over weeks. Once Maverick feels dumb, the trust contract that makes Maverick load-bearing breaks. Not worth.

---

## 3. Re-evaluation protocol — every new model release

When Anthropic ships a new model in any tier, three questions get asked. Answers documented in the commit message that updates `TIER_CURRENT_MODEL` + `MODEL_REGISTRY_LAST_REVIEWED` bumps to the review date.

**Q1 — Direct replacement?** Does the new model belong in an existing tier as a replacement occupant?
- Example: Opus 5.0 ships → `premium_frontier` updates from `claude-opus-4-7` → `claude-opus-5-0`. No tier definition change.

**Q2 — Tier shift on existing callers?** Does any current caller now belong in a DIFFERENT tier given the new capability landscape?
- Example: Haiku 6 ships and benchmarks match today's Sonnet 4.6. Appraiser may downgrade from `premium` to `cheap` without quality loss — cost savings, no quality regression. Sentinel-intake-classify may UPGRADE from `cheap` to `premium` if classification accuracy at the dollar level matters more than the API cost differential.
- This question forces a per-caller audit, not just a registry swap.

**Q3 — Tier definition revision?** Should the tier definitions themselves be revised — new tier added, tier collapsed, requirements rewritten?
- Example: Anthropic ships a model with native multi-step tool-use orchestration → consider adding `agent_orchestration` tier above `premium_frontier`. Or: Haiku 7 capabilities subsume Sonnet 4.6 → collapse `cheap` + `premium` into a single tier.

**Process discipline:** No silent updates. Every `TIER_CURRENT_MODEL` change is its own commit, with the three questions answered in the commit body. `MODEL_REGISTRY_LAST_REVIEWED` is the audit footprint — anyone reading the file knows when it was last touched and can correlate with Anthropic's release calendar.

---

## 4. Phase 2 evolution — Pulse-driven registry monitoring

Post-Pulse-shipped (Spec v1.1 §5 Step 5), post-deal-#1, when the introspection layer is real:

Pulse routine on a daily schedule (Hobby plan cap) queries Anthropic's models endpoint, diffs against `TIER_CURRENT_MODEL`. When a new model appears in a tier-relevant category, Pulse generates a BroCard proposing tier update:

> *"New model `claude-opus-5-0` shipped 5/30. Currently in `premium_frontier`: `claude-opus-4-7`. Proposed: bump to `claude-opus-5-0`. Capability notes from Anthropic release: [...]. Test plan: re-run cold-path synthesis benchmark, compare quality on 10 known-good briefings."*

Approval surfaces via the standard BroCard accept/reject flow. **Never auto-update without approval.** The strategic-intelligence layer is too load-bearing for silent model swaps — Alex has to see the diff and approve.

Governing framework: Capability Absorption Pattern (Maverick_Capability_Absorption_Reference_v1, deferred to Days 6-7 reading). SURFACE → EVALUATE → INTEGRATE → DEPLOY → REFINE applied to model registry. Pulse handles SURFACE. The three-question protocol is EVALUATE. The commit is INTEGRATE. The post-deploy benchmark is REFINE.

---

## 5. Implementation timing + plumbing

**Not a separate build day.** The registry refactor folds into the natural moment `synthesize.ts` gets touched for Character Spec prompt anchoring (Day 8+ per the locked sequencing).

Refactor scope at that moment:
1. Create `lib/maverick/model-registry.ts` per §1.
2. Replace `const MODEL = "claude-sonnet-4-6"` in `synthesize.ts` line 29 with `const MODEL = selectModel("maverick_synthesize" === "maverick_synthesize" ? "premium_frontier" : ...)` — or more cleanly, `const MODEL = selectModel("premium_frontier")` with a comment naming the caller per the registry's `canonical_callers` list.
3. Update `synthesize.ts` timeout budget per §6 below (premium_frontier likely needs more headroom than premium).
4. Grep for any other `claude-` model-string literals across the codebase; replace each via `selectModel(<tier>)`.
5. Unit test: `selectModel("premium_frontier")` returns the registry's current value; type-check enforces tier names.

Today's codebase only has the one call site (`synthesize.ts`). Other tier callers in §1's `canonical_callers` lists are aspirational — they ship as named-agent code lands in later weeks. Each new agent imports `selectModel` from day one; no migration debt accumulates.

---

## 6. Performance + cost implication of the standing policy

**Honest disclosure:** Applying the standing premium-frontier policy moves the synthesizer from Sonnet 4.6 → Opus 4.7. Real consequences:

- **Latency:** Opus 4.7 synthesis on the current ~10K-token cold-cache payload likely lands 25-35s vs Sonnet's 16-20s. This blows through the 20s synthesis budget set in Day 2.
- **Cost per call:** Opus is ~5x Sonnet's per-token cost. Briefing synthesis runs once per session-open + once per 90s cache-refresh. Modest absolute volume; meaningful proportional jump in API spend.

Three mitigations land alongside the Day 8+ refactor moment:

1. **Bump synthesis budget to 30s** in `synthesize.ts` + correspondingly bump `maxDuration` ceiling in `/api/maverick/load-state/route.ts` to 60s (already at 60s ceiling on Hobby plan, no room above). P95 target in Spec v1.1 §8 revises to ≤45s for cold-path with note that warm-cache returns stay <1s.
2. **Trim `active_deals` payload to top 15** before passing to the synthesizer per v1.2 backlog item #3. Already specced. Reduces cold-path payload by ~60% → recovers most of the latency penalty.
3. **Aggressive prompt caching** — system prompt (Owner's Rep voice + roster + principles) is already marked `cache_control: ephemeral`. Verify cache hit rate during Day 8+ benchmark; if low, audit prompt structure for cache-friendly ordering.

If the three mitigations together don't land cold-path synthesis under 45s with Opus, the standing policy gets re-litigated — but downgrading Maverick's voice to a non-frontier model should be the LAST option considered, not the first. The "strategic-intelligence layer never compromises" framing exists precisely because cost/latency arguments will appear and need a pre-locked answer.

---

## 7. v1.2 spec language (proposed §6.6 amendment)

Append to v1.1's amendment log alongside the OAuth §6.5:

> **6.6 — Model tier registry (5/15):** Maverick's LLM call sites consolidate to a single `lib/maverick/model-registry.ts` module that maps tier names (`premium_frontier`, `premium`, `cheap`) to current model IDs. Tier definitions name the capability profile + canonical callers; tier-to-model bindings update on every Anthropic release per the three-question re-evaluation protocol (replacement / shift / definition revision). The orchestrator role (Maverick himself — synthesizer, Pulse, BroCard reasoning) is permanently bound to `premium_frontier` and tracks Anthropic's current flagship Opus-class model. Pulse-driven model-release monitoring with BroCard-proposed tier updates ships in Phase 2 (post-Pulse-routine GA). Implementation folds into the Day 8+ refactor of `synthesize.ts` for Character Spec prompt anchoring; spec details: `docs/specs/MAVERICK_MODEL_REGISTRY_PROPOSAL.md`.

Add to `MAVERICK_OPS.md` (after v1.2 ships):
- New section "Model tier registry" naming the file location, the standing policy on Maverick = premium_frontier, the three-question protocol on each new model release, the commit-message convention.

---

## 8. Open questions for Alex

1. **Tier names.** `premium_frontier` / `premium` / `cheap` are functional but ugly. Alternatives considered: `frontier` / `standard` / `fast`, `flagship` / `analyst` / `classifier`, or domain-coded (`strategic` / `analytical` / `tactical`). Recommendation: keep `premium_frontier` / `premium` / `cheap` — the explicit "frontier" signals the no-compromise standing policy, and `cheap` is honest about the tier's purpose (the cost optimization for high-volume low-cognition work). But happy to adopt better names if you've got them.
2. **Tier #2 caller list.** Listed `appraiser_arv_analysis`, `scribe_contract_parse`, `scout_buyer_matching`, `ledger_economic_analysis` as canonical premium-tier callers. These are aspirational — none exist yet. Lock these now or wait until each agent ships and assign tier at integration time? Recommendation: keep them as spec guidance, treat as default-not-binding when each agent actually ships (the §3 Q2 audit revisits at integration).
3. **Phase 2 Pulse monitoring trigger.** Should Pulse register-monitoring be a separate cron from other Pulse routines, or rolled into a single daily introspection cron that covers multiple concerns? Recommendation: single daily cron (Hobby plan cap, and model-registry-check is a small workload that piggybacks naturally on the broader daily-introspection routine).
4. **Anything in this proposal you'd amend before lock?**

---

*Drafted 5/15/26 alongside the OAuth proposal. Locks when Alex marks "Accepted." Implementation defers to Day 8+ refactor of `synthesize.ts`; v1.2 spec language ships at the same v1.2 cut as OAuth §6.5.*
