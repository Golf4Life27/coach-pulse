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
- `[enforced]` Pricer guards distrust an ARV below list and floor sub-floor openers to
  65% of list (`lib/per-market-pricer.ts`).

## 3. Sticky offers

The seller-facing number does not drift. `Outreach_Offer_Price` (the 65%-of-list
opener) is captured once at outreach time and is **never recomputed, never
overwritten**. `Contract_Offer_Price` is sticky during negotiation (DD may move it,
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
side-effect: the live table holds **0** records in these states.) **Memphis is
PAUSED** (configured market `memphis_tn`, but not to be actioned per operator).

- `[enforced]` `lib/crawler/intake-filter.ts:30` `EXCLUDED_STATES = {IL,MO,SC,NC,OK,ND}`;
  Pre-Outreach `PO-05` `restricted_states` (`lib/config/gates/pre_outreach.json`).
- `[operator/unknown]` Memphis pause: market exists in `lib/config/markets.json`; the
  exact pause-enforcement location is **not verified** — confirm before any Memphis run.

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

---

### How to verify the spine holds (no secrets needed)

`npm run dry-run-trace` walks three real records through the gates + pricer with all
external I/O mocked and **zero** writes/sends, printing how each is priced and which
gate stops it. That trace is the seed "is the pipeline alive" check; future changes
that break it fail `lib/orchestrator/dry-run-trace.test.ts`.
