# Code session handoff — 2026-05-18

Closing this session at ~95% context. Phase 4 ARV Intelligence Engine
shipped through 4C.1 (dual-track buyer pricing). Phase 4D (BroCard
rendering) briefed but **not started** — next session picks it up
clean. Fresh session expected to start with this doc loaded.

---

## Where the build sits

- **Branch:** `claude/fix-token-burn-cost-JUDad`
- **HEAD:** `946cd3b` (Commit K.4 — Master Checklist wrap, Phase 4C.1 → DONE)
- **Working tree:** clean (no staged or untracked code changes)
- **Tests:** 608/608 passing
- **Typecheck:** zero errors
- **Next.js build:** clean — 69 routes
- **Production deploy:** still gated on Phase 20.7 H1 — Alex chose
  to repoint the Claude.ai MCP connector to the branch preview alias
  rather than merge to main. Branch-tracking preview deployments fire
  automatically on every push to `claude/fix-token-burn-cost-JUDad`.

## Commit ladder this session

In sequence from earliest to latest. Each commit pushed to origin
immediately after. Phase 19.8 Spine wrap landed via direct Airtable
fallback (Maverick MCP intermittent) when applicable.

| Hash | Phase | Title |
|---|---|---|
| `f128497` | 20.2 / 3.2 / 3.11a / 12.8 | **Commit H** — v1.3 pricing amendment + Buyer_Median rename (carried forward from previous session) |
| `9471dc7` | 4A.1 | **Commit I.1** — Appraiser ARV endpoint + v1.3 MAO range envelope |
| `e4e281b` | 4A.1 | **Commit I.2 + I.3** — briefing wire + deal-detail ARV panel |
| `88e7820` | 4A.1 | **Commit I.4** — Master Checklist wrap |
| `a3243f6` | 4B.1 | **Commit J.1** — Appraiser rehab endpoint + BBC × market multiplier |
| `a492e39` | 4B.1 | **Commit J.2** — briefing wire + AppraiserRehabPanel |
| `9f5f479` | 4B.1 | **Commit J.3** — MAO-range integration via pickCalibratedRehab |
| `e151fff` | 4B.1 | **Commit J.4** — Master Checklist wrap |
| `956cb25` | 4C.1 | **Commit K.1** — Buyer Intelligence Dual-Track endpoint |
| `f416814` | 4C.1 | **Commit K.2** — briefing wire + dual-track deal-detail panel |
| `a84e93c` | 4C.1 | **Commit K.3** — MAO-range consumes dominant_value as floor |
| `946cd3b` | 4C.1 | **Commit K.4** — Master Checklist wrap (HEAD) |

Spine rows created this session (direct Airtable when Maverick down):
- `recoZqd3zTklediUO` — cleanup sprint summary (5/18)
- `recCqTItoptQ3L8dL` — Phase 4A.1 wrap
- `recKQjnTYIeXJTwaQ` — Phase 4B.1 wrap
- `recAE7ol1BVy1JYde` — Phase 4C.1 wrap

Airtable fields created this session via MCP:
- `fldfEVJijfPOBulpc` Seller_Motivation_Score (Phase 20.2 v1.3)
- `fldfJWuEIHqaRuWq3` Contract_Offer_Price (Phase 20.2 v1.3)
- `fldhl0njOHREJQ6Gd` `_Orphan_Outreach_Offer_Price_5_18` (orphan
  empty field from Commit H; Alex to delete in UI when convenient)
- `fldrFB0owY6BnQewr` Estimated_Monthly_Rent (Phase 4C.1)

---

## Active sprint brief — Phase 4D BroCard Two-Track Rendering

Verbatim from Alex's brief, what to execute in the next session:

> Next sprint: Phase 4D — BroCard Two-Track Rendering.
>
> Scope: Frontend only — no new endpoints, no new fields. Renders the
> full v1.3 range envelope { floor, target, list_price, dual_track,
> modifier_inputs } in the BroCard component so the dashboard surfaces
> the dual-track output the math layer now produces.
>
> Why this closes Phase 4: The math is live (4A.1 + 4B.1 + 4C.1) but
> the BroCard — the primary deal-glance UI — still renders single-track.
> Until the BroCard reflects dominant track, soft ceiling, and the
> range itself, the operator can't see what the math layer knows.
>
> Deliverables:
> - Locate existing BroCard component (deal-detail, factory floor, or
>   wherever it lives) and audit current state
> - Two-track render mode: when dual_track payload is present, show
>   both flipper and landlord MAO with dominant highlighted
> - Range envelope rendering: floor → target → list_price as a visual
>   gradient or three-stop bar, with soft-ceiling indicator at 75% of
>   list (Maverick caution flag per v1.3 amendment)
> - Modifier-inputs tooltip or expand-on-hover showing what drove the
>   calc (ARV, rehab tier, market multiplier, cap rate, rent,
>   wholesale fee)
> - Empty-state handling: pre-Phase-4 records still on legacy data
>   render in a clearly-labeled "Legacy" mode so the operator knows
>   the BroCard is showing stale math
> - Tests: snapshot or render tests for the four key states
>   (flipper-dominant, landlord-dominant, legacy-only, no-math-yet)
>
> Validation anchors:
> - 1219 E Highland Blvd 78210: $135K dominant (landlord), flipper at
>   $90K, list at ~$163K, soft ceiling at $122K (75% of list)
> - A flipper-dominant fixture from the K.1 tests
> - A legacy-only fixture (pre-4A.1 record)
>
> Don't do: Phase 13 Sentinel auto-scoring (target side still equals
> floor for now). Phase 14 Pulse self-monitoring. Stay in BroCard's
> render layer.
>
> Atomic boundary:
> - L.1 BroCard component refactor + render modes
> - L.2 modifier-inputs tooltip + soft-ceiling indicator
> - L.3 tests + storybook fixtures (if storybook exists)
> - L.4 Checklist wrap
>
> Phase 19.8 wrap: Direct Airtable fallback if Maverick still
> disconnected.

