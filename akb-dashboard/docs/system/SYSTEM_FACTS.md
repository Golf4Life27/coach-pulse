# System Facts — Wholesale OS

**Status:** authoritative. **Owner:** Alex Balog (operator).
**Updated:** 2026-09-25.

## 0. WHOLESALE OS CHARTER v1 (operator-locked 2026-09-25)

Read this before anything else in this file. It outranks every section
below, every spine row, every plan, and every prompt. A session that
cannot name the charter line its work moves does not do that work; it
adds the idea to the Not-Now list in `docs/PLAN.md` and moves on.

**Why this exists.** Wholesale OS is a family income machine. It exists
so Alex's wife can stay home and raise their kids. Alex keeps his day
job for now. This is the Kirsten date gate, made concrete.

**Finish line.** $30,000 a month take-home from assignment fees by
2027-12-31. Milestones, in order: first assignment fee; 3+ fees; a fee
every month; $30K a month.

**Operator hours (staged, by milestone).**

| Stage | Alex's time |
|---|---|
| Until the first fee | whatever it takes |
| After the first fee | up to 15 hours a week |
| After 3+ fees | about 5 hours a week |
| Once fees repeat monthly | as close to zero as the work allows |

**Always Alex's:** signing, moving money, setting direction.

**Operator surface (added 2026-09-25, operator verbatim: "I would really
like to be able to spend the vast majority of my (diminishing) working
time in the dashboard for wholesale, rather than bouncing between 3
different claude sessions and endless different screens").** The
Wholesale dashboard (prod, home queue) is where Alex works. Every ask
for him becomes a card there with a default and a deadline. Chat with
the lead session is for setting direction, not for running the
business. Anything that makes Alex open a Claude session, a console, or
a second screen to keep deals moving is a finding against this line.

**Not Alex's:** agent and seller phone calls. A closer paid per deal
takes them, inside limits Alex sets in writing. Until a closer exists,
calls are scheduled into one short daily window and Alex is briefed
before each; every call the system cannot avoid is logged as a finding
against this line.

**How it earns.**
- On-market listings AND off-market sellers, in parallel, starting now.
  Neither lane waits for the other's revenue.
- A few focus metros until fees repeat, then expand. Focus metros are
  named in `docs/PLAN.md`; adding one is an operator decision.
- Volume of negotiations, not perfect deals (Wholesale OS Canon,
  2026-03-11).

**Hard stops (a session that would cross one stops and surfaces it).**
1. Wholesale OS never becomes a second job for Alex. Anything that needs
   him daily without a written automation plan and date is rejected
   (Automation Discipline Contract Rule 1, 2026-05-22).
2. Wholesale OS never takes on legal or reputation risk: TCPA, state
   wholesaling law, or Alex's name with agents and sellers.

**Spend.** Claude runs on the $200/month Max plan; its binding limit is
the weekly allowance, not dollars. Everything else (data, texting,
tools, vendors) stays at or under $2,000 a month until the first fee,
with an alert at $1,500. This supersedes the agenda's $3,000 cap (D7).

**Names.** The system is **Wholesale OS**. The orchestrator is
**Maverick**. The contracting entity is **AKB Solutions LLC** (and/or
assigns). CONVEYOR, AKB Inevitable, Jarvis and AKB Launch OS are retired
names; sessions do not introduce new ones.

**Scope gate and priority order.** Before any build, session or routine
change, name the charter line it moves. When two pieces of work compete,
this order wins:
1. The deal closest to a fee.
2. Whatever blocks a signature or a funded buyer.
3. Whatever takes Alex out of the loop.
4. Everything else.

**What this charter retires.** (a) Off-market waiting on $40K/mo x 3
months (§9 Crawler 2.0 unlock): retired; off-market runs now. (b)
"National, not Detroit": retired until fees repeat. (c) "The operator
closes each deal by hand" (June business plan): retired; a closer does.
(d) "Make it sellable" as a current goal: retired; it may return after
the finish line. (e) The Inevitable Constitution v3: superseded by this
charter; its detailed rules apply only where they do not conflict.

**Vision-session brief format.** Each system's lead reads its own
six-line brief: what it is; who pays and for what; the 12-month number;
what stays Alex's; the kill-or-reshape rule with a date; out of scope.
This charter is Wholesale's.

---

**Spine:** paired build_event `recpLB1yC1SaDTqff` (A1 commit cycle, 2026-05-31);
sold-comp routing facts paired with the ATTOM-promotion build_event
`recZB4GZGZ2rPwWe9` and the Cuyahoga build_event of 2026-07-20.

This is the canonical record of the load-bearing facts about Wholesale
OS (formerly AKB Inevitable). Every Claude session reads it first via
`maverick_load_state`. If anything in code, AGENTS.md, a comment, a
prior commit message, or a recalled Spine row contradicts a fact
here, **this file wins** — and the contradicting surface is the bug.

The file exists because the same handful of facts have been
re-derived (often incorrectly) across multiple sessions, costing
build time. The Vercel plan question alone has burned sessions
twice. A single authoritative record closes that loop.

Changes to this file are themselves a `build_event` on Spine. Append
the new fact, supersede the old line in place with a strikethrough
(don't delete history), and pair the commit per Rule 9.

---

## 1. Hosting + deployment

| Fact | Value |
|------|-------|
| Vercel plan | **Pro** |
| Vercel team | `team_zwFAlAQ8CyjGYcxyk7Sn6ww0` |
| Vercel project | `prj_X1pCuqzRml74iOKfNhTo4ZMG9K87` |
| Production target | `main` branch, server-side `target=production&state=READY` query |
| Default branch | `main` |

**Cron capacity:** Pro plan supports sub-daily crons. Earlier
`AGENTS.md` text describing "Hobby plan — once per day maximum" is
**stale and incorrect** (predates the upgrade). If sub-daily granularity
is genuinely needed, build it; do not architect around a Hobby cap
that does not exist. Update `AGENTS.md` to match in the next touch.

**Lambda ceilings (Pro):** `maxDuration` defaults 60s, ceiling 300s. Set
explicitly per route via `export const maxDuration = N;`.

## 2. Source of truth — repo

| Fact | Value |
|------|-------|
| Repo | `Golf4Life27/coach-pulse` |
| App subdir | `akb-dashboard/` |
| Default branch | `main` |
| Active feature branches | `claude/*` per session |

Maverick's git source (`lib/maverick/sources/git.ts`) defaults to
`main`; the dead `claude/build-akb-inevitable-week1-uG6xD` default has
been removed (2026-05-28, Spine `recwkHvBMTjeMLECp` — deploy-truth +
git-source-truth sibling fixes).

## 3. Continuity Layer (Maverick)

| Fact | Value |
|------|-------|
| Spec | Inevitable Continuity Layer v1.1 (amendment 6.4 for write attribution) |
| Load-state endpoint | `/api/maverick/load-state` (Vercel) |
| MCP server | `maverick_load_state`, `maverick_write_state`, `maverick_recall` |
| Briefing cache | 90s fresh / 5min stale-while-revalidate, in-process per warm lambda |
| Briefing budget | P95 ≤ 30s (parallel fetch ~3.5s floor + ≤ 30s synthesis ceiling) |
| Synthesis timeout | 30s (`DEFAULT_TIMEOUT_MS` in `lib/maverick/synthesize.ts`) |

**Discipline:** every commit that ships code is paired with a
`maverick_write_state` call (Phase 20.7 lesson). Spine write rate
dropping to zero is a regression, not a quiet day.

## 4. Airtable

| Surface | ID |
|---------|----|
| Base | `appp8inLAGTg4qpEZ` |
| Listings_V1 | `tbldMjKBgPiq45Jjs` |
| Spine_Decision_Log | `tblbp91DB5szxsJpT` |
| Property_Intel | `tbllf0GNjYepvnUuv` (INV-022 v1) |
| Buyers | `tbl4Rr07vq0mTftZB` |
| D3 Manual Fix Queue | `tblV6OkNPDzOo6ubp` |
| ZIP_Registry | created on this branch (D1) — see `docs/specs/AKB_MASTER_CHECKLIST.md` |

**Field-id rule:** when a brief and the codebase disagree on a field
ID, the codebase wins (proven 5/26 cleanup commit). Add a row to
this file recording the canonical mapping if it has ever drifted.

**Two-map rule (2026-07-14, Mayfield counter miss):** `lib/airtable.ts`
holds TWO Listing field maps — `LISTING_FIELDS` (fld-ID keyed; used by the
BULK readers `getListings`/`getActiveListingsForBrief`, i.e. every cron)
and `LISTING_NAME_MAP` (name keyed; used by single-record `getListing`).
A field added to only one map is silently NULL on the other read path.
This has bitten twice (P1.1 `Rough_Opener_Amount`; 2026-07-14 the whole
decision-math set + `Draft_Reply_Text/Meta` + `DD_Volley_State`, which
dropped Mayfield's $27k counter from the backfill compute). **Every new
Listing field goes in BOTH maps**; `lib/airtable-map-parity.test.ts`
enforces parity for the machine-managed set — extend its list with each
new field.

## 5. External services

| Service | Identity |
|---------|----------|
| Anthropic API key (production) | Vercel env, distinct from Make.com's key (rotated 2026-05-18) |
| Quo outreach send line (Crier, agent-facing) | `+18155569965` / `PNLosBI6fh` (carrier registered; the 815 number) |
| Quo Maverick alert line (operator-facing, FROM) | `+16302505865` / `PNMhSUQXFw` — `ALERT_FROM`. Maverick→Alex sends only; never the 815 outreach line (channel separation) |
| Operator personal cell (urgent escalation, TO) | `+16302172539` — Alex's cell, NOT a Quo number. `MAVERICK_STAGE4_SMS_TARGET` default. The "system found a deal, act ASAP" reach path |
| RentCast | monthly cap 1,000 calls, resets 1st of month UTC. **24h call ceiling is a TRAILING window**, not a midnight-UTC reset |
| ATTOM | `ATTOM_API_KEY` in Vercel env (operator's own key). Behind the paid-call loop-breaker (`attom_loop_tripped`) and counted in the engaged lane's 24h ceiling |
| Firecrawl | Standard tier, 50 concurrent browsers, `FIRECRAWL_MAX_CONCURRENT=20` default |
| DocuSign | JWT path (Path A); MCP path is Claude-side, unreachable from Vercel |

**Sold-comp routing (PR #140, 2026-07-20, epoch `2026-07-20T01:10:00Z`):**
`lib/comps/sold-comps.ts` is the ONE faucet. County deed ledger where a
PROMOTED registry source exists (Detroit — honest zero FINAL) → ATTOM
`/sale/snapshot` (primary elsewhere; registry infra-failure fallback;
honest zero FINAL; sub-$10k mapping floor) → RentCast property records
(last resort on thrown ATTOM errors only, audited). Promotion per market
is an operator ruling on benchmark receipts (`/api/admin/comp-benchmark`).

**County registry freshness (why promotion is per-market):** Detroit
assessor feed = deed transfers ~3 days old (registry-primary). Cuyahoga
Fiscal GIS Hub "Parcel Sales 2021 to Present" = **~11 weeks stale**
(verified 2026-07-20: newest sale 2026-04-30, last data edit 2026-06-09,
~quarterly cadence) — built as `promoted: false`, benchmark lane only;
Cleveland production stays ATTOM-primary pending operator ruling. Its
rows DO carry sqft/beds/baths/year-built (richer than Detroit's ledger),
and `MIN_AGE` actually holds YEAR BUILT. WAR deeds only: LIM rows carry
per-parcel-stamped bulk portfolio prices (observed $4,315,716 × 3 parcels,
2026-04-27).

**DocuSign provisioning status:** envelope routes exist (Phase 5
Scribe) but await JWT credentials in operator's DocuSign Admin
Console (Phase 12.7 — operator-external STOP).

## 6. Model + voice registry

| Fact | Value |
|------|-------|
| Voice registry | `lib/maverick/voice-registry.ts` (13 agents) |
| Briefing model | per registry entry — drift detected via Pulse `voice_drift` detector |
| Synthesizer entry point | `lib/maverick/synthesizer.ts` — every Anthropic call routes here |
| Prompt cache | `cache_control: ephemeral` on system prompts for repeated session-opens |

**Refusal discipline:** the synthesizer paraphrases the structured
briefing; it must never invent counts, addresses, SHAs, dates, dollar
amounts, principle IDs. The template fallback (`renderTemplate`) is
both the safety net (timeout / error) and the ground-truth input the
synthesizer paraphrases against. System Facts here are inputs to that
same ground truth.

## 6a. Model tiers — STANDING RULE (operator ruling 2026-09-21)

Think on the judgment tier, execute on lower tiers. Recorded after a
usage audit on 2026-09-21: of $13,390 across the 40 most recent sessions,
$9,267 ran on the judgment tier, and one judgment-tier session with an
hourly self-re-arming check-in bound to it burned $7,296 in 48 hours.

| Tier | Use it for | Never for |
|------|-----------|-----------|
| **Judgment tier** (the top model; the operator's HQ chat) | rulings, stress tests, design of a build, reading a diff before merge, anything the operator would want the sharpest read on | routines, check-ins, `send_later` re-arms, audit reads, triage, engine drives, buyers builds, workers |
| **Execution tier** (the standard model; MAVERICK 1, 2, 6 hosts) | every scheduled or repetitive job; persistent routine hosts; PR babysitting | operator rulings |
| **Worker tier** (the fast model) | builds from an HQ brief, log parsing, bulk reads, tests | anything that produces a number for a counterparty |

Rules:

1. A routine or `send_later` is never bound to a judgment-tier session.
   Bind it to an execution-tier host (`WS · Routines · MAVERICK 6 · Ops check-ins` (renamed 2026-09-25) is
   the shared host for HQ's check-ins) with a standalone prompt.
2. Every firing into a persistent session re-pays that session's whole
   context. Keep routine hosts light: load state, do the work, write
   back, stop. An hourly self-re-arm on any long-lived session is a red
   flag; use a cron routine with a bounded tool budget instead.
3. HQ delegates builds to worker-tier subagents from a brief, then
   reviews the diff. HQ does not run audit sweeps itself when a routine
   host can.
4. Model identifiers stay out of code, commits and PRs; name the tier.
   The tier-to-model mapping lives in the Routines list and the Spine
   (ruling row of 2026-09-21).

## 7. Named-agent roster

The system speaks in named agents:

- **Sentinel** — intake
- **Appraiser** — valuation (ARV / rehab / buyer intelligence)
- **Forge** — drafting (offers, EMD)
- **Crier** — SMS dispatch + cadence
- **Sentry** — gate enforcement
- **Scribe** — contracts (DocuSign)
- **Scout** — buyer pipeline
- **Pulse** — system health + drift detection
- **Ledger** — economics
- **Maverick** — orchestrator (this layer)

## 8. Decision Preconstraints (Constitution Rule 3 — autonomy lanes)

- **Type 1** (autonomous): system computes, system writes, system
  surfaces. No operator click. Data hydration, math, federation,
  classification.
- **Type 2A** (queued for approval): drafted outbound messages,
  status flips that touch counterparties. Operator clicks Send.
- **Type 2B** (operator-only, forever): DocuSign signing, EMD wire,
  contract execution. Hardcoded operator-click — no autonomy ever.
- **Type 2C** (judgment): structural failures, material discrepancies,
  counter-offers, anything where refusal is the correct verb.

When in doubt, **refuse and surface** is the lane.

### Operational vs. decisional work — STANDING RULE (2026-06-01)

Operational, execution, and diagnostic work belongs to Code, not Alex.
That includes:

- **Hitting endpoints** (curl, POST/GET requests, dry-runs, applies).
- **Console commands** (browser devtools, `fetch()` from a logged-in tab).
- **Retries** after a transient failure (a 500-by-timeout, a 401 on a
  stale cookie, an Airtable rate-limit, a GitHub Actions hiccup).
- **Reading logs + diagnosing failures** (Vercel build/runtime logs,
  audit log entries, GitHub Actions step output).
- **Re-pointing connectors, re-authing, re-deploying** the build
  container's own MCP / tooling state.

Code's job is to find or build the path so it can self-drive the work
without paste-the-secret-in-chat or copy-the-cookie ergonomics. The
sweep route + GitHub Actions trigger (2026-06-01, decision §1's
companion) is the canonical pattern: server-side execution gated by
Vercel-side env secrets, Code triggers via GitHub Actions, no operator
touches a console.

Alex's job is to:

- **Approve decisions** (locked-and-loaded calls, scope changes,
  irreversible commits).
- **Perform Type 2B actions personally** (DocuSign signing, EMD wire,
  contract execution — anything where a human signature or money move
  is on the line; Constitution Rule 3 §8 above is the canon).
- **Re-point integrations only when Code cannot** (MCP connector URLs
  that live in operator-account integration-settings; one-time secret
  installs into GitHub repo secrets or Vercel env).

If Code is about to ask the operator to run a curl, hit a URL in their
browser, or paste a secret — stop, find the server-side path, build it
if it doesn't exist, and run it from there. Asking the operator to
operate is the default-failure mode this rule exists to prevent.

## 9. Mission constants

These do not change without a Bible amendment.

| Anchor | Value |
|--------|-------|
| **Wholesale fee — current floor (on-market)** | **$5K/deal** (operationally locked 2026-06-03, Spine `rec937cFJthvCZzBM` / reconciliation `rec6e6hYLuOpaLANf`; `DEFAULT_WHOLESALE_FEE` in `lib/pre-contract-math.ts`) |
| Wholesale fee — efficiency target | **$10K+** as build efficiency grows (operational lift, not a Bible change) |
| Wholesale fee — off-market / tax-delinquent / land | **materially higher** than the on-market default (deal-type-specific; quantify when those crawler sources land live) |
| Contract MAO discipline | Two lanes, both → `Your_MAO_V21`. **Flipper:** 70% rule — `ARV×0.70 − rehab − closing(1.5%) − fee` (`lib/pricing/mao-flip.ts`, no list-price input). **Landlord:** cap-rate V2.1 — `(rent − taxes) ÷ cap`. (Was "65% ARV − rehab − fee"; corrected 2026-06-28.) |
| Buyer cap rates | TX 8% / TN 10% / MI 9% / Default 9% (env-overridable) |
| ~~Cadence~~ | ~~door-opener is **value-anchored** (`ARV $/sqft × sqft × buy-box − rehab − fee`) **or HOLDS for review** — never a fraction of list (65%-of-list retired 2026-06-28 after the Blackmoor $84.5k over-offer; INVARIANTS §2).~~ Superseded 2026-08-30 by the two-stage doctrine below. |
| Cadence (2026-08-30, Spine rec8eZG5hH16FFyF2) | **Two-stage pricing.** First-contact cash openers are **62% × list, phrased soft** (`list_anchor_soft_v1`). From the first reply onward the value-anchored formula is the only producer and the two-lane MAO is the negotiation ceiling; every guard HOLDs instead of improvising. Full doctrine: `.claude/skills/pricing-doctrine/SKILL.md`. Price-drop = re-engagement (not first contact) — INV-030 |
| ~~Crawler 2.0 unlock~~ | ~~$40K/mo net × 3 consecutive months (Bible §1.2)~~ Retired by Charter §0 (2026-09-25): off-market runs in parallel now. |
| Dream Phase unlock | ~~operator hours < 15h/wk~~ Superseded by the Charter §0 hours table (2026-09-25): 15h/wk after the first fee, ~5h/wk after 3+ fees, near zero once fees repeat. |

### Pricing-doctrine enforcement constants (operator-blessed 2026-07-06; ruling `recmy2Vwp1wMA1Vs8`, skill v1.0 `recYoZ85w9mnC0tlE`)

| Constant | Value |
|----------|-------|
| **Recompute tolerance** (pricing-doctrine standard 1) | **±$5 absolute.** Recompute-vs-field mismatch beyond this → HOLD + surface. Basis: every pricer rounding site is whole-dollar (`lib/rough-opener-ceiling.ts:95-96` `Math.round`; `lib/per-market-pricer.ts:288` `Math.floor`), bounding arithmetic jitter at ~$2, while the smallest real drift class (seed $/sqft ±$1) moves an opener by $100s. Absolute, not %, so small-market numbers stay tightly guarded. |
| **Vision-confidence cutline** (pricing-doctrine method 5) | **conf ≥ 60 prices autonomously; conf < 60 → `hold_low_confidence`.** Scoped to vision-dependent lanes (contract-MAO rehab refinement); openers continue on the deterministic tier rehab, and the cure for a hold is the DD walkthrough doctrine already requires. Basis: calibration sample 2026-07-06 (10 of 75 read-bearing records, 14 reads): scores quantize at 42/52/62; every sub-60 read is exterior-only assumption-stacking; the only observed re-read instability (4838 Wisteria: 42↔52 alternating, rehab_mid $27,375↔$40,150 — 47% swing on identical inputs) sits entirely below 60. Revisit when ≥30 scored reads exist above 60. |

**Eventual:** `Wholesale_Fee` should become **deal-type-aware**, not a single
hardcoded default. Source-of-truth shape will be a per-listing field or a
lookup keyed on `(deal_source, market_tier, distress_grade)`, with the V1
$5K default as the on-market fallback. Wired into the math gate's
`evaluatePreContractMath(inputs)` via `inputs.wholesaleFee` — the helper
already accepts a per-call override, so adding the field is a read-path
change at the gate, not a math-layer rebuild.

Legacy `lib/appraiser/mao-range.ts:DEFAULT_WHOLESALE_FEE` still carries
the original Bible $15K default — flagged for reconciliation when that
module is next touched.

## 10. What this file is not

- Not a `CLAUDE.md`. Sub-directory `CLAUDE.md` files give per-area
  instructions. This is system identity.
- Not a checklist. The master checklist tracks build state.
- Not a Spine row. Spine records decisions over time; this records
  the steady facts those decisions sit on.
- Not exhaustive. Add a row when a fact has been re-derived
  (correctly or incorrectly) in more than one session. Don't bloat
  with facts a session can trivially read off the codebase.
