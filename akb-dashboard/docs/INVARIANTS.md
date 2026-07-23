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
  fallback is retired. The opener is `anchor × (ARV × buybox − rehab − fee)` where ARV
  is the ZIP renovated `$/sqft` × subject sqft; with no trusted ARV basis the pricer
  returns `opener: null` and the record routes to operator review. Pricer guards
  (ARV-below-list distrust, sub-floor micro-opener, non-penciling buy-box) **HOLD**,
  they do not fall to a list fraction.
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
    `[enforced]` `lib/per-market-pricer.ts` ARV-sanity gate. The only place a fraction of list survives is
  the never-over-list *clamp* (`0.85 × list`, operator 2026-07-01 — set EQUAL to the
  `>85%-of-list` send rail `OFFER_OVER_LIST_BLOCK_PCT` and **floored** so a capped
  opener can never round up past it and get refused), which only ever lowers an already
  value-anchored opener. Keep the clamp ≤ the send rail. (`lib/per-market-pricer.ts`,
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
  only survived by clamping to list on a non-STRONG ARV — 110 Leathers / 868 N Main).
  Thresholds env-tunable. `Opener_Basis` `hold_failed_corroboration` marks a gated HOLD.
  `[enforced]` `lib/opener-sanity-gate.ts` (`corroborateOpener`), wired as the final
  gate in `lib/opener-pricing.ts` (`priceOpenerWithSeed`) — the ONE choke point both the
  live send path and the read-only dry-run share.
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
