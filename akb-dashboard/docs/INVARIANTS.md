# INVARIANTS — the hard rules of the AKB / CONVEYOR system

> **This is the spine. Load it every session, before acting.** These rules do not
> live in anyone's head — they live here, and where possible they are enforced in
> code (cited). Breaking one is never a "judgment call"; if a change appears to
> require breaking one, **stop and escalate to the operator.**
>
> Tags: `[enforced <path>]` = there is code that enforces it (read this session);
> `[doc]` = principle, not uniformly enforced; `[operator]` = human gate, off by
> default. Last updated 2026-06-16.

---

## 1. No fabricated numbers — ever

Never present an estimate, count, balance, or status as fact. Distinguish three
states — confirmed success / confirmed failure / **uncertain** — and say "unknown"
when you have not verified. Paginate before you count (the cohort is **4,858**
Listings_V1 records, not a first page). A computed gate that lacks clean inputs
returns *not_yet_evaluated*, **never a guess**.

- `[doc]` `docs/Positive_Confirmation_Principle.md` (three-state truth).
- `[enforced]` `computeMathGate(...)` returns `not_yet_evaluated` when either input
  is missing/non-positive — "never guessed" (`app/api/orchestrator/pre-emd-evaluate`,
  test `lib/orchestrator/pre-emd-evaluate.test.ts`).
- `[enforced]` `probeFirecrawlBalance()` returns `null` (→ "unknown") rather than a
  wrong guess on any failure (`lib/crawler/sources/firecrawl.ts:40`).

## 2. Pessimistic rehab bounds

Underwrite the floor, not the median. Use the **conservative ARV anchor AND the
HIGH end of the rehab band** ("what if everything goes bad"). If the pessimistic MAO
clears the sticky floor → robust; if not → **escalate, never auto-pass**. Heavy
rehab scope (gut / exposed wiring / incomplete bath) caps the ARV tier you may
underwrite against.

- `[enforced]` `lib/markets/pessimistic-mao.ts` — `computePessimisticMao` (conservative
  ARV + `rehabHigh`), `classifyRehabTier`, verdict `robust|marginal|fails_floor|hold`.
- `[enforced]` **The autonomous opener is VALUE-anchored or it HOLDS — it is NEVER
  anchored to the seller's list price** (operator 2026-06-28, after the Blackmoor
  $84.5k catastrophe: 0.65 × $130k list on a ~$40k house). The flat 65%-of-list
  fallback is retired. The opener is `anchor × (ARV × buybox − rehab − fee)`; with no
  trusted ARV basis the pricer returns `opener: null` and the record routes to
  operator review. Pricer guards (ARV-below-list distrust, sub-floor micro-opener,
  non-penciling buy-box) **HOLD**, they do not fall to a list fraction.
- `[enforced]` **ARV basis hierarchy: the record's OWN comps → ZIP seed → stored
  field → HOLD** (operator ruling 2026-08-14, after 1708 Cardinal — seed built
  10/12 from neighbor ZIPs underpriced the opener by ~$58k vs the record's own 30
  comps — and 9360 Cheyenne — stored field 2× its own comps). `ARV_Comp_Details_JSON`
  is EVIDENCE, recomputed at read time by `lib/pricing/own-comps-arv.ts` behind
  hard rails (exclusion receipts dropped, subject self-print dropped, deed/portfolio
  dedupe, AVM price-shape quarantine, ≥5 usable comps, cross-source divergence vs a
  STRONG seed). The own-comps basis prices as **THIN** — ARV-below-list HOLDS, never
  auto-sends the over-ARV-list lowball — until a renovated-cluster upgrade with a
  shadow cohort earns STRONG.
  - **ARV-below-list is CONFIDENCE-AWARE** (operator principle amendment
    2026-07-22, superseding the 2026-06-28 blanket hold): a **STRONG** seed
    (≥5 tight renovated comps) with ARV < list SENDS the value-anchored
    lowball — the seed is trusted, the *listing* is over-ARV (exactly the aged
    tier-8 stock), and list price is structurally not an input to the formula.
    Sent records carry the `over_arv_list` cohort tag (`Opener_Basis`
    `arv_buybox_seed_over_arv_list`) so reply/conversion is trackable and the
    amendment reversible on evidence. THIN/STORED/unlabeled ARVs below list
    still HOLD + flag re-seed, and every downstream guard (micro-opener floor,
    MAO bound, never-over-list clamp) applies unchanged.
    `[enforced]` `lib/per-market-pricer.ts` ARV-sanity gate. **NO fraction of list survives as a
  producer** (operator ruling recmy2Vwp1wMA1Vs8 2026-07-06, producer path killed
  2026-07-27 — "no value in it"): the former never-over-list *clamp* (`0.85 × list`,
  operator 2026-07-01) is retired. It laundered inflated ARVs into confident
  list-anchored texts — the 43-record `capped_to_list` cohort, 533 Robison $29,750
  (portfolio-deed-poisoned $944K ARV on a collapsed house), 1122 West Ave $110,499.
  `NEVER_OVER_LIST_PCT` survives only as the **over-list TRIPWIRE threshold**: an
  opener above `floor(0.85 × list)` HOLDS and surfaces for operator review (Type 2C,
  `Opener_Basis` `hold_over_list_tripwire`) with the computed number preserved in the
  receipt — deep discount or broken inputs, the operator decides. Keep the threshold
  EQUAL to the `>85%-of-list` send rail `OFFER_OVER_LIST_BLOCK_PCT` so everything that
  passes the tripwire also clears the rail. (`lib/per-market-pricer.ts`,
  `lib/rough-opener-ceiling.ts`).