### Pre-Phase-4D intel gathered this session

Saves the next session 5-10 minutes of grep:

- **The BroCard component**: `BroCard` is a TS interface in
  `types/jarvis.ts` (line 66). Rendered by `CardBlock` in
  `components/JarvisGreeting.tsx` (line 91). Built by
  `app/api/jarvis-brief/route.ts` (line 110 `fallbackBroCard`, line
  214 `parseLLMCards`).
- **Current BroCard fields**: `rank, recordId, card_type, address,
  agent, headline, summary, why_this_matters, score, options,
  recommendation_index, agentContext?, dealStage?, metadata`. No
  pricing fields today.
- **Deprecation context**: `JarvisGreeting.tsx` carries an
  `@deprecated` JSDoc — superseded by Maverick Shepherd panel + the
  factory-floor agent rooms (Phase 9.x). The BroCard concept lives on;
  the surface it renders in is migrating. Phase 4D should target the
  current BroCard (JarvisGreeting) and consider whether to also wire
  into MaverickPriority or the deal-detail page. Recommendation:
  primary target is `CardBlock` in JarvisGreeting (matches Alex's
  brief "the BroCard component"); secondary surface — the deal-detail
  page already has `AppraiserBuyerIntelligencePanel` from Phase 4C.1
  K.2 which renders dual-track but in a different visual treatment.
- **Storybook**: not configured. No `.stories.*` files in the repo.
  L.3 tests will be pure-helper Vitest tests (formatters,
  classifiers) — same posture as every other test in the codebase
  per the explicit "Pure-function unit tests only — no React, no
  JSX, no DOM" rule in `vitest.config.ts`.
- **Existing `TwoTrackPricing.tsx`** (used by `components/DealCard.tsx`,
  the Deal-record card, not the action-queue card) renders pricing
  in a Deal-table context. Worth reading for visual prior art but
  it's Deal-not-Listing so the data shape differs.
- **Data source for pricing**: `jarvis-brief` route already fetches
  the listing per card via `fetchDealContext`. To populate the
  BroCard's pricing payload, compute via existing helpers
  (`computeMaoRange` with monthlyRent + state inputs) and attach a
  new optional `pricing?: BroCardPricing | null` field to the
  BroCard interface. This is the existing-endpoint modification path;
  no new endpoints.
- **Mode detection** (legacy vs Phase 4):
  - Phase 4-aware: `realArvMedian != null && estRehabMid != null`
    → compute MAO range, render full envelope
  - Legacy: missing one of the Phase 4 outputs → render "Legacy"
    badge + whatever's available (might be `Stored_Offer_Price` /
    `Outreach_Offer_Price` from the old single-track path)
  - No-math-yet: all pricing fields null → "No math yet" + Run
    actions deferring to deal-detail page

---

## Open items (NOT in Phase 4D scope; tracked for future sprints)

- **Phase 12.7** — DocuSign JWT credential provisioning. Alex's task
  in the DocuSign Admin Console. Once env lands
  (`DOCUSIGN_INTEGRATION_KEY` / `DOCUSIGN_USER_ID` /
  `DOCUSIGN_PRIVATE_KEY`), Scribe Phase 5 live data flows
  automatically — no code change.
- **Phase 12.9** — Make blueprint secret rotations: ScraperAPI key
  in Scenario I module 3 (`...d43c9803`) + OpenPhone key in H2
  module 2 (`...0c76d`). Both hardcoded in Make blueprints.
  Same procedure as the 5/18 Anthropic rotation. Alex's call when
  to fire. Not blocking anything.
- **Phase 12.8** docx — Constitution.docx in Alex's Claude Project
  knowledge needs the `Buyer_Tx_Median` → `Buyer_Median` find/replace.
  Project knowledge file, not in repo. Manual edit.
- **Phase 13 — Sentinel auto-scoring of Seller_Motivation_Score** —
  will enrich the `target` side of the MAO range envelope.
  Currently `target = floor` everywhere. Phase 4D should NOT
  pre-implement target/motivation logic; just render `target` as
  rendered by the math layer.
- **Phase 14 — Pulse self-monitoring** — gated, not in 4D scope.
  Plenty of breadcrumb data shipping for future Pulse:
  `non_user_synthesis` console events, `rehab_source` audit field,
  `rent_source` audit field, `pulse_event` lines in load-state route.
