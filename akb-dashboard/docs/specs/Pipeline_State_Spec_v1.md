# Pipeline_State Model — v1 Spec (LOCKED)

**Status:** model LOCKED 2026-05-31 (operator ratified all four decisions).
**Owner:** Alex Balog. **Author surface:** Maverick (orchestrator).
**Supersedes:** the seven-surface status tangle audited 2026-05-31.
**Records:** NOT migrated by this spec. Backfill is a separate,
operator-reviewed, dry-run-first step (see §7).

---

## 1. Why this exists

Property status is currently spread across **seven** surfaces with no
single owner. They overlap and actively contradict, which is what
flags under-contract / mid-negotiation deals (e.g. **23 Fields Ave**)
as stale/dead in the briefing.

Audited tangle (live data, 2026-05-31, base `appp8inLAGTg4qpEZ`,
`Listings_V1` `tbldMjKBgPiq45Jjs`):

| # | Field (id) | Type | Real meaning today |
|---|---|---|---|
| 1 | `Outreach_Status` (`fldGIgqwyCJg4uFyv`) | singleSelect, 13 choices incl. `""`, dup `Review`/`Manual Review` | de-facto lifecycle; written by inbound classification + manual + H2; overloaded with funnel stage AND channel state AND ops flags |
| 2 | `Execution_Path` (`fldOrWvqKcc1g6Lka`) | singleSelect: Auto Proceed / Proceed With Offer Probe / Manual Review / Reject | intake-gate verdict (co-written with Live_Status by verify-listing) |
| 3 | `Live_Status` (`fldCKnC1nnXEnTUKL`) | singleSelect, 8 choices | scraped MLS listing status; app only writes `Active`/`Off Market` |
| 4 | `Approved_For_Outreach` (`fldbYzkL24aQ1Y1xz`) | checkbox | **never written by code**; read once (orchestrator PS-10) |
| 5 | `Stage_Calc_V2` (`fldA8B9zOCneF0rjp`) | formula → text | intake math pass/reject; **never consumed in app** |
| 6 | **`Pipeline_Stage` (`fldJt2pSCHiXqBxwj`)** | singleSelect, 12-value lifecycle | intended lifecycle SoT; wired to orchestrator gate machine; **0 of ~3,644 records populated** |
| 7 | `MLS_Status` (`fldif6WwcJeXZtJcX`) + derived `DealStage` (`lib/deal-stage.ts`) | singleSelect (dirty: `Active` vs `ACTIVE`) / computed | raw input / parallel display-stage derived from Outreach_Status |

### The smoking gun — 23 Fields Ave (`rec1HTUqK0YEVb7uA`, live)

| Surface | Value | Asserts |
|---|---|---|
| `Outreach_Status` | **Negotiating** | live, mid-negotiation |
| `Execution_Path` | **Reject** | intake killed it |
| `Stage_Calc_V2` | **Passed: Ready for Offer** | intake math passed it |
| `Live_Status` / `MLS_Status` | Active / ACTIVE | still listed |
| `Pipeline_Stage` | *(empty)* | the lifecycle field is blank |
| `Envelope_ID` | *(empty)* | so `isUnderContract()` cannot fire |
| last touch | ~43 days | — |

Four contradictory status assertions on one record. The legacy
operational briefing surfaces (`lib/actionQueue.ts:178`,
`app/api/morning-briefing/route.ts:196`) compute "stale" from
`Outreach_Status` + days-since-touch with **no under-contract guard**,
so this record reads as stale/dead.

Quantified contradiction class: **17** records carry
`Execution_Path=Reject` AND `Outreach_Status ∈ {Negotiating, Response
Received, Offer Accepted}`. (`Negotiating`=6, `Offer Accepted`=0,
`Live_Status=Under Contract`=2, `Pipeline_Stage` populated=0.)

---

## 2. Locked decisions (operator-ratified 2026-05-31)

1. **Reuse the existing `Pipeline_Stage`** (`fldJt2pSCHiXqBxwj`) as the
   single source of truth. **No new `Pipeline_State` field** — a
   near-homonym beside `Pipeline_Stage` / `Stage_Calc_V2` / `DealStage`
   would deepen the confusion being removed. ("Pipeline_State" is the
   *concept*; `Pipeline_Stage` is the *field* that realizes it.)