- `[enforced]` **PRE-SEND CORROBORATION GATE — allowlist, not blocklist** (operator
  2026-07-23, reliability build). Even after every pricer guard passes, a computed
  opener must be CORROBORATED by INDEPENDENT sanity signals to reach a seller; ANY red
  flag → the record HOLDS for operator review. The default is **hold-and-ask on an
  un-corroborated number**, not send-and-hope — so an un-anticipated pricing bug stops
  and surfaces instead of texting a seller. Signals (all pure, independent of the
  pricer's own math): **size_extrapolation** (subject sqft outside the seed's comp size
  band — the 927 Avon $121k bug), **arv_implausible_vs_list** (renovated ARV > 2.5× list),
  **psf_out_of_range** (renovated $/sqft outside $15–$600), **capped_untrusted_arv** (opener
  only survived by clamping to list on a non-STRONG ARV — 110 Leathers / 868 N Main),
  **infeasible_ask** (operator 2026-07-25, the 529 Bina "insane ask" / 2048 Joffre class:
  even the ZERO-rehab best-case opener — same ARV/anchor/buy-box/MAO-bound/list-cap math,
  perfect condition — lands under 55% of the ask, so no sendable number exists; the
  best-case figure is a TEST, never a text — distressed stock keeps its pessimistic
  opener untouched. This NARROWS the 2026-07-22 `over_arv_list` amendment: over-ARV
  lowballs still send, but only when the ask is structurally reachable).
  Thresholds env-tunable. `Opener_Basis` `hold_failed_corroboration` marks a gated HOLD.
