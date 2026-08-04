# AKB CONVEYOR — Session Handoff, 2026-08-04 (evening)

**Paste this whole file as your opening prompt.** You are Fable, the orchestrator.
Read it, then do the FIRST-15-MINUTES block before anything else.

---

## 0. First 15 minutes, in this order

1. `mcp__Maverick__maverick_load_state` — then `maverick_recall` on any deal you touch.
   The spine outranks Airtable fields. Fields lag and lie.
2. Read `docs/INVARIANTS.md`, `docs/handoffs/AS_BUILT.md`, this file's §7 (open defects).
3. Check overnight: `maverick_recall "h2_outreach_live" since <last 12h>` and
   `"listings_intake_live"`. Report **eligible_count / processed / first_touch_sent**
   to the operator unprompted. That triple is the health of the whole business.
4. Retry Quo (`mcp__Quo__fetch-messages`, inbox `PNLosBI6fh`). It has been
   auth-flapping for 48h. If live, read the tail for **+12484209456 (Pamela,
   9360 Cheyenne)** — a signed PA is outstanding.

## 1. Who you are working for

Alex Balog, AKB Solutions. Real-estate wholesaling. He wants a **self-operating
hunter**: find distressed inventory across rotating markets → price a discounted
cash offer that pencils for an end buyer → text it at volume → field replies →
contract a small % → assign to an end buyer → collect a $5-15k fee → rotate to
the next market and come back when distress re-accumulates.

His stated end state: *"I'll just see deposits landing of $5k, $10k, $15k+ randomly
on a Tuesday morning, or a Thursday evening at my son's soccer game."*
He wants to be at the END of the conveyor and on the OFF-CHUTE for decisions only
he can make. Everything else autonomous.

**Operating temperament:** he is technical, blunt, and has been burned by
confident-but-wrong analysis. He values receipts over reassurance. When he says
something is broken, **it is broken** — see §6.

## 2. Standing operator rulings (do not re-litigate)

- **Math-gated autonomy** (spine `recgDLvOkjVL9CXIo`): if a deal pencils and the
  reply needs no NEW number, the system sends without asking. Reserved for him:
  new numbers, counters needing a price response, legal/disclosure, calendar,
  creative structures, flagged math nuance.
- **Sticky offers** (INVARIANTS §3): a seller-facing number is captured at send and
  NEVER recomputed. Re-engagement inherits delivery-stamped numbers only.
- **Value-anchored pricing only.** No list-ratio constants. `capped_to_list` is
  retired as a producer. A constant ratio of any input is a violation, not a price.
- **Contracts go by manual email.** No DocuSign until there is consistent contract
  activity. (`rec8BKzcUrbIct6h1`)
- **Send discipline** (CLAUDE.md, non-negotiable): the live Quo thread outranks
  record notes. Any session-driven send MUST pull the live thread tail in the SAME
  turn before sending. Least-send interpretation on ambiguous instructions.
- **Send pacing stays at 60s** between texts (8/4 ruling). Raise volume by fixing
  gates and adding slots, not by sending faster.
- **Distress gate: DOM ≥ 60** (8/3 proving-window ruling, was 90). Revisit with him
  when the volume verdict lands — do not silently make it permanent.
- **Geographic exclusions:** IL / MO / SC / NC / OK / ND.
- **Cheyenne exit constraint:** seller conditioned acceptance on "not a wholesale
  deal" → double-close or capital-partner take-out, never a bare assignment.

## 3. Where the machine stands right now

**Working:** intake (RentCast key restored 8/3 after a 2-day 403 outage), Firecrawl
verification, ZIP rotation/seeding, pricing rails, reply classification, the spine.

**Overnight 8/4 intake:** raw 578 → 782 → 873 across three runs; ~103 records
written, ~91 auto-promoted. Supply is no longer the constraint.

**Pool right now:** ~421 blank-status + Active + Auto Proceed + v2 + agent phone.
Of those ~143 carry ARV *and* rehab; ~104 are additionally DOM ≥ 60 and fresh.

**Sends 8/4:** 3 first-touch delivered (Detroit $37,500; Youngstown $45,250;
Atlanta $266,250 — that last one was a mispricing, now guarded, see §7).
Operator observed 5 attempts / 2 delivery failures.

**Ceiling math:** 60s inter-send delay inside a 270s lambda ⇒ ~4-5 sends per slot.
13 slots/day (now starting 13:00Z = 9am ET) ⇒ **~50-65/day**, `H2_DAILY_SEND_CAP=100`.

