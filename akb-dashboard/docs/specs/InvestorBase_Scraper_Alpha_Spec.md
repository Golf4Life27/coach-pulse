# InvestorBase Buyer_Median Scraper (α path) — SPEC ONLY

**Status: spec, NOT built. Separate go decision (operator, 2026-06-08).**

The γ path (manual stamped input) ships now and unblocks the underwrite
gate per-deal. This α path is the durable replacement: automated
`Buyer_Median` hydration so the operator never types a number. Do **not**
build until explicitly authorized — the hard data rule below makes a
sloppy scraper worse than no scraper.

## The hard rule it must honor

Identical to the γ path: a `Buyer_Median_Value` may exist **only** because
it came from InvestorBase. The scraper writes `Buyer_Median_Source =
"investorbase"` (auto) vs the manual path's `"investorbase_manual"` — two
distinct provenance stamps so the audit trail never conflates a scraped
value with a hand-entered one. If the scraper cannot confirm a real
InvestorBase result for a subject, it writes **nothing** (HOLD), exactly
like every other Positive-Confirmation-Principle surface in this system.

## What it produces

Per active DD-phase listing (the same trigger as INV-022 federation —
`Outreach_Status` ∈ {Negotiating, Offer Accepted}):

- `Buyer_Median_Value` (currency) — median of recent cash-buyer
  acquisition prices for comparable properties in the subject's submarket.
- `Buyer_Median_SampleSize` (number) — how many buyer comps backed it.
  A median over < N (propose N=4) is HELD, not written.
- `Buyer_Median_Source = "investorbase"`.
- `Buyer_Median_FetchedAt` (dateTime) — scrape time.

Writes through the existing `upsertPropertyIntel(listingId, address,
fields)` store — same path the γ route and the federation cron already use.

## Open design decisions (the go-decision inputs)

1. **Access path.** InvestorBase has no documented public API. Options,
   cheapest-first:
   - (a) Authenticated session scrape (operator installs credentials as
     env secrets; headless fetch of the buyer-match view). Fragile to UI
     change; same class as the Firecrawl/ScraperAPI listing path.
   - (b) Official API / data-export agreement if one exists at the
     operator's plan tier — confirm before building (a).
   - (c) Browser-automation (Make.com browser module / Claude-in-Chrome)
     as the INV-022 brief's documented fallback. **NOT operator CSV
     upload** — that violates the autonomy rule.
2. **Submarket definition.** What radius / filter defines "comparable
   buyer activity" — ZIP, 1-mi, school-zone, the same bucket ARV comps
   use? Reuse the ARV comp-selection geometry for consistency.
3. **Median vs trimmed mean.** Buyer acquisition prices are noisier than
   retail comps (wholesale assignments, bulk deals). Propose a trimmed
   median (drop top/bottom decile) + the sample-size floor as the
   integrity guards. Lock with real data before shipping.
4. **Burn-rate guard.** Mirror `RENTCAST_MONTHLY_CAP` — an
   `INVESTORBASE_MONTHLY_CAP` + per-run budget, Spine-logged on cap hit.
5. **Staleness.** A scraped Buyer_Median should re-confirm on a cadence
   (propose 14 days) since buyer appetite moves; `Buyer_Median_FetchedAt`
   drives the refresh, identical to the AS-IS / Rent freshness pattern.

## Cost/lift estimate

2–4 engineering days for path (a), plus operator credential install. Path
(c) is lower code but higher per-run latency and Make-coupling. The α
build only earns its keep once volume makes per-deal manual entry the
operator-hours bottleneck — until then the γ path covers the active
cluster. Sequence it as **Phase A's durable follow-on**, after the manual
path proves the gate unblocks cleanly.

## Test plan (when built)

- Pure: submarket filter, trimmed-median, sample-size floor (HOLD under N).
- Provenance: asserts `source="investorbase"`, never `"investorbase_manual"`.
- Refusal: zero/under-floor buyer comps → no write, audited HOLD.
- Burn guard: cap-hit short-circuits + Spine row.
