# AKB Wholesaling — Version 1 Business Plan & Revenue Model

> **Date:** 2026-06-28 · **Author:** drafted with Claude Code, operator-reviewed.
> **Framing:** written to be defensible to a skeptical outside reader (the "city
> council" test) — assumptions shown, numbers sourced, ranges not single
> figures, and the hype explicitly flagged and discarded. Every revenue tier
> states what it assumes and what would break it.
>
> **The one-line honest summary:** the machine is ~90% built and deliberately
> switched off; the math that blocked it is now fixed; the real ceilings are
> **not** technical — they are (1) **outreach compliance / carrier caps** and
> (2) **the operator's personal deal-closing capacity**. Plan around those two
> and this is a real $150K–$700K/yr solo business, with a credible (team-based)
> path beyond.

---

## 1. Executive summary

- **Build status:** the end-to-end pipeline (find → verify → price → qualify →
  text → triage replies → underwrite → hand off) is **built and running in
  dry/dark mode**. Sends are behind a deliberate kill-switch (added after a
  2026-06-05 accidental-send incident). "Starting" = a metered, careful
  **go-live**, not finishing construction.
- **The blocker we just removed:** offers were anchored to the seller's *list
  price* (a $84.5k text on a ~$40k house). That is fixed — offers are now
  value-anchored or the record HOLDs. (PR #46, awaiting merge.)
- **What it can make (Detroit-Michigan, sourced):**
  - **Operator's stated milestone — $30K/month** (~2–6 deals/mo by fee mix):
    replaces both incomes + the stress. *Gated by going live + the first deals,
    NOT by the operator's capacity.*
  - **Structural ceiling with the automation as the team** (the right benchmark —
    a *teamed* op, not a manual solo): **~15–30 deals/mo**, well past $30K/mo,
    once per-deal human time is minimized. Binding variable = the operator's
    irreducible minutes per deal (unmeasured until the first close — §7b).
  - **"Unlimited" (the end goal):** large and expandable (more markets + scaled
    compliant outreach + fully-removed per-deal touch). Real ceilings exist
    (market size, compliance, irreducible decisions) but are high enough that a
    fixed target is, as the operator put it, beside the point.
- **The two hard truths** (Section 7): outreach is legally and technically
  capped (TCPA + carrier 10DLC rules), and the operator's per-deal time sets a
  **climbing** throughput ceiling (§7b — *not* the manual-solo 4–8; the
  automation is the team). Both are manageable; neither is optional to plan for.
- **The single biggest revenue lever** (Section 8): **off-market / public-records
  acquisition.** It roughly *doubles the fee per deal* ($5–10K → $15–20K) and
  runs on **free county data** the existing engine can ingest.

---

## 2. Where we stand — built, not on

The pipeline exists in code and runs; almost everything is gated dark on
purpose. (Source: `docs/handoffs/AS_BUILT.md`, verified 2026-06-28.)

| Pipeline stage | Built? | State today | Gate |
|---|---|---|---|
| Find deals (crawler) | ✅ | Dry-run | `CRAWLER_INTAKE_LIVE` off |
| Value each ZIP ($/sqft seed) | ✅ | Off → openers blank | `CRAWLER_AUTOSEED_LIVE` off |
| Price the offer (the math) | ✅ **+ just fixed** | In PR #46 | awaiting merge |
| Qualify (5-gate spine) | ✅ | Runs | — |
| **First text to seller** | ✅ | **HARD-DISABLED** | `H2_OUTREACH_HARD_DISABLE` — the master kill-switch |
| Metered send-cap | ✅ | Fail-closed (0 sends) | `H2_COVERED_ZIPS` unset |
| Reply triage | ✅ | Runs | — |
| Underwrite (landlord + flip) | ✅ | Flip precise-MAO wiring pending | — |
| Negotiate | 🧍 Manual | **Operator** — by design | — |
| Contract e-sign (DocuSign) | ⚠️ | Unwired (Phase 1) → manual signature | — |
| Off-market acquisition | ❌ | Not built | **Section 8** |
| Creative / subject-to lane | ❌ | Not built | Phase 2 |

**Read:** the gap to a first live deal is a *sequence of switch-flips plus
validation*, not a build.

---

## 3. What's ahead to go live (the ignition sequence)

1. **Merge PR #46** → correct math live.
2. **Flip intake + autoseed live** → fresh records flow, ZIPs get real $/sqft,
   openers compute.
3. **Run the HOLD-reason instrument on fresh data** → *see* the real send-vs-hold
   split (built, not guessed).
4. **Stand up outreach compliance** (Section 7) — register a 10DLC campaign, set
   up consent capture / multi-channel. **This is the real prerequisite to live
   texting, and it is not yet done.**
5. **Lift the kill-switch + set the send-cap** (e.g. 5 texts/run, 2/ZIP) →
   **first metered live texts.**
6. **Operator works replies → negotiate → sign → assign** → first deal.

Genuine *build* gaps (vs. switch-flips): off-market acquisition (volume),
creative lane (capture no-cash-pencil deals), contract e-sign (convenience).
**None block the first deal.**

---

## 4. Market & unit economics (sourced)

All figures self-reported survey / lead-vendor data (no government dataset for
private assignment fees exists) — directionally reliable, not precise.
Source-quality flags carried from research.

**Assignment fee (Detroit-Michigan):**
- New operator, cheap Detroit inventory: **$3K–$8K/deal.**
- Better / suburban / higher-ARV: **$10K–$15K.**
- National median ~$10K, mean ~$13K (Real Estate Bees survey, n≈1,000).
- **Off-market / distressed: $15K–$20K** (iSpeedToLead, 20k+ closed deals —
  vendor-biased, weight accordingly). On-market/MLS deals are the *thinnest*
  (~$3K).

**Conversion (the sober, neutral anchors):**
- Cold SMS 1st-touch reply ~**5%** (decays to ~2%, then ~0 by the 3rd pass).
- ~**1 deal per 23–40 responded/qualified leads** (Joe Horan neutral anchor:
  1 per 23 inbound; cold outbound is worse).
- Blended: **~1 deal per ~400–800 *raw targeted contacts*** (consistent with
  direct-mail's 0.2–0.5% close-per-piece).
- Contract→close fallout ~15–20% (retail proxy; wholesale likely higher,
  undocumented — budget conservatively).

**Cost (solo, current pricing — mostly official pages):**
- Data/list (PropStream/BatchLeads): **~$100–$210/mo.**
- Skip-trace: **~$0.07–0.15/record.**
- SMS: **~$0.02–0.04/message** (+ ~$125–500/mo platform).
- Dialer (if used): ~$95–150/seat/mo.
- County public records: **mostly FREE.**
- **Total solo marketing spend:** ~$300–600/mo lean → **~$1,000–1,500/mo
  typical** → $3,000–5,000/mo aggressive.
- **Per-deal acquisition cost: ~$2,000–3,000.**

**Cycle time:** contract→close 21–30 days; **lead→cash ~73 days median.** Budget
a ~2–3 month lag from "go live" to "first check."

---

## 5. The revenue model (conservative / base / upside)

**The funnel, shown:** raw targeted contacts → ~5% reply → ~1 deal per 25–40
responses ≈ **1 deal per ~600 raw contacts** (planning midpoint). To keep a solo
closer fed at 6 deals/mo needs only **~3,600 contacts/mo** — *well within*
compliant limits. So at solo scale the binding constraint is **close-capacity,
not lead volume.**

| Tier | Deals | Fee assumption | Gross/yr | What it assumes |
|---|---|---|---|---|
| **Year 1 — go-live + ramp** | 3–6 total (yr) | $5–10K | **$20K–$50K** | live mid-year; per-deal human time is HIGH at first (low trust in gates + dispo/contract still manual); learning to close. Matches the industry "executing beginner" band. |
| **$30K/mo — stress-gone (operator target)** | 2–6/mo | $5–15K blend | **~$360K** | system live + funnel feeding + first deals proven. **Gated by go-live, not by capacity** — below the structural ceiling. |
| **Structural ceiling — automation as the team** | 15–30/mo | $10–20K (off-market) | **$1.8M–$5M+** | the *destination*: per-deal human touch minimized (dispo + contract + advanced-nego automated), compliant outreach scaled (vetted 10DLC), trust built. NOT a year-1–2 projection — what the system is *built toward*. Arithmetic of the operator's own "automation = team" model; gated by finishing the de-bottleneck builds (§7b). |
| **"Unlimited" (end goal)** | + new markets | — | higher | extend by adding markets + scaling compliant outreach. Real ceilings (market size, compliance, irreducible decisions/signatures) exist but are high enough that a fixed target is beside the point. |

**Net, not gross:** subtract ~$2–3K/deal acquisition + ~$12–18K/yr fixed tools.
Net per deal ≈ **$3–7K**. Retire-income tier ≈ **$50K–$90K net**; upside solo ≈
**$250K–$500K net**.

**Honesty flags:** Year-1 has real downside (1–2 deals → near-zero or a small
loss after marketing — common). All fee/conversion figures are self-reported
with survivorship bias; treat as the *median or below*. Guru "$300K year one /
10 deals a month solo" is **discarded as fantasy** (those tiers require 3+ years
and a team).

---

## 6. The automation edge — what it changes, and what it doesn't

This is *why* the system can hit the upper end of every tier where a manual solo
stalls — stated honestly.

**It changes:**
- **Labor cost per touch → ~0.** A manual solo's real bottleneck is *time* on
  outreach + pricing + follow-up. The system does all of it. The operator's
  hours go entirely to **closing**.
- **Follow-up discipline.** Stopping follow-up at ~day 30 reportedly forfeits
  ~94% of eventual deals. The system never forgets. This alone materially lifts
  conversion.
- **Pricing accuracy.** Correct, value-anchored offers (the fix) → fewer dead
  chases, no embarrassing over-offers.
- **A permanently-full close-pipeline.** The opposite of a solo who runs dry
  between marketing pushes.

**It does NOT change:**
- The **fee per deal** (~$5–10K Detroit) — market reality.
- The **base conversion** (~1 per ~600 contacts) — though better targeting +
  off-market + follow-up push it toward the good end.
- The **carrier / compliance cap** on outreach — automation cannot make
  non-consented blasting legal or exceed carrier limits.
- The **operator's personal close-capacity** — the system fills the funnel; the
  operator still closes each deal by hand (by choice).

**Net:** automation moves the operator's time to its highest-value use and
removes the failure modes that kill most solos. It is a *multiplier on
execution*, not a cheat on market economics.

---

## 7. The two hard truths (the real ceilings)

### 7a. Outreach compliance is the #1 thing to get right — and it's not done

This is the most important correction to the "endless volume via cold text"
dream, and it protects the operator:

- **TCPA:** autodialed marketing texts require **prior express written
  consent**. Statutory damages **$500–$1,500 per text**. TCPA class-action
  filings hit record highs in 2024–2025 (+283% YoY in Sept 2025). *Cold-blasting
  strangers is a genuine legal exposure, not a gray area.*
- **Carriers BLOCK 100% of unregistered 10DLC traffic** (since Feb 2025).
  Registered caps: **sole proprietor ~1,000 SMS segments/day**, standard brand
  ~2,000/day, throttled ~25/min; higher only for vetted high-trust brands.
- **State mini-TCPAs** (e.g. Texas SB 140, Sept 2025) add per-text state
  penalties — relevant as the system expands beyond Michigan.

**Implication:** the realistic *compliant* solo volume is ~1–2K texts/day, and
even that legally wants consent. **Required workstream before scaling sends:**
(1) register a 10DLC campaign (needs an EIN); (2) build a consent-capture /
multi-channel first touch (calls + mail + RVM are differently regulated and can
*earn* the consent SMS then closes); (3) start metered and grow the trust score.
Good news: at *solo* deal volume (~3.6K contacts/mo) you are **far under** the
carrier cap — compliance is about *consent and registration*, not raw throughput,
until you scale to a team.

### 7b. The operator's close-capacity — a climbing dial, not a fixed ceiling

**CORRECTION (operator, 2026-06-28):** an earlier draft capped solo throughput
at 4–8 deals/month. That is a *manual* solo wholesaler's plateau — they
personally do acquisition + negotiation + diligence + disposition for every
deal. It does **not** apply here: **the automation IS the team** (acquisition,
pricing, outreach, triage, underwriting, and — once built — disposition). The
right benchmark is a *teamed* operation: **10–30+ deals/month.**

The real ceiling is set by the operator's **irreducible time per deal** — the
by-design-human parts: a go/no-go decision, the hard negotiation moments
auto-replies can't handle, signing the contract + assignment, releasing money.
A clean deal ≈ 30–45 min; a complex (creative/contested) one ≈ a few hours. At
~1–2 hr/deal and 20–30 focused hr/week that is **~15–30 deals/month**, not 4–8.

**CRITICAL UNKNOWN:** the operator has not closed a deal yet, so real per-deal
time is unmeasured — the first deals measure it. Expect it **HIGH at first**
(low trust in the gates + dispo/contract automation incomplete → month one may
genuinely feel like 4–8) and **falling** as (a) the automation removes the
operator's per-deal touch and (b) trust in the now-correct math grows. The
ceiling is a **dial that turns up as the system earns trust** — which is exactly
the 99%-autonomous goal, expressed as throughput.

**Therefore the highest-leverage builds are the ones that cut the operator's
per-deal minutes:** disposition automation (auto-match each contract to the
buyer list + blast — removes the biggest time-sink), contract auto-generation +
e-sign (signing = one tap), and advanced auto-negotiation (operator touches only
the moments that need a human). These directly raise the ceiling toward the
operator's "unlimited" goal. Delegating to humans is a *later* option, not the
only path past 4–8 — the automation is the team.

### 7c. Other real risks (named, not hidden)
- **Regulatory drift:** several states restrict/license wholesaling; **verify
  current Michigan rules** before scaling. Ethical line: don't under-pay
  distressed sellers (the value-anchored math + creative lane help here).
- **Data/operational:** Firecrawl balance + KV health must be verified before
  turning up intake volume (see AS_BUILT §7). Today's exact balances are unknown.
- **Conversion is the softest number in this plan** — every stage % is
  self-reported. The HOLD-reason instrument + first metered run replace these
  guesses with *your* real numbers within weeks of go-live.

---

## 8. The biggest lever — off-market acquisition (the scope you asked for)

**Why it's the highest-ROI next build:** it ~doubles the fee per deal ($5–10K
on-market → **$15–20K off-market**) *and* improves conversion (motivated,
lower-basis sellers whose deals actually pencil at cash prices → fewer "ARV<list"
HOLDs), *and* runs on **free public records**. The engine that consumes it
already exists — the gap is the *acquisition adapters*.

**What exists vs. what's needed:**
- ✅ Already built: the deal analyzer (ARV→MAO, now correct), comp/ARV model,
  rehab vision, buyer medians, the full intake→price→gate→outreach→triage
  pipeline. The "robot that collects structured data and turns it into
  decisions" is proven (it's literally what runs today on on-market data).
- ❌ The gap: today the system feeds from **on-market** listings only. Off-market
  needs **per-source ingest adapters** (the same adapter pattern that works for
  any structured source), feeding the *existing* pipeline.

**Scope (phased, by ROI):**
1. **Absentee-owner + high-equity (40%+) lists** — the single strongest list for
   response (vendor + practitioner consensus). Available via the existing data
   providers (PropStream/BatchLeads) — fastest to wire, no new scraping.
2. **County public-records adapters** (free data; per-county, golf-adapter
   style): **pre-foreclosure / NOD / Lis Pendens**, **tax-delinquent**,
   **code-violation**. Start with the operator's core Michigan counties (Wayne,
   Oakland, Macomb).
