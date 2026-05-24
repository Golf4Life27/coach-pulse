# INV-022 Brief — Data Source Federation Layer for DD-Phase Auto-Hydration

**Author:** Maverick (Owner's Rep)
**Date:** 2026-05-22
**Status:** BRIEFED, awaiting Code audit
**Severity:** STRATEGIC (foundational dependency for INV-023 Underwriter Agent; unblocks contract-phase autonomy)
**Pair-with:** INV-005 (manual rehab affordance), INV-020 (Gmail inbound triage), INV-023 (Underwriter Agent — primary consumer), Decision Preconditions Amendment Rule 3 (Dashboard-First Autonomy)

---

## 1. Premise

Today, DD-phase data sources are operator-memory dependent. Operator manually:
- Logs into PropStream → exports CSV → uploads to dashboard
- Calls RentCast `/v1/avm/value` if remembered
- Pulls InvestorBase smart-match buyers via vendor UI (~50/week bottleneck per memory)
- Runs Firecrawl re-scrape of listing if conditions suspected to have changed
- Cross-references state for wholesale-restrictive classification
- Pulls FEMA flood / crime grade if remembered

This violates Lost-Phone Test by definition. Operator gone for a week = no data hydration on new deals. Operator under stress = key data missing at contract signing (see 23 Fields 5/12 underwriting context).

INV-022 builds the **autonomous data federation layer** that hydrates every active DD-phase record without operator action.

---

## 2. Autonomy boundaries (Constitution Rule 3)

**Type 1 (always autonomous, no operator surface):**
- Trigger: `Outreach_Status` flips to `Negotiating` or `Offer Accepted` (detected by cron — same pattern as INV-006)
- Sequential / parallel fetch from PropStream, RentCast (3 endpoints), InvestorBase, Firecrawl, FEMA, crime API
- Write to `Property_Intel` Airtable table with provenance per field (source, fetched_at, confidence)
- Retry on transient failure (exponential backoff: 5m, 30m, 2h)
- Nightly re-pull for active DD-phase records (data freshness)
- Spine entry per pull (`event_type=build_event`, `attribution_agent=data_federation`)

**Type 2A (system drafts → operator approves):** None. INV-022 is pure data hydration; no outbound human communication.

**Type 2B (always operator-click):** None within INV-022. Downstream consumers (Underwriter Agent INV-023) may use this data for Type 2B surfacing, but the federation layer itself fires without operator gating.

**Type 2C (genuine judgment surface):**
- A pull surfaces a Material Discrepancy: e.g., PropStream owner-of-record differs from MLS listing agent's stated seller. Surfaces to operator as judgment item.
- A pull surfaces an Insurance Red Flag: property in FEMA flood zone OR low crime grade + high prior-claim density. Surfaces to operator with full data.
- A pull surfaces a Lien Discrepancy: liens > expected based on contract math. Surfaces.

These are NOT "click to authorize the pull" — the pulls ALREADY happened autonomously. These are "the pulls came back with something operator needs to know."

**Anti-pattern forbidden by Rule 3:** "Operator drops CSV into Drive folder" as fallback for API-unavailable vendor. Wrong direction. If PropStream/InvestorBase don't have native APIs, the fallback is browser automation (Claude in Chrome / Twin.so / Make.com browser nodes) driving the vendor UI — not operator manual export.

---

## 3. Forensic questions

**Q1 — Vendor API reality check.**
Inventory programmatic-access status for each data source:

- **PropStream**: Does the SaaS tier offer an API? At what cost? What endpoints exist (property lookup, comp search, owner lookup, lien search)? If no API: is the vendor UI scriptable via headless browser? Estimated cost per pull?
- **InvestorBase**: API status? Smart-match endpoint or UI-only? If UI-only: scriptable? What's the rate limit on browser-automated pulls?
- **RentCast**: API confirmed (we use `/v1/avm/value` per memory). Confirm `/v1/avm/rent`, `/v1/avm/value`, and `/v1/listings/sale` are all on the current tier.
- **Firecrawl**: API confirmed. Confirm we have `SCRAPER_API_KEY` (or whatever the env var is — INV-005 audit local-1 noted this missing from `.env.example`).
- **FEMA flood zone**: NFHL public API exists, free. Confirm endpoint + rate limits.
- **Crime grade**: Multiple vendor options (CrimeReports, SpotCrime, etc.). Identify candidate(s) and access method.

Deliverable: per-vendor access matrix + estimated cost-per-pull + fallback strategy if API absent.

**Q2 — Schema for Property_Intel.**
Design the Airtable table that aggregates federated data. Per-field provenance is critical (Decision Preconditions discipline).

Fields needed:
- `Subject_Listing_Id` (link to Listings_V1)
- For each data point: value + source + fetched_at + confidence
- Examples: `Buyer_Median_Value`, `Buyer_Median_Source` (InvestorBase / manual_operator), `Buyer_Median_FetchedAt`, `Buyer_Median_SampleSize`

Document field list with provenance metadata pattern.

**Q3 — Trigger architecture.**
INV-006 outreach-status-reconcile cron is the prior pattern. Reuse?

- α: New cron `/api/cron/data-federation-pull` runs every N min, scans for `Outreach_Status` flip events not yet hydrated, fires pulls
- β: Inline trigger from `/api/deal-action/[id]` route when Outreach_Status changes (synchronous)
- γ: Make scenario with Airtable trigger on Outreach_Status field change
- δ: All-of-above with α as backstop

Maverick lean: α as canonical pattern (mirrors INV-006), δ if Q5 reveals latency concerns.

Document chosen surface + freshness SLA (e.g., DD-phase records pulled within 5 min of status change, refreshed nightly).

**Q4 — Cost + rate-limit envelope.**
For a 100-deal/month pipeline at one initial pull + nightly refresh:

- PropStream: ~30 pulls/day. Vendor cost?
- RentCast: ~90 pulls/day (3 endpoints × 30 records). Vendor cost?
- InvestorBase: ~30 pulls/day. UI-scriptable? Cost?
- Firecrawl: ~30 pulls/day. Cost?
- FEMA: free
- Crime: variable by vendor

Total monthly data-federation cost estimate. Vendor rate-limit constraints (any vendor that caps at < 30/day blocks the architecture).

**Q5 — Material discrepancy surface.**
When a pull comes back with data inconsistent with existing record state, what's the surface?

- Owner mismatch: PropStream owner ≠ MLS listing's stated seller → surface as Type 2C judgment
- Lien presence: PropStream returns ≥1 lien → surface with named lien details, recommend operator review before contract advance
- Flood zone: FEMA returns zone A/AE/V/VE → surface with insurance impact, recommend assignee notification
- Crime grade: drop ≥2 letter grades vs surrounding properties → surface for context
- Price drift: pull comes back with `AS_IS_Value` more than 20% off contract price → surface

Document the discrepancy taxonomy + per-type severity + surface format.

**Q6 — Browser-automation fallback architecture.**
If PropStream or InvestorBase don't expose APIs:

- Claude in Chrome: drives vendor UI per-record. Bandwidth?
- Twin.so: pre-built browser agent surface. Suitable for repeating data-pull workflow?
- Make.com browser automation modules: existing in operator stack?
- Custom Playwright/Puppeteer scripts: shipped to Vercel cron?

For each candidate, document: cost, reliability, vendor-detection risk (some vendors actively block automated UI access), maintenance burden.

Recommended approach if API absent: prototype with Claude in Chrome to validate the workflow works at all, then migrate to Make.com browser modules if the vendor doesn't break the automation.

---

## 4. Resolution options

- **A** — Full Q1-Q6 audit + spec, then build all-in (PropStream + RentCast + InvestorBase + Firecrawl + FEMA + Crime)
- **B** — Phased: RentCast + Firecrawl + FEMA in v1 (all known-API); PropStream + InvestorBase + Crime in v2 (after Q1 reveals access path)
- **C** — Operator-pays-vendor-API-fees model: ship full v1 once Q1 confirms costs; operator decides per-vendor whether the value justifies the spend

Maverick's lean: **B**. Ships hydration of the canonical-API-available data sources fast, defers the harder UI-scripted vendors to v2 with full visibility into cost.

---

## 5. Constraints

- Forward-going only. No backfill of pre-INV-022 records.
- Proposal-before-commit. Q1-Q6 returned; operator picks A/B/C.
- Constitution Rule 3 (Dashboard-First Autonomy) governs. All federation pulls are Type 1 autonomous. Material discrepancies are Type 2C with full context.
- Fabrication prohibition. Every persisted data point has a real `source` field. Never fabricate "vendor unreachable but here's a guess."
- Per memory: RentCast `price` field = AS_IS value only, NEVER ARV.
- Per memory: V2.1 floor math depends on InvestorBase `Buyer_Median` as primary truth signal. INV-022 v1 MUST include InvestorBase even if it requires browser automation.
- Per memory: Memphis-specific assignment-clause check is a hard precondition; surface in discrepancy taxonomy.

---

## 6. Acceptance criteria

1. Q1-Q6 deliverables produced.
2. Operator selects A/B/C.
3. Code implements + writes tests covering:
   - Pull succeeds when vendor API responsive
   - Pull retries autonomously on transient failure (5m → 30m → 2h backoff)
   - Pull surfaces discrepancy when material inconsistency detected (e.g., lien returned)
   - Provenance correctly written for every persisted field
   - Browser-automation fallback test (if Q6 ships browser path for any vendor)
   - Idempotency: re-pull within freshness window is no-op
4. Spine entry via `maverick_write_state` (`event_type=principle_amendment`, `attribution_agent=data_federation`).
5. `AKB_MASTER_CHECKLIST.md` updated with Phase entry (likely Phase 4C — Data Federation, parallel to existing Phase 4 Hyper-Local Math).
6. `Active_Queue.md` flips INV-022 to SHIPPED.

---

## 7. Compounding payoff

Operator stated 2026-05-22: data sources (PropStream, RentCast, InvestorBase, Firecrawl) currently manual should be automated when records hit DD phase. INV-022 is the foundation INV-023 (Underwriter Agent) builds on.

The dam-break: any property entering DD phase has all relevant data hydrated within 5 minutes, refreshed nightly. Underwriter Agent (INV-023) consumes this and refuses contract advance on incomplete data. Operator's contract-phase workflow becomes: open dashboard, see fully-underwritten properties ready to sign, click signature. Contract-phase autonomy unlocked.

---

## 8. Out of scope

- Outbound data — INV-022 is intake only
- Buyer-side data hydration for dispo-phase — adjacent concept, separate workstream
- Real-time event-driven pulls (WebSocket / vendor webhooks) — v3 if vendor support emerges
- Per-vendor cost optimization (caching, deduplication across deals in same ZIP) — premature optimization for v1