- `[enforced]` **RENOVATED-LISTING VETO** (operator 2026-07-25, the 914 Dan St /
  529 Bina insult class — "AVOID RENOVATED HOUSES"): a listing whose page copy
  affirmatively markets it as renovated/updated/turnkey (Firecrawl
  `hasRenovatedLanguage`) WITHOUT distress language is NEVER first-touch texted
  and NEVER bumped — a distress opener at a turnkey ask cannot convert; it only
  burns the agent. The verdict was ALREADY computed by `verifyListingByUrl` on
  every freshness pass and thrown away; it is now persisted to
  `Renovated_Language` (fldnNSji9OLcDPRu9) by EVERY route that scrapes page copy —
  `freshness-reverify`, `price-drop-fastlane`, `backlog-reprice`, `reverify-queue`,
  `url-backfill`, and `parked-followup`'s pre-send probe (which also suppresses that
  send) — and enforced in `isH2Eligible` / `outreachReadyReason` (first touch),
  `bumpVerdict` (bumps), `emailRecoveryVerdict` (recovery email), the send-gate's
  `OPENER_PURPOSES` veto (first_touch + bump + followup — every purpose except a
  conversational reply), and the offer-letter route (hard 422 on a flagged basis
  unless `?override=1`). (Burn-down 2026-07-28, audit Spine recV9zpfSyF6BYbOj;
  `admin/outreach-batch` — the last MAO_V1-quoting sender — retired the same day.) Distress copy still overrides ("investor special — recently
  updated"), and the flag clears when a later scrape finds distress language,
  so price-cut re-engagement stays possible. Zero added API cost — the page
  was already being fetched.
  `[enforced]` `lib/opener-sanity-gate.ts` (`corroborateOpener`), wired as the final
  gate in `lib/opener-pricing.ts` (`priceOpenerWithSeed`) — the ONE choke point both the
  live send path and the read-only dry-run share.
- `[enforced]` **BUMP RE-PRICE GATE — recompute before queueing on the bump lane**
  (2026-07-27, the 963 W 3rd miss: RentCast intake → no page copy → `Renovated_Language`
  never set → the flag veto was blind, and a pre-gate $57,000 was bumped into a fully
  renovated $132,900 listing). The `Renovated_Language` flag is only as good as the last
  page scrape, so every bump ALSO re-runs the canonical pricer
  (`priceOpenerWithSeed`) on the record's CURRENT inputs as a go/no-go check: any hold —
  feasibility `infeasible_ask`, the over-list tripwire, ARV distrust, failed
  corroboration — blocks the bump (audited `h2_bump_reprice_hold`). The STICKY number is
  never modified and never replaced (INVARIANTS §3 unchanged): the gate decides whether
  we may still SAY it, never what we say. `[enforced]` `bumpRepriceGate`
  (`lib/h2-outreach/bump-lane.ts`) + `app/api/cron/bump-followup/route.ts`.
- `[enforced]` **ARV FROM A STRONG SEED IS SIZE-ADJUSTED SALES COMPARISON, NOT FLAT
  $/sqft** (reliability build #2, 2026-07-23). A STRONG seed carries its comps; the ARV
  for a subject is a similarity-weighted (size-proximity × distance) blend of the comp
  prices, each scaled to the subject's size **sub-linearly** (`price ∝ sqft^β`, β≈0.75 —
  bigger houses cost more in total but less per added sqft). This is what an appraiser
  does by hand and it removes the flat-`$/sqft × sqft` distortion that over-priced Avon.
  Falls back to `$/sqft × sqft` only when a seed has no comp receipts (older seeds) or too
  few comps; THIN seeds keep the conservative low-end `$/sqft`. `[enforced]`
  `lib/comp-adjustment.ts` (`adjustedArvFromComps`), used by `arvForSubjectFromSeed`.

## 3. Sticky offers

The seller-facing number does not drift. `Outreach_Offer_Price` (the value-anchored
opener — see §2; never a list fraction) is captured once at outreach time and is
**never recomputed, never overwritten**. `Contract_Offer_Price` is sticky during negotiation (DD may move it,
but it has a hard V2.1 floor and is not silently recomputed).

- `[enforced]` `lib/types.ts:75-84` (field contracts); `lib/airtable.ts:126-135`.

## 4. One concept per table, per surface

A given fact lives in exactly one place. Pre-EMD deal-level state lives on **Deals**,
never on Listings_V1 (INV-023 / INV-029, 2026-06-10). Economics map to the clean V2.1
fields, never the quarantined legacy formula fields.

- `[enforced]` `lib/types.ts:141,219-220`; `lib/airtable.ts:278` ("one concept, one
  table").

## 5. Geographic exclusions (PERMANENT): IL, MO, SC, NC, OK, ND

Wholesale-restrictive states are excluded at intake **and** at the gate. (Verified
side-effect: the live table holds **0** records in these states.) **Memphis (TN) is
OPEN for outreach** (unpaused 2026-07-23, operator). TN assignability is enforced at
the **money doors**, not by blocking outreach: `PE-04` (assignment-clause attestation,
every state, at EMD) and `PC-16` (TN Memphis-compliant assignment language, at
contract) hold the line — no earnest money leaves on a TN deal until assignment is
confirmed with the seller and in the contract.

- `[enforced]` `lib/crawler/intake-filter.ts:30` `EXCLUDED_STATES = {IL,MO,SC,NC,OK,ND}`;
  Pre-Outreach `PO-05` `restricted_states` (`lib/config/gates/pre_outreach.json`).
- `[enforced]` TN assignability at EMD/contract: `lib/orchestrator/pre-emd-checks.ts`
  `PE-04`; `lib/orchestrator/pre-contract-checks.ts` `PC-16`.
- `[history]` Memphis was outreach-paused 2026-04-26→2026-07-23; `PAUSED_MARKETS` in
  `lib/markets/actionable.ts` and `app/v2/_lib/policy.ts` are now empty.

## 6. Operator gates (human-in-the-loop; OFF by default)

These actions require an explicit human decision and do not happen autonomously:

1. **CMA approval** — `[operator]` Deal `preEmdCmaValidated` attestation
   (`lib/types.ts` DealGateSnapshot).
2. **Buyer-ceiling confirmation** — `[operator]` `preEmdArvConfirmed` /
   underwriting-MAO confirmation before a deal advances.
3. **Offer approval / SEND** — `[enforced/operator]` outbound texts are hard-disabled:
   `H2_OUTREACH_HARD_DISABLE !== "false"` ⇒ 503 (`app/api/cron/h2-outreach/route.ts:171`).
   Follow-ups gated by `FOLLOWUP_SEND_ENABLED`; DocuSign/EMD is manual.
4. **Pre-EMD operator sign-off** — `[operator]` `preEmdOperatorSignoff` /
   `preEmdAssignmentClauseVerified` (required EVERY state).

## 7. Safety brakes (must never be removed without a replacement)

- **Firecrawl spend breaker** — `shouldHaltVerify({breakerTripped, balanceRemaining})`
  skips the verify phase (zero spend) when the breaker is tripped OR the wallet ≤ 0;
  hourly cap `FIRECRAWL_HOURLY_CREDIT_CAP = 800`. No background process may touch a
  paid API without a brake that HALTS before it drains the wallet.
  `[enforced]` `lib/crawler/firecrawl-circuit-breaker.ts:71`, wired into
  `app/api/cron/listings-intake/route.ts:827`.
  - **Known gap `[unknown]`:** the breaker + scope gate fail-OPEN on a KV/store
    outage; a fail-narrow allowlist fix was flagged 2026-06-09 — verify it shipped.
- **Daily send meter (2026-07-22 volume ramp)** — total LIVE H2 sends per UTC day
  are hard-bounded by `H2_DAILY_SEND_CAP` (default **100** = the operator's ruled
  supply target; code ceiling 150 — env tunes DOWN only). Each run's per-run cap
  is clamped to the unspent daily allowance via a KV meter; the meter increments
  on every SMS actually dispatched. Added WITH the multi-slot ramp (8 h2 slots ×
  per-run 12 default) precisely so slot count can never multiply into an unbounded
  day. Unreadable meter → per-run cap alone (crawl-meter contract), surfaced in
  the run summary — never silent.
  `[enforced]` `lib/outreach/send-cap.ts` (`readDailySendCap`, `governDailySends`),
  wired in `app/api/cron/h2-outreach/route.ts`.
- **ONE OUTBOUND SEND CHOKE POINT (2026-07-26 consolidation)** — every
  seller/agent-facing SMS passes through `sendGuarded` and NOTHING calls the raw
  Quo sender directly. Lanes each re-implementing their own guards is what
  produced the recurring bugs (a duplicate outbound to the same agent across two
  same-phone listings; a renovated veto added to two lanes separately). The gate
  is the FLOOR — lanes keep their stricter guards on top of it — and enforces:
  (a) `doNotText` refuse, always; (b) renovated-listing veto for `first_touch` /
  `bump` only (conversational replies allowed); (c) NUMBER-level duplicate
  suppression — identical body to the same E.164 within 30 min refused (the
  check no per-record claim could make); (d) mandatory `purpose` + `recordId`
  audit tags. (a)/(b)/(d) are PURE and always enforced; (c) needs KV and FAILS
  OPEN on outage (audited every time) — an infra blip must never silently dark
  all outreach. `[enforced]` `lib/outreach/send-gate.ts`, tests
  `lib/outreach/send-gate.test.ts`. Deliberately OUTSIDE the gate: the
  operator-alert channel (`ALERT_PHONE`/`ALERT_FROM` — morning-digest,
  decision-escalation, reply-alert, zip-approval notify, maverick sms-escalation)
  and the buyer dispo blast; they carry no listing, no seller, and their own
  per-key dedupe.
- **THE LOWBALL-ELIGIBILITY DOCTRINE IS LIVE (2026-07-26)** — `lib/lowball-eligibility`
  (TIME-ON-MARKET decides at cumulative DOM ≥ 60; vision only ADDS via
  language+visual corroboration; uncertainty errs toward NOT sending) previously
  had NO live caller — it was previewed and never enforced. It now gates the
  h2-outreach pricing loop BEFORE an opener is priced; a non-eligible record is
  pushed to `openerGuarded` with reason `lowball_not_eligible_<tier>` and never
  sends. Preview and live share ONE signal implementation
  (`lib/lowball-signals.ts`) so they cannot drift. Counts surface as
  `lowball_gate` in the route response.
  `[enforced]` `app/api/cron/h2-outreach/route.ts`, tests `lib/lowball-signals.test.ts`.
- **RentCast crawl budget governor (unchanged, restated)** — the intake belt's
  daily ZIP spend derives from the plan (`computeDailyCrawlBudget`) and is metered
  in KV; adding cron slots widens THROUGHPUT, never SPEND. The 2026-07-22 tiered
  cadence (chewed/opener-HOLD ZIPs recrawl weekly/biweekly) reallocates that same
  budget toward fresh metros — it does not raise it.
  `[enforced]` `lib/crawler/frontier-governor.ts`, `lib/crawler/zip-rotation.ts`.

---

### How to verify the spine holds (no secrets needed)

`npm run dry-run-trace` walks three real records through the gates + pricer with all
external I/O mocked and **zero** writes/sends, printing how each is priced and which
gate stops it. That trace is the seed "is the pipeline alive" check; future changes
that break it fail `lib/orchestrator/dry-run-trace.test.ts`.