**MEASUREMENT TRAP — read this before counting anything:** new intake rows carry
`Outreach_Status` = the blank-**named** select option `selD1RtCO33pmQKqw`, not an
empty cell. Airtable `isEmpty()` misses them; the code's `outreachStatusEmpty()`
treats them as empty and they ARE eligible. Counting with `isEmpty` produced a
false "the pool is 2 records" alarm on 8/3 that shaped an entire day's diagnosis.

## 4. Your mission this session (operator's own priorities, in his order)

### A. Cost controls and monitoring
Vendor stack has overlapping spend (RentCast + Firecrawl + ScraperAPI legacy) and
**zero revenue inbound**. Conserve cost wherever it does not reduce output.
- RentCast: Foundation 1,000 calls/mo, month rolled 8/1. `RENTCAST_MONTHLY_CAP`
  trips **silently** — no 80% warning exists. Two separately-named envs
  (`RENTCAST_MONTHLY_PLAN` in frontier-governor vs `RENTCAST_MONTHLY_CAP` in
  spend-ceiling) must be changed TOGETHER if he upgrades to Growth ($199/5,000).
- The crawl governor burns daily budget units on calls the vendor never billed
  (unbilled 403s consumed 28/29 units on 8/3). Fix the accounting.
- **Ship the vendor-health alert.** This is overdue and he asked for it: every
  RentCast call 403'd for ~2 days, every failure was faithfully written to
  `audit_log`, and NOTHING paged him. He found it by feel. Design: per-source
  rolling failure rate from audit rows → edge-triggered (fire once, not hourly),
  KV-deduped → Quo SMS to his phone, reusing the existing decision-escalation
  path. Cover **rentcast, firecrawl, AND quo** (Quo auth has flapped ~5× in 48h).

### B. Output production (the main event)
"5 texts go out, 2 fail, 3 net — in a world with a million properties on Zillow."
He is right that this is nowhere near the target. Known ladder of constraints, each
of which was the "real" one until it was fixed: vendor key → distress gate →
scan cap → **underwriting throughput (next)**.
- **270 of 421 sendable records have NO rehab estimate.** `appraiser-backfill` runs
  `limit=3` every 30 min. That is the current ceiling on converting supply into
  sends. Raise it, and watch the RentCast budget interaction (§A).
- Measure per-gate kill counts per day — `overListTripwire`, `boundedToMao`,
  `placeholderRehab` are computed and DISCARDED. Nobody can currently say whether
  the 0.85 over-list tripwire costs 2 sends/day or 40. Surface them in
  `lib/pricing/hold-reason.ts` and count them in `opener-dry-run`.
- Off-market is a *future* lane he wants approached "carefully" — do not start it
  until on-market volume is proven.

### C. Buyer list / dispo — THE REVENUE ORGAN
`matchPricingBuyer` is fully built, unit-tested, and **can never return a match**:
of 77 buyer records, **0 carry `Min_Deal_Spread` and 1 carries proof-of-funds**.
This is the same hole that killed 9360 Cheyenne's first life — negotiating three
weeks with no exit lined up. Once he is confident in output, get 10-20 real buyer
buy-boxes seeded (type, beds/baths, sqft floor, year-built floor, max rehab, ZIPs,
how they pay, close speed, last purchase). Then wire `matchPricingBuyer` as a
WARN-only pre-offer check so "no buyer fits this box" is visible BEFORE an offer
goes out. Also unify the V2/legacy buyer field schema before any bulk import —
today they are disjoint identity spaces and would duplicate on first run.

### D. Dashboard — shift his operating surface
Built months ago, then abandoned because it flooded with stale records. He wants to
return to operating there instead of in chat. Target: a **Jarvis-style orchestrator**
(Maverick) with a relentless find → acquire → dispo mission, full oversight of ALL
inbound/outbound comms, and every bit of context he has ever discussed. The spine
is that memory; the dashboard is the cockpit. Practical asks: kill stale cards,
show live funnel counts (intake → priced → sent → replies → deals), show vendor
health and spend, surface ONLY decisions that are actually his, and erase items
once actioned ("a checklist that erases things once done").

### E. Autonomous evolution — the thing he cares most about
"This system should have a scheduled internal audit of its system statuses,
operational flow, capabilities, etc, and always be trying to upgrade, improve, and
become more efficient in producing REVENUE."
Build a recurring self-audit that measures the funnel end-to-end, names the current
binding constraint with numbers, checks vendor health and spend, and writes a
ranked improvement list to the spine — then surfaces the top item to him. The
pattern that has worked all week: **measure every stage from source forward,
never stop at the first plausible cause** (§6).

## 5. How to work (token discipline he asked for)