2. **Add a `responded` stage** between `outreach_sent` and
   `negotiating`, to preserve the "they replied, not yet engaged"
   signal (`Outreach_Status=Response Received`) that cadence depends on.
3. **Populate via derive/backfill** from the existing tangle, as a
   **separate operator-reviewed dry-run-first step** — NOT in this spec
   commit, NOT auto-applied.
4. **Generalize `isUnderContract`** from `Boolean(envelopeId)` to
   stage-based (at/after `under_contract`).

---

## 3. Canonical value set

`Pipeline_Stage` (singleSelect). Forward lifecycle, one terminal:

```
intake → verified → priced → outreach_ready → outreach_sent
       → responded → negotiating → offer_drafted → under_contract
       → dispo_active → assignment_signed → closed
                                                   ⤷ dead  (terminal failure, from any non-terminal)
```

| Stage | Meaning | Maps from legacy |
|---|---|---|
| `intake` | ingested, not yet verified | new RentCast/crawler intake |
| `verified` | listing confirmed live + valid | `Execution_Path` resolved, `Live_Status=Active` |
| `priced` | MAO / offer math computed | pricing agent ran |
| `outreach_ready` | eligible to send, awaiting gate | `Execution_Path=Auto Proceed` + empty `Outreach_Status` |
| `outreach_sent` | first-touch SMS/email sent | `Outreach_Status ∈ {Texted, Emailed, Texted (Portfolio)}` |
| `responded` | **NEW** — agent replied, not yet engaged | `Outreach_Status=Response Received` |
| `negotiating` | active back-and-forth | `Outreach_Status ∈ {Negotiating, Counter Received}` |
| `offer_drafted` | written offer / contract drafted | `contractOfferPrice` set; `Outreach_Status=Offer Accepted` (pre-envelope) |
| `under_contract` | executed / envelope out | `Envelope_ID` present; `Outreach_Status=Contract Signed` |
| `dispo_active` | marketing to buyers | Scout dispo queue |
| `assignment_signed` | assignment executed | — |
| `closed` | deal closed | won/closed statuses |
| `dead` | terminal failure | `Outreach_Status=Dead` / `Execution_Path=Reject` / off-market confirmed / no-response timeout |

(13 values: the existing 12 + `responded`.) `Stage_Calc_V2`'s
`Manual Review`/`Data Issue` outcomes are NOT stages — they hold a
record at `intake`/`verified` behind a gate, surfaced via gate status.

---

## 4. Legal transitions (the state machine)

**Forward, one step at a time, each guarded.** The orchestrator gate
machine (`lib/orchestrator`, `STAGE_PROGRESSION_GATES`) already maps
stage → next gate; transitions reuse it.

```
intake          --[Gate: Pre-Outreach verify]-->  verified
verified        --[Gate: pricing complete]------>  priced
priced          --[Gate: outreach-eligible]----->  outreach_ready
outreach_ready  --[Gate: Pre-Send]-------------->  outreach_sent
outreach_sent   --[inbound reply received]------>  responded
responded       --[engagement / counter]-------->  negotiating
negotiating     --[offer/contract drafted]------>  offer_drafted
offer_drafted   --[envelope out / executed]----->  under_contract
under_contract  --[assignment to buyer]--------->  dispo_active
dispo_active    --[assignment signed]----------->  assignment_signed
assignment_signed --[close]--------------------->  closed
```

**Kill edge:** `<any non-terminal> → dead`
(bad phone, off-market/sold confirmed, no-response timeout, walked,
intake-reject). Intake-reject (`Execution_Path=Reject`) is
`intake → dead`, **never** a live stage — so a rejected record can
never again be counted as active.

**Resurrection edge:** `dead → responded | negotiating`
on a fresh inbound reply (mirrors existing `lib/resurrection.ts`).

**Illegal:** skipping forward >1 stage without its gate; any edge out
of `closed`; any writer other than the transition engine (§6).

### Pre-Send gate inputs (where the legacy fields go to work)

`outreach_ready → outreach_sent` is allowed only when ALL hold —
these are the demoted legacy fields, now serving as transition INPUTS:
- `Live_Status = Active` (listing alive)
- `Execution_Path = Auto Proceed` **OR** `Approved_For_Outreach = true`
- `Do_Not_Text = false`
- valid normalized `Agent_Phone`, `Source_Version = v2`

