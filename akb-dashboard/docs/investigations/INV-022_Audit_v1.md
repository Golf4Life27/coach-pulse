# INV-022 Audit v1 — Data Source Federation Layer (Q1–Q6 Audit Phase)

**Author:** Code
**Date:** 2026-05-25
**Brief:** `docs/investigations/INV-022_Brief.md`
**Status:** AUDIT PHASE COMPLETE — awaiting Maverick review + operator A/B/C selection. NO implementation in this cycle.
**Phase:** 1 of 2 (audit → review → operator selection → implementation). Mirrors INV-005 sequence.
**Cross-ref:** INV-023 `a9ebcf8` (mortgage payoff viability check) consumes the lien data this layer hydrates — see Q5.

---

## Executive summary

The codebase already contains **more federation scaffolding than the brief assumed.** RentCast is a live, production-wired integration (`lib/rentcast.ts`) with a burn-rate guard. PropStream has a complete adapter framework (`lib/crawler/sources/propstream.ts`) waiting only on a `PROPSTREAM_API_KEY`. ScraperAPI + Google Street View are live (`lib/photo-sources.ts`, post-INV-005 documented in `.env.example`). The genuine net-new work is: (1) FEMA flood + crime grade (no integration today), (2) InvestorBase (CSV-only today, likely needs browser automation), (3) the `Property_Intel` aggregation table + provenance discipline, (4) the trigger cron, (5) the discrepancy surface.

**Recommended resolution: Option B (phased).** v1 ships the three confirmed-API vendors (RentCast + ScraperAPI/Firecrawl + FEMA) plus the Property_Intel table + trigger cron. v2 adds PropStream (once `PROPSTREAM_API_KEY` provisioned) + InvestorBase (browser automation) + crime grade. Rationale in Q4.

**Hard blocker to flag now:** InvestorBase `Buyer_Median` is the V2.1 floor's primary truth signal (per memory + brief), but there is **no InvestorBase API integration in the codebase today** — it's CSV-import-only (`app/api/buyers/import-csv/route.ts`). v1 "MUST include InvestorBase" (per brief constraint) collides with "InvestorBase has no confirmed API." Resolution options in Q1 + Q6.

---

## Q1 — Vendor API reality check

### Per-vendor access matrix

| Vendor | In-code today | API status | Plan / cost | Endpoints needed | Fallback if no API |
|---|---|---|---|---|---|
| **RentCast** | ✅ LIVE (`lib/rentcast.ts` + `app/api/verify-listing/route.ts`) | Confirmed REST API, `X-Api-Key` header | Pro **$199/mo = 2,000 req/mo**, then per-req overage (Free=2, Starter $29=100, Growth $99=500) [1] | **THREE confirmed endpoints:** `/avm/value` ✅ (value + embedded comps), `/avm/rent/long-term` ✅ (rent), `/v1/listings/sale` ✅ (active-listing confirmation — powers live `/api/verify-listing`). What does NOT exist: `/avm/sale-comparables` (a comps endpoint — 404s; comps come embedded in `/avm/value`). | n/a — API works |
| **PropStream** | ⏳ SCAFFOLDED, uncredentialed (`lib/crawler/sources/propstream.ts`) | API exists (powers third-party CRMs) but **gated behind business tier + access request** [2] | Public Core **$99/mo**; internal note **~$299/mo API-capable tier (5/19)**; discrepancy to resolve with vendor | property lookup, comp search, owner lookup, **lien search** (drives INV-023) | Browser automation (Q6) |
| **ScraperAPI** | ✅ LIVE (`lib/photo-sources.ts`, `SCRAPER_API_KEY`) | Confirmed; used for Redfin photo scrape | already provisioned (post-INV-005 `.env.example`) | Redfin **photo** URL extraction → vision pipeline | n/a — live |
| **Firecrawl** | ⚠️ Egress-validated 5/20 (HTTP 200, 26,836 chars markdown against 4838 Wisteria; checklist 22.1 DONE) but **NOT wired into production code** (no `lib/firecrawl.ts`, no route calls `api.firecrawl.dev`) | API confirmed, account provisioned | per-page or per-token pricing | listing **markdown extraction + keyword scoring** (intended for `/api/verify-listing` v2 per `AKB_Belt_v1_Spec.md` §4, replacing retired Scenario B keyword-scoring work) | n/a — needs production wiring (see **INV-028**) |
| **InvestorBase** | ❌ CSV-only (`app/api/buyers/import-csv`) | **No API integration in code. Likely UI-only.** OPEN QUESTION. | unknown | smart-match buyer pull → `Buyer_Median` | Browser automation (Q6) — likely the only path |
| **FEMA NFHL** | ❌ none | ✅ Free public ArcGIS REST: `https://hazards.fema.gov/gis/nfhl/rest/services/public/NFHL/MapServer` [3] | **$0** | point-in-polygon flood-zone query by lat/lng | n/a — free gov API |
| **Crime grade** | ❌ none | Multiple vendors, no clear winner [4] | varies (CrimeoMeter, DoorProfit, CrimeGrade-via-Apify, NeighborhoodScout) | crime grade by lat/lng or ZIP | pick one in v2 |