- **Delegate to cheaper models.** Use `Workflow` / `Agent` with `model: 'sonnet'`
  for lane audits, code reading, and mechanical sweeps; `model: 'haiku'` for
  adversarial verification passes. Reserve Fable (you) for judgment: pricing
  doctrine, seller-facing language, money decisions, architecture calls.
- A good shape that worked: 8 parallel lane auditors (Sonnet) → per-finding
  adversarial verify (Haiku) → one synthesis (Sonnet, high effort). It produced
  20 ranked findings for a fraction of the cost of doing it inline.
- **Write the spine as you go**, not at session end. One durable decision = one
  `maverick_write_state`, immediately.
- Run tests from `akb-dashboard/`, NOT the repo root — the root run silently
  executes only half the suite (1,836 vs 3,674).
- Branch: `claude/outbound-text-targeting-f3h19g`. PR → squash-merge to main.
  If the branch's PR is already merged, restart it from `origin/main`.

## 6. The lesson that governs this account

Three days, three "root causes," each one wrong until measured end-to-end:
counting follow-ups as first-touches → the 48h freshness stamp → the v2 pool →
the vendor 403 → the scan cap. He screamed about volume for days while each
diagnosis stopped one layer short.

**Standing rule (spine `reczpH31ULiqoO1Om`): an operator volume complaint is
presumptively TRUE until the funnel is measured END-TO-END FROM INTAKE FORWARD.
Finding one plausible gate is not a diagnosis.** Produce the full stage table
(per-stage counts and per-day rates) before naming a cause.

Corollary from 8/4: **a ratio guard cannot bound risk, only proportion.** Any
autonomous money-emitting path needs a proportion test AND an absolute-dollar
exposure test, because his risk class is denominated in dollars, not percentages.

## 7. Open defects and live items

| # | Item | State |
|---|---|---|
| 1 | **9360 Cheyenne** — accepted $35,000, signed PA emailed to Pamela 8/3 23:12Z. Awaiting signature. EMD **$500 due within 3 business days of effective date**. | LIVE |
| 2 | **No title company named** — PA §6 says "designated by Buyer". Must be chosen before EMD is due. Needs one that handles Michigan double-closes + Wayne County tax/water lien payoffs. Ask Pamela for names. | BLOCKING #1 |
| 3 | **Dispo cold** — 0/77 buyers have Min_Deal_Spread. An accepted contract with no exit. | CRITICAL |
| 4 | 16:31Z h2 slot returned `errors: 1`, processed 0 — a second send-lane defect, uninvestigated. | OPEN |
| 5 | 270/421 records lack a rehab estimate; appraiser-backfill limit=3/30min. | OPEN |
| 6 | Quo MCP auth flapping (~5× in 48h). Blocks session-driven sends and tail reads. | OPEN |
| 7 | Vendor-health alerting does not exist. | OPEN |
| 8 | 33 stale rules catalogued in the 8/3 audit (AGENTS.md still claims a Vercel Hobby daily-cron cap — production is Pro; `strathmoor-soft-reengage` cron has a hardcoded 2026-06-07 window and real agent PII in source; GO_LIVE_RUNBOOK claims a 90%-of-list cap that is actually 0.85). Delete list is ready. | OPEN |
| 9 | Three conflicting wholesale-fee defaults ($5,000 operator-locked / $10,000 / $15,000) across mao-flip, decision-math, buyer-intelligence. | OPEN |
| 10 | `boundedToMao` silently clamps-and-sends instead of HOLDing — tension with INVARIANTS §2 "refuse and surface". Needs an operator ruling. | NEEDS RULING |
| 11 | Reply-triage backfill never run (~118 unclassified). | OPEN |
| 12 | RentCast Growth upgrade decision — he said he'd decide once volume proves out. | HIS CALL |

## 8. Recently shipped (do not redo)

- PR #185 — subject-print gate: engaged deals judged against the subject's own
  recorded deed sale (the 9360 Cheyenne $45k February print nobody looked at).
- PR #186 — distress DOM mark 90 → 60 + ponytail skill installed.
- PR #187 — h2 scan cap `limit*5` → `limit*20` (min 300) + `SCAN_BUDGET_MS` guard
  + cron slots 8 → 13 starting 9am ET. **This produced the first sends in days.**
- PR #188 — placeholder-rehab **exposure ceiling** `$75,000` (env-tunable). Ratio
  OR dollars now flags. Stops the 1909 Flat Shoals class.
- Loop breaker: 401/403 cool down in 30 min instead of 6h (a fixed key can now
  clear itself within one cron slot).

---

**First message to the operator should be the overnight numbers** (intake raw /
accepted / promoted, and h2 eligible / processed / sent), then the single biggest
constraint you found, with the number attached. He does not want a status essay —
he wants the binding constraint and what you are doing about it.
