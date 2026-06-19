# Pricing Evidence Run — ARV path vs the 65%-of-list rail (M1.5)

**Date:** 2026-06-16 · **Mode:** read-only (zero writes, zero sends, zero network — measured)
**Reproduce:** `npx vitest run lib/pricing/pricing-evidence.test.ts --disable-console-intercept`
**Data:** `lib/pricing/__evidence__/` (81 records + 18 seeds, pulled read-only via Airtable MCP, Production)

## The question

M1 found, on 3 records, that the ARV/buy-box path never beat the flat 65%-of-list
rail. But M1 mocked all external inputs **empty** — which starves the ARV path. This
run fed the **real** pricer real inputs (committed `markets.json`, the **real**
ZIP_ARV_Seed renovated-comp seeds, each record's real ARV, anchor 0.90 = the launch
maximum) across the **complete** with-ARV population.

## The cohort (exact, paginated via server-side totalRecordCount)

- **4,858** Listings_V1 rows total; **4,857** have List_Price > 0 (priceable).
- **81** have a real `Real_ARV_Median > 0` — **1.7%**. The other ~98% have **no ARV at
  all**. They go to 65% because the ARV data is **absent**, not because the ARV path
  lost. (Auto-seed/ARV enrichment is gated off — see AS_BUILT §4.)

So the only records where "ARV vs 65%" is even a question are these 81. We priced **all
81** (not a sample).

## Result — of the 81 records with real ARV data

| Route the FINAL opener took | n |
|---|---|
| **buybox_won** (ARV path produced the final number) | 29 |
| **buybox_won_capped** (ARV ≫ list, deep-discount, capped to 0.9×list) | 4 |
| arv_distrusted (ARV < list → dropped to 65%) | 24 |
| buybox_floored (buy-box pencilled below the floor → 65%) | 10 |
| seed_dont_price (ZIP seed marked do-not-price → 65%) | 3 |
| no_buybox_market (San Antonio/Houston have no `arv_pct_max`) | 7 |
| fallback_other | 4 |

**Headline: the ARV/buy-box path produced the final opener in 33 of 81 (41%); the final
differed materially (>3%) from the 65% rail in 31 of 81 (38%).** Effective ARV source:
seed = 53, stored = 28.

**Crucially: in 0 records did the ARV path beat the rail pre-guards only to be knocked
back by a guard.** The distrust/floor guards only suppressed numbers that were *already
below* the rail (genuinely thin deals). When the ARV path produced a number above the
rail, it won.

## What it moves, and which way

The ARV path is not "65% plus noise" — it moves the opener **both** directions, more
informed than a blind list fraction:

- **More conservative** on thin Detroit deals (most of the 29 seed wins land *below* 65%
  of list — e.g. `recCEN0152QW2zGWe` 48227: rail $37,700 → ARV opener **$23,297**,
  because rehab eats the renovated-comp buy-box). 65% of list would *over*-offer here.
- **More aggressive** on deep-discount listings (the 4 capped wins, ARV ≫ list — e.g.
  `recTrTMR7Xty7XV1Y` 48213: list $47,900, ARV $230,120 → buy-box $87,891, capped to
  $43,110 vs rail $31,135).

## Recommendation (for the operator — not a decision)

**The evidence points to KEEP (and re-tune), not cut.** The M1 "ARV never wins" was a
starved-data artifact, not a verdict on the machinery: with real seeds + real ARV the
path changes the number on ~40% of the records that have ARV, and always in the
defensible direction. The real bottleneck is **ARV data coverage** — only 81 of 4,857
priceable records have any ARV. Deleting the ARV path would lock in blind 65%-of-list on
the very Detroit deals where renovated comps say 65% is too high. The higher-leverage
move is to **turn the ARV/seed pipeline back on** (auto-seed is gated off) so more than
1.7% of the cohort can be priced on comps — then re-tune the floor/distrust thresholds.

Caveats: anchor was the 0.90 launch default (KV unreachable this session — the most
generous case for the ARV path); `arv_pct_max` is sourced only for Detroit/Dallas, so
TX-metro records can't use the buy-box at all yet.