### Flags

1. **Firecrawl: validated egress, unwired production status.** Firecrawl is NOT merely a loose name for ScraperAPI (this audit's v1 said so — incorrect, now corrected). It is a distinct vendor whose egress was validated end-to-end on 5/20 (checklist 22.1 DONE: HTTP 200, 26,836 chars markdown against 4838 Wisteria, content markers present, zero anti-bot) but which has **no production wiring** — no `lib/firecrawl.ts`, no route calls `api.firecrawl.dev`. It is intended to power the **unbuilt half of listing verification**: off-market body-text detection (checklist 1.4) + flip/distress keyword scoring (checklist 1.5) that was lost when Make Scenario B was retired. ScraperAPI (live) extracts Redfin photos for vision; Firecrawl (unwired) is the listing-content/markdown layer. Production wiring tracked as **INV-028**.

2. **"Prostream" ≠ "PropStream."** Web search surfaces `prostream.app` ("Prostream API") — a **different company**, not PropStream the real-estate-data vendor. Do not wire against it. PropStream API access is via PropStream directly (877-204-9040 / support@propstream.com).

3. **RentCast serves three confirmed endpoints** (corrected): `/avm/value` (value + embedded comps), `/avm/rent/long-term` (rent), and `/v1/listings/sale` (active-listing confirmation — live in `/api/verify-listing`). The brief's `/v1/listings/sale` reference was correct. What does NOT exist is `/avm/sale-comparables` (a comps endpoint that 404s; comps are embedded in `/avm/value`) — this audit's v1 conflated active-listing-lookup with comps.

4. **RentCast burn-rate guard already exists** (`lib/maverick/rentcast-burn-rate.ts` + `RENTCAST_MONTHLY_CAP` env). v1 federation must respect it — see Q4.

### Deliverable: env-var provisioning state

| Env var | Present today | Needed for |
|---|---|---|
| `RENTCAST_API_KEY` | ✅ | RentCast (live) |
| `RENTCAST_MONTHLY_CAP` | ✅ | burn-rate guard |
| `SCRAPER_API_KEY` | ✅ (post-INV-005) | ScraperAPI scrape |
| `GOOGLE_MAPS_API_KEY` | ✅ (post-INV-005) | Street View |
| `PROPSTREAM_API_KEY` | ❌ referenced, not set | PropStream (v2) |
| `INVESTORBASE_*` | ❌ none | InvestorBase (v2, likely browser-auth) |
| `FEMA` | n/a (no key — public) | FEMA NFHL (v1) |
| crime vendor key | ❌ none | crime grade (v2) |

---

## Q2 — Property_Intel table schema (PROPOSAL)

New Airtable table `Property_Intel` on base `appp8inLAGTg4qpEZ`. Linked 1:1 to `Listings_V1` via `Subject_Listing_Id`. **Per-field provenance is mandatory** (Decision Preconditions discipline): every hydrated datum carries `value + source + fetched_at`, plus `confidence` or `sample_size` where the vendor returns it.

**Note:** field IDs are assigned by Airtable at provisioning time (same pattern as INV-005's `Rehab_Source` = `fldhn2vxQipa3PVsX`). This audit proposes names + types + option enums only. No table created in this phase.

### Proposed fields

| Field | Type | Notes |
|---|---|---|
| `Subject_Listing_Id` | linked record → Listings_V1 | the join key |
| `Hydration_Status` | singleSelect | `pending` / `partial` / `complete` / `failed` |
| `Last_Hydrated_At` | dateTime | most recent full pull |
| **Valuation (RentCast)** | | |
| `AS_IS_Value` | currency | RentCast `/avm/value` `price`. **NEVER treated as ARV** (per memory). |
| `AS_IS_Value_Low` / `_High` | currency | priceRangeLow / High |
| `AS_IS_Value_Source` | singleSelect | `rentcast` / `manual_operator` |
| `AS_IS_Value_FetchedAt` | dateTime | |
| `Rent_Estimate` | currency | RentCast `/avm/rent/long-term` |
| `Rent_Estimate_Source` / `_FetchedAt` | singleSelect / dateTime | |
| `Sold_Comps_JSON` | multilineText | comps array from `/avm/value`, capped 95k |
| `Sold_Comps_Count` | number(0) | |
| **Buyer demand (InvestorBase)** | | |
| `Buyer_Median_Value` | currency | the V2.1 floor truth signal |
| `Buyer_Median_Source` | singleSelect | `investorbase` / `manual_operator` |
| `Buyer_Median_SampleSize` | number(0) | # buyers in the smart-match set |
| `Buyer_Median_FetchedAt` | dateTime | |
| **Title + liens (PropStream) — feeds INV-023** | | |
| `Owner_Of_Record` | singleLineText | |
| `Owner_Source` / `_FetchedAt` | singleSelect / dateTime | |
| `First_Mortgage_Amount` | currency | recorded amount |
| `First_Mortgage_Type` | singleSelect | `fixed` / `revolving` / `unknown` (revolving elevates INV-023 severity) |
| `Second_Mortgage_Amount` | currency | |
| `Judgment_Liens_Total` | currency | |
| `Mechanic_Liens_Total` | currency | |
| `Tax_Liens_Total` | currency | |
| `Payoff_Total` | currency | computed sum — the value INV-023's viability check reads |
| `Liens_Source` / `_FetchedAt` | singleSelect / dateTime | |
| **Flood + crime** | | |
| `FEMA_Flood_Zone` | singleLineText | e.g. `X`, `AE`, `VE` |
| `FEMA_Flood_Source` / `_FetchedAt` | singleSelect / dateTime | source = `fema_nfhl` |
| `Crime_Grade` | singleLineText | vendor grade (v2) |
| `Crime_Grade_Source` / `_FetchedAt` | singleSelect / dateTime | |
| **Discrepancy surface (Q5)** | | |
| `Discrepancy_Flags_JSON` | multilineText | array of `{type, severity, detail, detected_at}` |
| `Discrepancy_Severity_Max` | singleSelect | `none` / `info` / `amber` / `red` — drives dashboard surface |
| **RESERVED for INV-028 (created at v1 provisioning, populated when INV-028 ships)** | | |
| `Listing_Flip_Score` | number(0) | 0-10, count of flip keywords matched per checklist 1.5 |
| `Listing_Flip_Bucket` | singleSelect | `none` / `manual_review` / `reject` — 4+ → manual_review, 7+ → reject |
| `Off_Market_Body_Text_Detected` | checkbox | true if Firecrawl body scan matched checklist 1.4 patterns |
| `Restriction_Risk_Level` | singleSelect | `clear` / `caution` / `restricted` — from restriction-keyword scan |
| `DOM_Discrepancy_Days` | number(0) | PropStream DOM minus Redfin DOM |
| `Listing_Content_Source` | singleSelect | `firecrawl` / `manual_operator` — provenance |
| `Listing_Content_FetchedAt` | dateTime | |

**Provenance enum convention:** every `*_Source` field is a singleSelect with at minimum `<vendor>` + `manual_operator`. This mirrors INV-005's `Rehab_Source` pattern exactly, so the fabrication-prohibition holds: a field with no `*_Source` set is unhydrated, never guessed.

**INV-028 reserved-field rationale:** the seven fields above are created (empty) at v1 Property_Intel provisioning so INV-028 (Firecrawl wiring) does not require a schema migration when it ships in v2. They stay null until INV-028 populates them. This is the same forward-reservation discipline that avoids the mid-flight Airtable migrations the project has been bitten by before.

**Open question:** one wide `Property_Intel` table vs. fields-on-Listings_V1. Recommendation: **separate table** — keeps Listings_V1 from bloating ~30 more fields, and the 1:1 link is cheap. Operator/Maverick to confirm.

---

## Q3 — Trigger architecture

**Recommendation: α + γ hybrid (cron-canonical, inline-optional), NOT δ.**

| Option | Verdict |
|---|---|
| **α** — new cron `/api/cron/data-federation-pull` scanning for `Outreach_Status` ∈ {Negotiating, Offer Accepted} not-yet-hydrated | **PRIMARY.** Mirrors INV-006 reconciler + INV-005 retry cron exactly (pure helper + thin orchestration + Notes/field idempotency marker). Daily Hobby-cap slot. |
| **β** — inline trigger from `/api/deal-action/[id]` on status change | Deferred. Synchronous pull would block the operator's action on 5+ vendor round-trips (could be 30s+). Better as fire-and-forget, but Vercel serverless makes background tasks fragile. Skip for v1. |
| **γ** — Make scenario on Airtable field change | Useful as the **low-latency arm** (sub-5-min hydration on status flip) once Make wiring is desired. Documented for v2. |
| **δ** — all-of-above | Over-engineered for v1. |

**Chosen surface:** α cron, daily slot. Existing crons occupy 8/9/10/11/12/13/14/15 UTC (15:00 = INV-005 rehab-retry, shipped). **Next free slot: 16:00 UTC** (`0 16 * * *`). Within Hobby once-daily cap.

**Freshness SLA:**
- Daily cron catches any record that flipped to Negotiating/Offer Accepted in the prior 24h and hydrates it.
- Nightly re-pull of already-hydrated active DD-phase records for freshness.
- If sub-5-min hydration on status-flip becomes a requirement (operator pitching same-day), add the γ Make arm in v2 — flagged, not built.

**Idempotency:** `Hydration_Status` field + `Last_Hydrated_At` timestamp gate re-pulls (mirrors INV-005's 7-day cooldown pattern, but freshness-window-based: skip if hydrated < 24h ago unless forced).

---

## Q4 — Cost + rate-limit envelope

Assume 100-deal/month pipeline, ~30 active DD-phase records at any time, 1 initial pull + nightly refresh = **~30 pulls/day/vendor** ≈ 900/mo/vendor.

| Vendor | Monthly volume | Plan needed | Est. monthly cost | Rate-limit risk |
|---|---|---|---|---|
| RentCast | ~900 value + ~900 rent + `/v1/listings/sale` active-listing refresh (verify-listing already consumes this on existing records — federation adds DD-phase pulls on top) = **~1,800–2,700+ req/mo** (each endpoint = 1 req) | Pro ($199 = 2,000/mo) is already tight at 2 endpoints; adding the third endpoint's federation volume **likely pushes over → overage or Enterprise** | **$199/mo** + near-certain overage [1] | 🔴 Three endpoints × 30 records nightly blows past the 2,000 Pro cap. **`RENTCAST_MONTHLY_CAP` guard already exists** — v1 MUST wire federation through it. Strong recommendation: refresh volatile data weekly (not nightly) + only on material event; `/v1/listings/sale` is already spent by verify-listing, so federation should READ the existing verify result rather than re-pull. |
| PropStream | ~900/mo | business/API tier | **~$99–299/mo** (verify) [2] | unknown until credentialed |
| ScraperAPI | ~900/mo | existing plan | already paid | existing throttle (`lib/quo-throttle` pattern exists for ref) |
| InvestorBase | ~900/mo | unknown (browser-auto rate-limited by UI) | unknown | ⚠️ **HIGH** — browser automation against a UI caps far below 900/mo; may need per-deal-on-demand only, not nightly |
| FEMA NFHL | ~900/mo | free | **$0** | public service; be polite (cache flood zone — it never changes for a parcel) |
| Crime | ~900/mo | vendor-dependent | varies | flood + crime are static per parcel → **cache aggressively, pull once, never refresh** |

**Total v1 (RentCast + ScraperAPI + FEMA):** ≈ **$199/mo net-new** (RentCast Pro; ScraperAPI already paid; FEMA free). Defensible.

**Cost-control recommendations:**
1. **Static data pulled once, never refreshed:** FEMA flood zone, crime grade, owner-of-record rarely change. Cache permanently; only re-pull on explicit operator force.
2. **Volatile data on freshness window:** AS-IS value, rent, liens, buyer median — refresh on a sane cadence (weekly, not nightly) to stay under RentCast's 2,000 cap and respect `RENTCAST_MONTHLY_CAP`.
3. **Any vendor capping < 30/day blocks the architecture** — InvestorBase via browser automation is the prime risk. See Q6.

---

## Q5 — Material discrepancy surface

Discrepancy taxonomy. Each writes a `Discrepancy_Flags_JSON` entry `{type, severity, detail, detected_at}` and sets `Discrepancy_Severity_Max`. Per Constitution Rule 3: the pulls are Type 1 (autonomous); the discrepancies are **Type 2C** (operator judgment) — never "click to authorize the pull."

| Discrepancy | Trigger | Severity | Surface |
|---|---|---|---|
| **Owner mismatch** | PropStream owner ≠ MLS listing's stated seller | AMBER | Type 2C card: "Owner of record is X, listing says seller is Y. Verify chain of title before contract." |
| **Lien / mortgage payoff** ⭐ | PropStream liens pulled → `Payoff_Total` computed | per INV-023 tiers | **Feeds INV-023 `a9ebcf8` MORTGAGE PAYOFF VIABILITY check directly** (see below) |
| **Flood zone** | FEMA returns A/AE/V/VE | AMBER | Type 2C: "Property in FEMA flood zone {zone}; insurance + assignee disclosure impact." |
| **Crime grade drop** | grade ≥2 letters below surrounding parcels | INFO | Type 1 informational note in deal-room |
| **Price drift** | AS-IS value > 20% off contract price | AMBER | Type 2C: "RentCast AS-IS ${X} vs contract ${Y} — {pct}% gap." |
| **Memphis assignment clause** | subject in Memphis TN + standard contract | AMBER | Type 2C: "Memphis-specific assignment-clause check required (per memory hard precondition)." |

### ⭐ INV-023 cross-reference (explicit deliverable per authorization)

INV-022's PropStream lien pull is the data source for INV-023's MORTGAGE PAYOFF VIABILITY subsection (shipped `a9ebcf8`). The Q2 schema fields map 1:1 to what that check consumes:

```
PropStream lien pull populates:
  First_Mortgage_Amount   + First_Mortgage_Type (fixed | revolving)
  Second_Mortgage_Amount
  Judgment_Liens_Total
  Mechanic_Liens_Total
  Tax_Liens_Total
        ↓ summed →
  Payoff_Total  ← this is the value INV-023's payoff_headroom formula reads:
                  payoff_headroom = Contract_Offer_Price
                                    − (Payoff_Total + closing_costs + commissions)
```

`First_Mortgage_Type = revolving` is the field that triggers INV-023's severity-elevation + Type 2A "confirm current balance with listing agent" draft. Per-field provenance applies: each lien value carries `Liens_Source = propstream` + `Liens_FetchedAt`. This is the **23 Fields Ave learning** (Terrance Williams $55K Genesis revolving line vs $61,750 contract) made systematic — the data was in PropStream's records; the system just didn't compute against contract price proactively. **INV-022 v1 PropStream integration is the dependency that makes INV-023's check real rather than manual.** (Note: PropStream is v2 in the phased plan — see "sequencing tension" in Open Questions.)

---

## Q6 — Browser-automation fallback architecture

For vendors without a usable API (InvestorBase confirmed CSV/UI-only; PropStream until credentialed):

| Candidate | Cost | Reliability | Vendor-detection risk | Maintenance |
|---|---|---|---|---|
| **Claude in Chrome** | per-session compute | Good for low-volume, adapts to UI changes | LOW-MED (looks human-ish) | LOW (no brittle selectors) — but not schedulable as a Vercel cron |
| **Make.com browser modules** | Make plan + ops | Med — breaks on UI redesign | MED | MED (operator's existing stack; schedulable) |
| **Twin.so** | subscription | pre-built browser-agent surface | MED | LOW-MED |
| **Custom Playwright/Puppeteer on Vercel** | compute | brittle (selector rot) | HIGH (headless fingerprint often blocked) | HIGH |

**Decision tree:**

```
Need to pull from a vendor?
│
├─ Has a real REST API?  ──YES──► use it (RentCast, FEMA). Done.
│
└─ NO (InvestorBase, PropStream-pre-key)
   │
   ├─ Volume low + workflow still being validated?
   │     └─► Claude in Chrome — prototype, prove the pull works at all,
   │         measure how often the UI blocks. Manual-trigger only.
   │
   ├─ Workflow proven + needs scheduling?
   │     └─► Make.com browser module (operator's existing stack,
   │         schedulable, survives Vercel's no-persistent-browser limit)
   │
   └─ Vendor actively blocks automation / ToS risk?
         └─► STOP. Surface to operator as Type 2C: "InvestorBase blocks
             automation; options are (a) operator manual pull on cadence,
             (b) vendor API request, (c) accept staleness." Do NOT
             silently fall back to operator CSV (brief forbids that as
             the default).
```

**Maverick lean (from brief) confirmed sound:** prototype InvestorBase with Claude in Chrome first, migrate to Make.com if it holds. PropStream should NOT use browser automation if the $99–299/mo API tier is viable — pay for the API, it's cheaper than maintaining a scraper.

---

## Open questions for Maverick / operator

1. **InvestorBase v1 inclusion tension.** Brief constraint says "v1 MUST include InvestorBase even if browser automation." But InvestorBase has no API and browser automation can't reliably hit 900 pulls/mo. **Options:** (a) v1 includes InvestorBase via Claude-in-Chrome at low volume (on-demand per deal, not nightly), accepting it won't scale to full pipeline yet; (b) relax the v1 constraint and pull Buyer_Median on-demand only when a deal enters Negotiating; (c) operator pursues InvestorBase API access in parallel. Recommend **(b)** — Buyer_Median is needed per-deal at DD time, not in bulk nightly, so on-demand browser-pull fits the actual access pattern.

2. **Sequencing tension: INV-023 depends on PropStream liens, but PropStream is v2.** If INV-023 implementation starts before PropStream is credentialed, its MORTGAGE PAYOFF VIABILITY check has no data source. **Options:** (a) pull PropStream forward into v1 (requires operator to provision `PROPSTREAM_API_KEY` + pay API tier now); (b) ship INV-023's check with a manual-entry fallback for `Payoff_Total` until PropStream lands (mirrors INV-005's manual rehab pattern). Recommend **(b)** for consistency with the manual-fallback discipline already established.

3. **Firecrawl wiring** — RESOLVED: not a naming question. Firecrawl is validated-but-unwired; its production wiring (off-market body text + flip/distress keyword scoring per checklist 1.4-1.5) is filed as **INV-028** and scoped to v2. v1 reuses the live ScraperAPI photo path unchanged. (Q1 flag #1, corrected.)

4. **PropStream pricing** — public Core is $99/mo but the internal note says ~$299/mo for the API-capable tier (5/19). Needs a direct vendor confirmation before Q4 cost is firm.

5. **Crime vendor pick** — no canonical choice. Defer to v2; recommend evaluating CrimeGrade (matches the "grade" mental model) vs DoorProfit (bundles crime + offender + schools, real-estate-oriented).

6. **One wide table vs Listings_V1 fields** (Q2) — recommend separate `Property_Intel` table.

---

## Recommendation recap

**Option B (phased):**
- **v1:** RentCast (live) + ScraperAPI (live) + FEMA (free) + `Property_Intel` table + α trigger cron (16:00 UTC) + discrepancy surface. ~$199/mo net-new. InvestorBase on-demand via Claude-in-Chrome (per open question 1b). INV-023 payoff check ships with manual `Payoff_Total` fallback (open question 2b).
- **v2:** PropStream (once `PROPSTREAM_API_KEY` provisioned — unblocks INV-023 liens natively) + InvestorBase scaled (Make.com if browser-auto holds) + crime grade.

All federation pulls Type 1 autonomous. All discrepancies Type 2C. No "click to authorize a pull" anywhere. Every persisted datum carries a real `*_Source` — no fabrication.

---

## Authorization — 2026-05-25 (operator, relayed via Maverick)

**Option B (phased) AUTHORIZED for implementation.** Dispositions on the open questions:

- **OQ1 (InvestorBase):** Resolved **(b)** — `Buyer_Median` pulled on-demand per-deal (when a record enters Negotiating), NOT bulk nightly. Browser automation (Claude in Chrome) in v2.
- **OQ2 (INV-023 ↔ PropStream sequencing):** Resolved **(b)** — INV-023 mortgage payoff check ships with a **manual `Payoff_Total` fallback** until PropStream is credentialed in v2 (Scenario 2 operator selection).
- **OQ3 (Firecrawl):** Resolved — filed as **INV-028**; v1 reuses live ScraperAPI photo path; Firecrawl wiring is v2.
- **OQ4 (PropStream pricing):** Open — verify directly with vendor before v2.
- **OQ5 (crime vendor):** Deferred to v2.
- **OQ6 (table shape):** Resolved — separate `Property_Intel` table.

**v1 scope (authorized to build, pending Sprint-plan review):** RentCast (3 endpoints) + ScraperAPI (photos, live) + FEMA (free) + `Property_Intel` table (including the 7 INV-028 reserved fields) + α cron at 16:00 UTC + discrepancy surface.

**v2 scope:** PropStream (when credentialed) + InvestorBase (browser-auto, on-demand per-deal) + crime grade + Firecrawl wiring (INV-028).

**Two-phase discipline (mirrors INV-005):** this authorization does NOT green-light runtime code. Code surfaces a Sprint 1/2/3 implementation plan to Maverick first; only after Maverick review does any schema migration or runtime code land. This commit cycle is **documentation-only** (audit amendment + INV-028 placeholder + this authorization record).

---

## Acceptance criteria status (audit phase)

1. ✅ Q1–Q6 deliverables produced
2. ✅ Maverick/operator review → Option B authorized (above)
3. ✅ Operator selected **B** (phased)
4. ⏸️ Implementation — Sprint plan surfaced to Maverick next; runtime code is a separate commit cycle after plan approval

## Implementation progress

**Sprint 1 — SHIPPED** (`ee0791a`). Property_Intel table provisioned (`tbllf0GNjYepvnUuv`, 38 v1 + 7 reserved INV-028 fields). `lib/property-intel.ts` (field-ID map + provenance types) + `lib/maverick/property-intel-hydrate.ts` (pure helpers: eligibility, freshness window, payoff total, SFHA flood classification, price-drift, Q5 discrepancy taxonomy with revolving-mortgage RED elevation). 43 tests.

**Sprint 2 — SHIPPED** (this commit). Vendor hydration + persistence:
- `lib/federation/property-intel-store.ts` — Airtable upsert (find-by-listing-link / create / patch) + pure `buildHydrationFields` assembler (only-present fields, JSON cap, provenance).
- `lib/federation/rentcast-hydrate.ts` — `hydrateValuation` (AS-IS value + rent + comps, partial-failure isolated) + pure `rentcastBudgetAllows` guard wired to `RENTCAST_MONTHLY_CAP` (default 1000; 2 credits/hydration).
- `lib/federation/scraperapi-hydrate.ts` — reuses `collectPhotos` as-is, shapes photo set → 4 new Property_Intel photo fields.
- `lib/fema-flood.ts` — NFHL public REST (no key) + Google geocode bridge; `shouldPullFlood` caches static-per-parcel zones permanently.
- Photo fields added to schema (`Photo_Urls_JSON`/`Photo_Count`/`Photos_Source`/`Photos_FetchedAt`).

**Framing correction (per operator 2026-05-25):** earlier audit text said "read the existing `/v1/listings/sale` result instead of re-pulling." That was wrong — corrected to: **federation pulls `/avm/value` + `/avm/rent/long-term` independently from verify-listing's `/v1/listings/sale` (different endpoints, no shared cadence).** No `/api/verify-listing` modification was made or required; clean separation of concerns preserved.

**Sprint 3 — PENDING** (next cycle, after Maverick review): `/api/cron/data-federation-pull` at 16:00 UTC composing the hydrators + discrepancy surface + idempotency via `Hydration_Status`/`Last_Hydrated_At`.

---

## Standing by

Sprint 2 shipped (vendor hydrators + Property_Intel persistence, all pure logic tested, no cron yet). Awaiting Maverick review before Sprint 3 (the federation cron) lands.

---

### Sources

- [1] [RentCast Plans & Pricing](https://www.rentcast.io/pricing) · [RentCast API Billing & Pricing](https://developers.rentcast.io/reference/billing-and-pricing)
- [2] [PropStream (GetApp 2026 pricing)](https://www.getapp.com/real-estate-property-software/a/propstream/) · [PropStream](https://www.propstream.com/) — API access via 877-204-9040 / support@propstream.com. (NB: `prostream.app` "Prostream API" is a different company — do not conflate.)
- [3] [FEMA National Flood Hazard Layer](https://www.fema.gov/flood-maps/national-flood-hazard-layer) · public REST: `https://hazards.fema.gov/gis/nfhl/rest/services/public/NFHL/MapServer`
- [4] [CrimeoMeter Crime Data API](https://www.crimeometer.com/crime-data-api) · [DoorProfit API](https://api.doorprofit.com/) · [CrimeGrade Scraper (Apify)](https://apify.com/lexis-solutions/crimegrade-scraper) · [NeighborhoodScout](https://www.neighborhoodscout.com/about-the-data/crime-rates)