---

## 5. Field role reassignment

| Field | New role |
|---|---|
| **`Pipeline_Stage`** | **Source of truth.** Every "where is this deal" read resolves here. |
| `Live_Status` / `MLS_Status` | **Input signals** to transition guards (alive? off-market→dead). Dedup `Active`/`ACTIVE`. Not status. |
| `Execution_Path` | **Intake-gate verdict** → computes initial stage (`outreach_ready` vs `dead`/held). Frozen after intake. |
| `Approved_For_Outreach` | **Operator-approval boolean** feeding the Pre-Send gate. Finally given a writer, or retired if unused. |
| `Stage_Calc_V2` | Read-only intake-math **input**; dropped from all status surfaces. |
| `Outreach_Status` | **Channel/sub-state** within the outreach phase during migration; consumers move to `Pipeline_Stage` per-scenario, then it retires LAST. |
| `DealStage` (derived) | Re-pointed to read `Pipeline_Stage` instead of deriving from `Outreach_Status`. |

### `isUnderContract` generalization (decision 4)

```
// before: Boolean(listing.envelopeId)
// after : stage-based, envelope as a fallback during migration
isUnderContract(l) =
  STAGE_ORDER[l.pipelineStage] >= STAGE_ORDER["under_contract"]
  || Boolean(l.envelopeId)   // transitional fallback until backfill lands
```

This fixes 23 Fields directly: its stale guard keys on the lifecycle,
not on an optional `Envelope_ID` it never had. Once backfilled,
23 Fields = `Pipeline_Stage: negotiating`; `Execution_Path=Reject`
becomes a historical intake input and stops contradicting.

---

## 6. The transition engine (Vercel-native worker — sole writer)

A new Vercel-native worker is **the only thing that writes
`Pipeline_Stage`.** It enforces the §4 edge legality (reject illegal
jumps), records every transition to the audit log + Spine, and exposes:

- a pure `lib/pipeline-state/` core: `PIPELINE_STAGES`, `STAGE_ORDER`,
  `isLegalTransition(from, to)`, `nextStages(from)`, and the legacy→stage
  derivation map (used by the §7 backfill, not auto-run).
- an `advance-stage`-style API the existing orchestrator gate routes
  call instead of writing `Pipeline_Stage` ad hoc.

**No other code path writes `Pipeline_Stage`.** Today only D3
(`d3-scrub`, `d3-cadence`) and `advance-stage` write it (always
`"dead"` or operator-triggered); those route through the engine.

### Make coexistence (architecture default)

Make scenarios that currently write `Outreach_Status` **keep running
untouched.** The engine derives `Pipeline_Stage` transitions; consumers
and Make scenarios migrate to `Pipeline_Stage` **per scenario**, each
Make scenario retired only as its Vercel-native replacement lands.
`Outreach_Status` retires last, once no consumer reads it.

---

## 7. Rollout (NOT executed by this spec)

1. **Lock the model** — done (§2).
2. **Build the engine** (§6): pure core + tests + the sole-writer route;
   generalize `isUnderContract`; re-point `DealStage`. New Vercel-native
   worker on Pro.
3. **Patch the unguarded staleness surfaces** to read `Pipeline_Stage` /
   the generalized `isUnderContract` (`lib/actionQueue.ts:178`,
   `app/api/morning-briefing/route.ts:196`).
4. **Derive/backfill** `Pipeline_Stage` from the tangle — a pure mapping
   fn, **dry-run first, operator-reviewed**, separate authorized step.
5. **Migrate consumers + Make scenarios per scenario**, retiring each
   Make scenario as replaced. `Outreach_Status` retires last.

---

## 8. Open follow-ups (flagged, not in scope here)

- **Spine MCP connector** was pinned to the `claude-fix-token-b`
  preview alias, not prod — deployment-pinning class. Re-pointed to
  `https://coach-pulse-ten.vercel.app/api/maverick/mcp` this cycle.
- `MLS_Status` dirty data (`Active` vs `ACTIVE`) — dedup during backfill.
- `Approved_For_Outreach` has no writer — decide retire vs. wire to the
  Pre-Send gate when step 3 lands.