- **Phase 15+** — Ledger, Forge, etc. — not unblocked.
- **`_Orphan_Outreach_Offer_Price_5_18`** (`fldhl0njOHREJQ6Gd`)
  Airtable field — Alex to delete via UI when convenient. No code
  reads from it. Carries no data.
- **Pulse signal: `legacy_est_rehab` rehab_source** — Phase 4B.1
  J.3 surfaces this in the ARV endpoint's audit when a MAO floor
  was computed from legacy `estRehab` instead of calibrated
  `estRehabMid`. When Pulse ships, it should baseline this rate
  and alarm when it stays high (= many records overdue for Phase
  4B.1 re-calibration).

---

## Maverick MCP write_state status

**Intermittent across this session.** Reconnected and disconnected
3-4 times. The Maverick MCP server identifier rotated between
`mcp__f3b378e8-3b40-4888-a06d-980cecc81672__*` and `mcp__Maverick__*`
at different points.

**Fallback that worked end-to-end:** direct Airtable writes to
Spine_Decision_Log via `mcp__81bcefa1-...__create_records_for_table`.
Skips the audit-log side effect (Maverick MCP would have also
written an audit row); Spine row contains the equivalent metadata in
its `Trigger_Event` field including `spine_via=direct_airtable
(Maverick MCP disconnected)` marker.

If next session sees Maverick MCP available — use it via
`maverick_write_state` per Phase 19.8 ritual.
If not — fall back to direct Airtable per the pattern used in this
session's J.4 and K.4 wraps.

---

## Working-directory gotcha

Multiple times this session, `Bash` calls executed from
`/home/user/coach-pulse` instead of `/home/user/coach-pulse/akb-dashboard`,
which makes `npx tsc` / `npx vitest` / `npx next build` resolve to
the wrong tool / fail to find the project. Symptoms: typecheck
"shows tsc help instead of errors", build "Couldn't find any `pages`
or `app` directory", tests run a different subset.

**Always `cd /home/user/coach-pulse/akb-dashboard &&` before npx commands.**
The Bash tool's working dir doesn't persist between calls in this
environment. A leading `cd` per command is the reliable pattern.

For git commands, the repo root is `/home/user/coach-pulse` (one
level above akb-dashboard). git commands work from either. `git
status` from the outer dir shows paths prefixed with
`akb-dashboard/...`.

---

## Anything mid-flight or partially staged

**Nothing.** Working tree is clean. The Phase 4D intel-gathering
work above (BroCard/CardBlock/jarvis-brief inspection) consumed
context but produced no code changes. The audit findings are
documented above so the next session doesn't repeat them.

---

## Alex's operating posture

- **Ship Inevitable 1.0 complete.** No half-manual outreach paths
  shipping in 1.0. If a sub-phase isn't done, it's not done. The
  dual-track math being live without BroCard rendering it is the
  exact failure mode Phase 4D closes.
- **One sub-phase at a time.** Don't pre-implement 4D's tooltip
  during 4D.1, etc. Each sub-commit lands atomically and is
  reviewable.
- **Push to the branch, don't merge to main yet.** Production
  deploy continues via branch preview alias per Phase 20.7 H1
  resolution. Merge-to-main is a separate explicit step Alex
  triggers when he wants production to flip.
- **Phase 19.8 ritual is load-bearing.** Every Code commit on this
  branch ships a Spine entry (`maverick_write_state` when MCP up,
  direct Airtable when down). This is the continuity layer that
  bridges sessions; the previous Phase 20.7 incident hardened it.
- **Validation anchors are sacred.** 1219 E Highland Blvd 78210 is
  the canonical test fixture. Math at the various phases:
  - Phase 4A.1 anchor: $165K ARV → $90K flipper-only floor
  - Phase 4B.1 anchor: $45K Medium tier (or $75K Heavy)
  - Phase 4C.1 anchor: $1400 rent, 8% cap → $135K landlord >
    $90K flipper, +$45K money on the table
  - Phase 4D should render this property's BroCard with the $135K
    dominant + $90K flipper + soft ceiling at $122K (75% of $163K
    list) + Medium-tier modifier-inputs payload.
- **Trust the audit trail.** Pulse will eventually read these
  audits. Be generous with `outputSummary` fields — `rehab_source`,
  `rent_source`, `dominant_track`, `flipper_mao`, `landlord_mao`,
  etc. are all already wired.

---

## Recommended first action for next session

1. Load this handoff doc.
2. `git status` + `git log -1` to confirm HEAD is `946cd3b` and
   tree is clean.
3. `cd /home/user/coach-pulse/akb-dashboard && npx vitest run
   --reporter=dot` to confirm 608/608 still passing.
4. Begin **Commit L.1** — extend `BroCard` interface with
   `pricing?: BroCardPricing | null`; populate from
   `/api/jarvis-brief` route via `computeMaoRange`; create
   `components/brocard/PricingBlock.tsx` and wire into
   `CardBlock` in `JarvisGreeting.tsx`.

Standing by — fresh session take it.
