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
  - **Retire-a-second-income milestone (~1 deal/month):** ~$60K–$120K/yr —
    *reachable in the first 12–18 months of going live.*
  - **Solo at full close-capacity (4–8 deals/mo):** ~$250K–$700K/yr.
  - **Scaled (team + off-market volume + compliant multi-channel):** $1M+/yr —
    real, but a *team* business, not solo.
- **The two hard truths** (Section 7): outreach is legally and technically
  capped (TCPA + carrier 10DLC rules), and a solo can only *close* so many
  deals/month. Both are manageable; neither is optional to plan for.
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
| **Year 1 — go-live + ramp** | 3–6 total | $5–10K | **$20K–$50K** | live mid-year; 10DLC trust-score ramps caps up over time; seeding coverage grows; learning to close. Matches the industry "executing beginner" band. |
| **Retire-income milestone** | ~1/mo (~12/yr) | $5–10K (off-market lifts it) | **$60K–$120K** | system live + funnel feeding + operator closing steadily. *Low end* of an established solo — very achievable. |
| **Base — solo, automated funnel** | 2–4/mo (24–48/yr) | $5–15K blend | **$150K–$350K** | the system keeps the close-pipeline permanently full; operator closes steadily; some off-market mix. |
| **Upside — solo at close-capacity** | 5–8/mo (60–96/yr) | $5–15K blend | **$400K–$800K** | off-market volume feeding; operator at personal close-capacity, possibly one dispo helper. The solo ceiling. |
| **Scaled — team business** | 10+/mo | $10–20K (off-market) | **$1M+** | delegated acquisition/close, off-market at volume, vetted multi-brand 10DLC to clear carrier caps. Not solo. |

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

### 7b. The operator's close-capacity is the near-term ceiling

The operator chose to keep negotiation/signature/money manual. So solo
throughput caps at **~4–8 deals/month** (negotiate + DD + dispo each). The
automated funnel can *over-supply* qualified deals; the limit is how many the
operator can personally close. **Past that ceiling = delegate the close (an
acquisitions/dispo helper) or automate more of the negotiation.** This is the
fork between the "$250–700K solo" tier and the "$1M+ team" tier.

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

## 9. The ask / next steps (in order)

1. **Merge PR #46** (correct math live). *Operator action.*
2. **Stand up 10DLC + consent/multi-channel** (the compliance prerequisite).
   *Needs operator: EIN, business registration, channel choice.*
3. **Flip intake + autoseed live; run the HOLD instrument on fresh data** →
   replace every guessed number in this plan with real ones.
4. **First metered live send** (5/run) → first replies → first deal.
5. **Build off-market adapter #1** (absentee + high-equity) → fee uplift.
6. **Add county adapters** (Wayne/Oakland/Macomb) → volume.
7. **Decide the fork** (Section 7b): stay solo at the $250–700K ceiling, or add a
   closer/dispo helper toward $1M+.

**Inputs that would sharpen this plan** (give me these and I'll tighten the
ranges): the second income you want to replace ($), your weekly hours available
to *close*, your monthly marketing budget, and your business-entity/EIN status
for 10DLC.