3. **List-stacking** — properties appearing on *multiple* distress lists convert
   best. Build the dedup/stack scorer over the ingested lists.
4. **Probate / divorce** — higher-touch, longer nurture; lower priority (and the
   "40% conversion" claims are debunked hype — model at low single digits).
5. **Buyer-list mining** from cash/LLC deed records — builds the dispo side
   (who actually buys in each ZIP) for free.

**Compliance is a co-requisite** (Section 7a): off-market sellers still require
a compliant first touch. Sequence the consent/multi-channel workstream alongside
adapter #1.

**Effort shape:** adapter #1 (absentee/high-equity via existing providers) is
small — it reuses the intake path. The county adapters are the real work
(per-county site formats), best done incrementally, county by county, highest-
population first. Each new source compounds because it feeds the same engine.

---

## 9. The ask / next steps

**Bootstrap reality ($0 starting budget):** zero budget makes **free public
records the launch lane** — cheapest acquisition *and* highest fee. Not literally
$0: budget **~$100–300/mo** (cheapest data/skip tier + metered SMS + API calls);
the first assignment ($5–15K) funds the climb. *Action: verify current Firecrawl
/ RentCast / ATTOM balances before turning up intake volume.*

1. **Merge PR #46** (correct math live). *Operator action.*
2. **Stand up 10DLC** (EIN in hand ✓) + a consent/multi-channel first touch — the
   compliance prerequisite to any live texting (§7a).
3. **Flip intake + autoseed live; run the HOLD instrument on fresh data** →
   replace every guessed number here with real ones.
4. **Off-market adapter #1 — absentee + high-equity, then free county records**
   (Wayne/Oakland/Macomb): the zero-budget, highest-fee launch lane.
5. **First metered live send** (5/run) → first replies → **first deal** →
   *measure the operator's real per-deal time* (the number that sets the whole
   ceiling, §7b).
6. **The de-bottleneck builds — the path to $30K/mo and past it** (each removes
   operator minutes per deal): **disposition automation** (auto-match each
   contract to the buyer list + blast), **contract auto-gen + e-sign**,
   **advanced auto-negotiation**. The automation is the team; these *are* the
   team being built.

**Inputs captured (2026-06-28):** EIN ✓ · target **$30K/mo** (both incomes + the
stress) · **$0** starting budget · per-deal hours **TBD** (no deal closed yet —
the first deals measure it). End goal explicitly **unlimited**; $30K is a
milestone, not a cap.
