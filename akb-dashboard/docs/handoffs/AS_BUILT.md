# AS-BUILT — akb-dashboard (CONVEYOR)

> **Load this first.** It is the as-built map: entry points, data flow, where
> state lives, what is gated dark, and what is broken/unverified. Companion to
> `SYSTEM_HANDOFF.md` (the operator narrative + charter). Hard rules live in
> **[`docs/INVARIANTS.md`](../INVARIANTS.md)** — load that too.
>
> **Provenance discipline (per the CONVEYOR directive):** every claim here is
> tagged `[verified <path>]` when read this session, `[sweep]` when gathered by
> a sub-agent file-sweep and not individually re-read, or `[unknown]` when not
> verified. Do not upgrade a `[sweep]`/`[unknown]` to fact without reading it.
>
> Last updated: 2026-06-18 · prod HEAD context: branch `claude/admiring-shannon-dzfnbm`, local HEAD `a621b9b` (M7 front-half conveyor wired + capped H2 lift; builds on M6 `7f1caef`, `dff69b1`, PR #27 verify-gate `8952d8c` + PR #28 backlog-reprice `7959eaf`). **New 2026-06-18 work in §8 (M6 §8a-b, M7 §8c).**

---

## 0. Environment & ground truth

- **App:** Next.js 16 (`next 16.2.2`) on Vercel, project `coach-pulse`
  (`prj_X1pCuqzRml74iOKfNhTo4ZMG9K87`, team `team_zwFAlAQ8CyjGYcxyk7Sn6ww0`).
  `[verified — Vercel MCP list_projects/list_teams]`
- **Plan:** Vercel **Pro** (sub-daily crons deploy; e.g. `*/5`, `*/10`, `*/6h`
  are live in `vercel.json`). The note in `AGENTS.md` that says *Hobby / daily-cron
  cap* is **STALE** per the 2026-06-15 Spine entry and is contradicted by the live
  `vercel.json`. `[verified — vercel.json + Spine rec8lPEr4A7dqa3kQ]`
- **Airtable base:** `appp8inLAGTg4qpEZ`. Primary table **Listings_V1**
  `tbldMjKBgPiq45Jjs` (**4,858 records** total as of 2026-06-16 — paginated count,
  not a page slice). `[verified — lib/airtable.ts:7,9 + Airtable MCP totalRecordCount]`
- **Secrets are NOT present in the local/CI container** (`AIRTABLE_PAT`,
  `FIRECRAWL_API_KEY`, `KV_REST_API_*`, `RENTCAST_API_KEY`, `ATTOM_API_KEY` all
  absent). Local code that calls `getListing`, `probeFirecrawlBalance`, or KV will
  fail here; use the Airtable MCP (server-side auth) for read-only fetches, or the
  committed fixtures. `[verified — env probe this session]`

---

## 1. Entry-point inventory

### 1a. Crons (authoritative — from `vercel.json`) `[verified — vercel.json]`

| Schedule (UTC) | Path | What it does (one line) | Notes |
|---|---|---|---|
| `0 */6 * * *` | `/api/cron/listings-intake` | RentCast pull → dedup → **Firecrawl verify** → create (live) / report (dry) | Firecrawl burner #1; gated by `CRAWLER_INTAKE_LIVE` + verify-gate |
| `30 */6 * * *` | `/api/admin/freshness-reverify?...&zips=48224,48219,48204,48205,48213,48227` | Firecrawl liveness re-verify on a Detroit ZIP cohort | Firecrawl burner #2; staggered +30m so the two don't share a rolling hour |
| `0 16 * * *` | `/api/cron/h2-outreach?dry_run=false&limit=10` | First-touch opener SMS (Quo) | **HARD-DISABLED in code** — returns 503 before any send (see §4) |
| `30 13 * * *` | `/api/cron/parked-followup?apply=1&limit=20` | Follow-up / dispose aging non-responsive | Sends gated by `FOLLOWUP_SEND_ENABLED` |
| `0 5 * * *` | `/api/cron/underwrite-v21-fresh?apply=1&limit=12` | Compute `Your_MAO_V21` / `Investor_MAO_V21` on fresh records | (sub-agent claimed unscheduled — it IS scheduled, line 64) |
| `*/10 * * * *` | `/api/cron/scan-comms` | Poll Quo for replies, triage, create proposals | `[sweep]` |
| `*/10 * * * *` | `/api/cron/quo-reconcile` | Reconcile `Last_Inbound_At`/`Last_Outbound_At` vs Quo | `[sweep]` |
| `*/15 * * * *` | `/api/cron/zip-approval-reply-scan` | ZIP_Registry approval YES/NO SMS workflow | `[sweep]` |
| `*/5 * * * *` | `/api/admin/url-backfill?apply=1&limit=10` | Backfill `Verification_URL` via Firecrawl (1–2 cr/rec) | Minor Firecrawl spend `[sweep]` |
| `*/5 * * * *` | `/api/admin/appraiser-backfill?...rehab_ready&limit=3` | Route Rehab_Ready records through vision + ARV + underwrite | `[sweep]` |
| `20 * * * *` | `/api/cron/quo-sync?limit=40&hours_back=24` | Append inbound Quo messages to `Verification_Notes` | `[sweep]` |
| `40 * * * *` | `/api/cron/gmail-sync?limit=40&hours_back=48` | Append inbound Gmail replies to matched listing + (dark) catch-all | **GATED DARK** by `INBOUND_CAPTURE_LIVE` — returns `{watched:true}`, zero writes, until flipped; staggered off quo-sync's `:20` `[verified — route:45-48]` |
| `0 9 * * *` | `/api/cron/propose-actions` | Template proposals for silent listings (no Claude calls) | `[sweep]` |
| `0 11 * * *` | `/api/scan-replies` | scan-comms alias | `[sweep]` |
| `0 8 * * *` | `/api/admin/recompute-agent-prior-counts` | Recompute `Agent_Prior_Outreach_Count` | `[sweep]` |
| `0 12 * * *` | `/api/agents/pulse/scan` | Pulse detector cycle (stale-data, supply-floor, firecrawl-402…) | `[sweep]` |
| `0 14 * * *` | `/api/cron/outreach-status-reconcile` | Auto-transition Outreach_Status when `Envelope_ID` set | `[sweep]` |
| `0 15 * * *` | `/api/cron/rehab-vision-retry` | Re-run vision on manual rehab; flag drift, never auto-overwrite | `[sweep]` |
| `0 16 * * *` | `/api/cron/data-federation-pull` | Hydrate Property_Intel (RentCast/ScraperAPI/FEMA) | `[sweep]` |
| `0 6 * * 1` | `/api/cron/anchor-calibration` | Weekly per-market anchor calibration → KV | `[sweep]` |
| `30 5 * * *` | `/api/admin/sold-feedback` | Roll up agent-reported sale prices by zip → KV `sold_feedback:latest` | Opener map dark until `H2_SOLD_FEEDBACK_MAP=1` (§8q) |
| `25,55 * * * *` | `/api/cron/dispo-trigger` | Contract executed + no blast → publish deal page, email buyer shortlist | Email only; spread gate blocks money-losers (§8q) |
| `5 13 * * *` | `/api/cron/option-tripwire` | T-5 / T-2 / lapsed option-deadline SMS + action item, once per stage | Lapsed window 14 days; KV dedupe 30d (§8q) |

### 1b. Key routes for the deal pipeline `[verified — read this session unless tagged]`

- **`/api/admin/opener-dry-run`** — cohort opener eyeball: runs `priceOpenerWithSeed`
  over stored ARV/list/rehab, reports the opener it WOULD send. Read-only, no paid
  call. `[verified — app/api/admin/opener-dry-run/route.ts]`
- **`/api/admin/backlog-reprice`** — in-place re-verify + re-price of MI Review
  records with blank `Rough_Opener_Amount`; Firecrawl liveness FIRST, then seed/65%
  price; `shouldHaltVerify` halts before spend on a ≤0 wallet; no auto-promote, sends
  stay dark. `[verified — Spine rec8HBy0xERPjWeyz + route grep]`
- **Orchestrator gate routes** `[sweep]`: `/api/orchestrator/run-gate` (run a gate,
  return `GateRunResult`, no stage write), `/api/orchestrator/advance-stage` (run gate
  **and** write `Pipeline_Stage`), `/api/orchestrator/gate-status/[recordId]`,
  `/api/orchestrator/pre-emd-evaluate`.
- **NEW this session — the dry-run trace harness** (see §6).

---

## 2. The gate spine (orchestrator) `[verified — lib/orchestrator/*]`

`runGate()` (`lib/orchestrator/gate-runner.ts`) is the live execution path: collect
the data sources every checklist item declares → **fetch them live** (Airtable
listing/deals/buyers, Quo, Gmail, RentCast CMA, KV audit) → build a `GateContext` →
run each item's pure `CheckFn` → compose a `GateRunResult` → **write one composite KV
audit entry**. The check functions themselves are pure (no I/O); all fetching +
the audit write live in `gate-runner.ts`.

Five gates, in live pipeline order (`lib/config/gates/*.json` + `*-checks.ts`):

| # | Gate | stage_from → stage_to | Reads (sources) |
|---|---|---|---|
| 1 | `pre_outreach` | **priced** → outreach_ready | `airtable_listing` only (14 items, PO-01…PO-14). **M7:** edge was the illegal `verified→outreach_ready` skip the engine refused (stranding every verified record); now `priced→outreach_ready`. See §8c. |
| 2 | `pre_send` | outreach_ready → outreach_sent | `airtable_listing` (PS-01 needs `ARV_Validated_At`) |
| 3 | `pre_negotiation` | outreach_sent → negotiating | listing + `quo_thread` + `gmail_thread` + `live_listing` + `cma` |
| 4 | `pre_contract` | negotiating → contract | listing + `pa_document` (DocuSign) + `buyer_pipeline` |
| 5 | `pre_emd` | contract → emd | listing + `property_intel` + `airtable_deal` |

**Pre-Outreach config** (`lib/config/gates/pre_outreach.json`): blocked MLS statuses
`{Off Market, Sold, Pending, Withdrawn, Expired}`; restricted states `{IL, MO, SC,
NC, OK, ND}`; SFR-only; beds ≥ 2; sqft ∈ [500, 5000]; list ∈ [3500, 500000]; flip
score < 4; verify freshness ≤ 72h; distress = DOM ≥ 60 OR ≥1 price drop (warn-only).

**`pa_document` (DocuSign) is unwired in production (Phase 1)** — `gate-runner.ts`
`fetchSource("pa_document")` rejects (caught by the fan-out), so Gate-4 items resolve
to `data_missing` — the deliberate FAIL-CLOSED block (no PA advances to contract).
**M7 2026-06-18:** the reject message was de-scared and a clean operator hand-off added
(`pre-contract-handoff.ts`) so a lead at the wall surfaces to the operator (Manual
Review), never a crash. See §8c. `[verified — gate-runner.ts:304-311]`

---

## 3. Pricing `[verified — lib/per-market-pricer.ts, lib/opener-pricing.ts, lib/rough-opener-ceiling.ts, lib/config/markets.json]`

One code path for both the live intake loop and the read-only eyeball:
`priceOpenerWithSeed` → `priceOpener` → `computeRoughOpenerCeiling`.

- **ARV buy-box path (the ONLY send basis):** `opener = anchor × (ARV × arv_pct_max
  − rehab − fee)`. `ARV` = ZIP renovated `$/sqft` (`ZIP_ARV_Seed`) × subject sqft —
  it prices THE house.
- **Fallback: HOLD (operator 2026-06-28).** The flat **65%-of-list** rail is
  **RETIRED** — it produced the 18681 Blackmoor catastrophe ($84.5k text = 0.65 ×
  $130k list on a ~$40k house). With no trusted ARV value basis the pricer now
  returns a **null opener** and the record routes to operator review. We never text
  a number anchored to the seller's list price. (`computeRoughOpenerCeiling` →
  `ceiling: null, source: "hold_no_value_basis"`; `priceOpener` →
  `opener: null, basis: "hold_no_value_basis"`.)
- **Guards (now HOLD, not 65%):** ARV-sanity (ARV < list ⇒ distrust as as-is value ⇒
  HOLD, flag re-seed); low-opener floor (`max(30%×list, $10,000)` ⇒ HOLD micro-opener
  for review); never-over-list cap (`0.85 × list`, floored — operator 2026-07-01, set
  equal to the `>85%` send rail so a capped opener never trips it; the one place a
  fraction of list is used, and only to *clamp down* a value-anchored opener when
  ARV ≫ list, never to fabricate one). `fee` default `DEFAULT_WHOLESALE_FEE = $5,000`.
- **Market config** (`markets.json`, matched by ZIP prefix then state): `detroit_mi`
  `arv_pct_max 0.6461` (zip `48`); `memphis_tn 0.7175` (zip `38`, **paused** per
  operator); `dallas_tx 0.5883`; `san_antonio_tx`/`houston_tx` have **no `arv_pct_max`**
  (→ **HOLD**, no autonomous opener until a buy-box is configured).
- **ARV seed** comes from Airtable `ZIP_ARV_Seed`; the dry-run harness mocks it
  `null`. Seeded ZIPs (Spine 6/15): `48202/48203/48205` STRONG, `48201/48204/48206`
  DONT_PRICE.

**What the cohort prices to (new doctrine):** the 3 dry-run fixtures all **HOLD**
via *different* routes — no-ARV (rec00), ARV<list distrusted (rec02), buy-box ceiling
below floor (rec07) — instead of the old ~65%-of-list over-offer. Over the 81 real
with-ARV records: **33 produce a value-anchored SEND, 48 HOLD** (they were being
list-anchored before). Many of the 48 carry a stored ARV *below* list (contaminated
as-is values, Hole C); the live `ZIP_ARV_Seed` path supplies clean renovated `$/sqft`
and should lift the send rate as ZIPs seed. **Volume-recovery dials (operator's call,
not yet built):** lower the low-opener floor to send real cheap-market numbers; add a
market-median `$/sqft` fallback to value-anchor un-seedable ZIPs instead of holding.

---

## 4. Known-gated list — what is holding the system DARK

| Flag (env) | Default | Where read / enforced | Effect |
|---|---|---|---|
| **`H2_OUTREACH_HARD_DISABLE`** | unset ⇒ `!== "false"` ⇒ **disabled** | `app/api/cron/h2-outreach/route.ts:171` `[verified]`; `app/api/outreach-fire/route.ts:110` `[sweep]` | **Hard kill on opener SMS** — route returns 503 before send. Added after a 2026-06-05 unauthorized-send incident. The ONLY thing standing between the system and live texts. **M7:** even once lifted, the send-cap meters the lift (next row) — the 109-at-outreach_ready can't fire at once. |
| `H2_OUTREACH_LIVE` | unset ⇒ dry-run | `h2-outreach/route.ts:190` `[sweep]` | Even with `?dry_run=false`, stays dry unless `=="true"`. |
| `FOLLOWUP_SEND_ENABLED` | unset ⇒ off | `parked-followup/route.ts:85` `[sweep]` | Parked follow-up SMS never fire. |
| `CRAWLER_INTAKE_LIVE` | unset ⇒ dry-run | `listings-intake/route.ts:282` `[sweep]` | No Airtable creates from intake. |
| `CRAWLER_AUTO_PROMOTE_LIVE` | unset ⇒ Review | `listings-intake/route.ts:300` `[sweep]` | Crawled records land in Review, not Auto Proceed. |
| `CRAWLER_AUTOSEED_LIVE` | unset ⇒ skip | `listings-intake/route.ts:294` `[sweep]` | No renovated-comp seed pulls / opener writes ⇒ **`Rough_Opener_Amount` stays blank cohort-wide** (confirmed: none of the records sampled this session had a stored opener). |
| `MAVERICK_CRON_ENABLED` | unset ⇒ 503 on cron-auth | multiple crons `[sweep]` | Cron auth gate. |
| `EXCLUDED_STATES` (code const) | `{IL,MO,SC,NC,OK,ND}` | `lib/crawler/intake-filter.ts:30` `[verified]` + Pre-Outreach PO-05 `restricted_states` `[verified]` | Excluded-state listings are filtered at intake (the table has **0** NC records) and PO-05 blocks them at the gate. |
| **`INBOUND_CAPTURE_LIVE`** | unset ⇒ off (watched-first) | `lib/inbound/flag.ts:10` `[verified]`; enforced `gmail-sync/route.ts:45-48` `[verified]` | M6 inbound capture stays DARK: `gmail-sync` returns `{watched:true}` with zero writes; the dark `quo-inbound` webhook + `Unmatched_Replies` catch-all writes are suppressed. Flip AFTER a watched run (see §8a). |
| `BUYER_MEDIAN_LIVE` | unset ⇒ off | `lib/buyer-intel/buyer-median.ts:27` `[verified]` | DD-3 (`pre-emd-gate-live.ts:48`) + ingest read the live `Buyer_Median_ZIP` store only when `=="true"`; else fall back to the in-code seed list. Store is seeded (15 rows) but read-gated (see §8b). |
| **`H2_COVERED_ZIPS` / `H2_MAX_SENDS_PER_RUN` / `H2_MAX_SENDS_PER_ZIP`** | unset ⇒ **0 sends** / 5 / 2 | `lib/outreach/send-cap.ts` `[verified]`; enforced in `h2-outreach/route.ts` live dispatch | **M7 the safety meter on the H2 lift.** FAIL-CLOSED: empty `H2_COVERED_ZIPS` ⇒ zero sends. Per-run/per-zip caps clamp to hard code ceilings (25/10). Applies only AFTER the hard-disable is lifted, live only; a dry run previews it in the response `send_cap` block. See §8c. |

> **Manual-review parks:** crawled/un-promoted records sit in `Outreach_Status =
> Review` / `Parked` (Airtable singleSelect) awaiting operator action; auto-promote is
> off (`CRAWLER_AUTO_PROMOTE_LIVE`). `[verified — MCP record sample]`

---

## 5. State locations

| Kind | Where | Key/Detail |
|---|---|---|
| Listings / deals / buyers | **Airtable** base `appp8inLAGTg4qpEZ` | Listings_V1 `tbldMjKBgPiq45Jjs` `[verified]`; Deals, Buyers via `getDeals`/`getBuyers` `[verified]`; field→prop map `lib/airtable.ts:152 LISTING_NAME_MAP` `[verified]` |
| Operator decision log / build events | **Airtable Spine** `tblbp91DB5szxsJpT` | narrative + `event_type` audit `[verified — MCP this session]` |
| Buyer median by ZIP+track | **Airtable** base `appp8inLAGTg4qpEZ` | `Buyer_Median_ZIP` `tbleoqYRBmnJq5V0Z` — **15 rows** (9 flipper `investorbase_auto` + 6 landlord `investorbase_manual`); read via `getZipBuyerMedian`, min-n gate (`compCount≥20`) on every read `[verified — MCP + track-aware-underwrite.ts]` |
| Inbound replies w/ NO matched listing | **Airtable** base `appp8inLAGTg4qpEZ` | `Unmatched_Replies` `tblh4m0hG7KoZ7dN5` — fail-closed catch-all; written by the dark `quo-inbound` webhook when `INBOUND_CAPTURE_LIVE` is on `[verified — operator + lib/inbound/store.ts]` |
| Firecrawl rolling-hour spend | **Vercel KV** | prefix `fc:spend:h:{hourIndex}`, 2h TTL, cap 800/hr `[verified — firecrawl-circuit-breaker.ts:34]` |
| Per-market anchor | **Vercel KV** | `market:anchor:{marketId}` (Detroit 0.90 launch) `[sweep]` |
| H2 run lock / dispatch claim | **Vercel KV** | `h2:run:lock`, `h2:dispatch:{recordId}` `[sweep]` |
| Audit log | **Vercel KV** | list `agent:audit` (FIFO cap) `[sweep]` |
| OAuth tokens/codes (Maverick) | **Vercel KV** | `maverick:oauth:{access,refresh,code,family}:*` `[sweep]` |
| D1 / SQLite | **none** | no D1 references found `[sweep]` |

---

## 6. NEW this session — the single-property dry-run trace harness

The thing that ends the "can't verify before deploy" loop: walk one real listing
through the **existing** gates + pricer with **all external I/O mocked**, **zero
writes, zero sends**, deterministic.

- **Core:** `lib/orchestrator/dry-run-trace.ts` — `traceListing({recordId, listing,
  mocks?, now?})`. Pure + synchronous; mirrors `gate-runner.ts` steps 4–5 (run
  checks + compose status) **minus** the live fetch and the audit write. Composes
  `priceOpenerWithSeed` for the opener. `proveNoNetwork()` wraps `globalThis.fetch`
  and **measures** that zero calls happen during a run.
- **Formatter:** `lib/orchestrator/dry-run-format.ts` — human-readable report.
- **Fixtures:** `lib/orchestrator/__fixtures__/{rec00IPPd92pEKnbl,rec02SiPx4WVUOrgW,rec07YAC9KOwr6iZv}.json`
  — three real Listings_V1 records, read-only via Airtable MCP, mapped per
  `LISTING_NAME_MAP`.
- **Smoke test / runner:** `lib/orchestrator/dry-run-trace.test.ts` — asserts zero
  external calls (stubs `fetch` to throw), zero writes, zero sends, 5 gates with
  decisions, opener computed; pins known decisions (drift guard).
- **Run it:** `npm run dry-run-trace` (no secrets needed) prints all three traces.

If `gate-runner.ts` status logic changes, update `evaluateGateChecks()` to match
(the smoke test pins the shared decisions).

---

## 7. Known-broken / unverified (honest list)

- **Firecrawl breaker fails-OPEN on a KV/store outage** — `firecrawl-circuit-breaker.ts`
  `firecrawlSpentRecent` returns 0 when KV is down ⇒ the breaker never trips
  (`:20-21,80-81`). The dedicated **fail-narrow `[48227]` allowlist fix is NOT shipped
  in the breaker** `[verified — M7 read 2026-06-18]`. Backstops that DID ship: the
  per-run scrape budget (~1000) + the intake ZIP-scope (seeded/priceable only,
  fail-narrow on the ZIP source) + `shouldHaltVerify` on a known ≤0 balance. The H2 SMS
  path spends no Firecrawl — this risk is on the autoseed/intake path. **Verify KV
  health before turning up autoseed/intake volume.**
- **Today's exact Firecrawl balance is `[unknown]`** — no `FIRECRAWL_API_KEY` this
  session and Vercel runtime logs were empty for the window. Most recent production
  evidence: ~26,000 credits, operator-topped-up 2026-06-15 (Spine); last machine
  probe 14,093 on 2026-06-09. The retry-loop that drained it to −821 is killed at
  root (PR #26 widen + PR #27 verify-gate, both in prod). See Step 0 of the session
  report.
- **`Pipeline_Stage` = `fldJt2pSCHiXqBxwj` (RESOLVED M7)** — clean gate-aligned values
  (intake/verified/priced/outreach_ready/…); the earlier fixture uncertainty is moot.
  M7 found + fixed the `priced=0` defect this exposed (the stage was never written and
  Gate 1 declared an illegal skip) — see §8c.
- **Cron rows tagged `[sweep]`** in §1a were gathered by a sub-agent and not
  individually re-read; schedules are verified against `vercel.json`, the one-line
  summaries are not.
- **`pa_document` / DocuSign** path is intentionally unwired (Phase 1) — Gate 4
  cannot pass until it lands.
- **Send paths (Quo, follow-ups, DocuSign) were NOT exercised** this session by
  design (out of scope). Their disable flags are documented in §4 from a sub-agent
  sweep + two spot-verifies; the others are `[sweep]`.

---

## 8. NEW 2026-06-18 — M6 inbound capture (DARK) + Buyer_Median go-live & cleanup

### 8a. M6 inbound capture — app-side, gated dark (Option 1 topology)

Reply-capture is built **app-side** and held DARK behind `INBOUND_CAPTURE_LIVE`
(watched-first). **Live Make L3 is untouched** — no re-point until the operator says so.

- **Flag:** `lib/inbound/flag.ts:10` (`INBOUND_CAPTURE_LIVE === "true"`). `[verified]`
- **Gmail leg (live cron, dark writes):** `/api/cron/gmail-sync` (`40 * * * *`,
  `?limit=40&hours_back=48`) appends inbound Gmail replies to the matched listing;
  flag off ⇒ returns `{watched:true}`, writes nothing. `[verified — route:45-48]`
- **Catch-all:** `Unmatched_Replies` (Airtable `tblh4m0hG7KoZ7dN5`) — fail-closed
  surface for inbound with **no matched listing** (an unknown phone can't be matched
  by the per-known-phone poll path, so it would otherwise vanish). Written via
  `lib/inbound/store.ts`. `[verified — operator + store.ts]`
- **SMS leg (dark scaffold):** `/api/webhooks/quo-inbound/route.ts` parses a Quo
  inbound webhook → match → capture-or-catch-all. Goes live ONLY when the operator
  (1) re-points Quo's webhook here AND (2) sets `INBOUND_CAPTURE_LIVE=true`.
  `[verified — route:6]`
- **Lib + proof:** `lib/inbound/{types,match,catch-all,capture,webhook-parse,
  gmail-capture,store,flag}.ts`; `lib/inbound/inbound.test.ts` proves
  unmatched→catch-all with **no live Quo**. `[verified]`

### 8b. Buyer_Median go-live + cleanup

- **Store live-read** gated by `BUYER_MEDIAN_LIVE` (default OFF; `buyer-median.ts:27`).
  DD-3 (`pre-emd-gate-live.ts:48`) reads the track-aware median when on, else the
  in-code seed list. `[verified]`
- **Min-n read gate (fail-closed), 2026-06-18:**
  `track-aware-underwrite.loadUnderwriteContextForListings` now enforces the SAME
  `compCount >= BUYER_MEDIAN_MIN_N (20)` gate DD-3 uses — a sub-threshold or
  comp-count-less stored median is surfaced as an `errors` entry, **never silently
  used as a buyer ceiling**. Closes the previously-ungated read path. `[verified —
  track-aware-underwrite.ts]`
- **48227 flipper $150k row DELETED** (2026-06-18): resale-trap, no acquisition data
  to re-base ⇒ INSUFFICIENT/manual review beats a known-wrong ceiling. Store now
  **15 rows**. The 48227 landlord $55k seed stays but has no comp count ⇒ gated by
  the min-n rule on every read (DD-3 + underwrite). `[verified — Airtable MCP delete
  + re-read]`

### 8c. M7 — front-half conveyor wired + capped H2 lift (built, OFF)

**Live conveyor census (2026-06-18, 4,858 records, `Pipeline_Stage`):** blank 1,226 ·
intake 738 · verified 209 · **priced 0** · outreach_ready 109 · outreach_sent 64 ·
negotiating 5 · under_contract 0 (rest ~2,507 dead/responded). Manual queues
(`Outreach_Status`): Review 1,093 · Parked 319 · Manual Review 47. `[verified — Airtable MCP]`

**The `priced=0` defect — root-caused + fixed.** Lifecycle is
`intake→verified→priced→outreach_ready` with a strict forward-one-step legal-edge guard,
but NOTHING wrote `priced`: no gate targeted it, the legacy-derive never emits it, the
opener-write set `Rough_Opener_Amount` without advancing the stage. So Gate 1 declared
the **illegal** `verified→outreach_ready` skip the sole-writer engine refuses — every
`verified` record was stranded (the 109 at outreach_ready got there only via
unconstrained initial-assignment backfill).
- **The missing writer:** `lib/pipeline-state/price-transition.ts` — the opener-write IS
  the `priced` checkpoint; routes through the SOLE WRITER engine (legal-edge + audit
  intact); legal from null/verified, noop at priced, FAIL-CLOSED on a skip. Wired into
  `listings-intake.createIntakeListing`, gated by the opener ⇒ `CRAWLER_AUTOSEED_LIVE`. `[verified]`
- **Gate 1 edge fixed:** `pre_outreach.json` `stage_from: verified→priced`. `[verified]`
- **Proof:** `lib/pipeline-state/front-half-flow.test.ts` — a synthetic Detroit lead
  traverses verified→priced→outreach_ready (real engine edges) → Gate 1 PASS (real
  checks) → operator surface, + a regression guard that the skip stays illegal.
- **No backlog migration:** the 209/109 stay put; auto-promote stays OFF (operator promotes).

**Hop-7 clean operator hand-off (front-half terminus).** DocuSign stays unwired (hop 7
OUT of scope). The scary `pa_document` throw is de-scared (fail-closed `data_missing`
preserved); `lib/orchestrator/pre-contract-handoff.ts` surfaces a lead blocked only by
the unwired DocuSign to the operator (Manual Review, "awaiting operator signature") vs.
a real rule failure. The belt reaches the operator cleanly, never crashes.

**Capped H2 lift — BUILT, LEFT OFF (Part 2).** `lib/outreach/send-cap.ts` hard-bounds a
live H2 run (§4 flags). FAIL-CLOSED (empty `H2_COVERED_ZIPS` ⇒ zero); tight defaults
5/run, 2/zip, clamped to 25/10. `H2_OUTREACH_HARD_DISABLE` UNTOUCHED. The census's
109-at-outreach_ready can no longer fire at once on a lift; a dry run previews the cap
in the response `send_cap` block. `[verified — 193 files / 2631 tests green, tsc clean]`

---

## 8d. NEW 2026-07-11 — H2 bump lane (#33)

Day-3/day-7 re-touch of SILENT v2 first-touch threads (the cheap send
multiplier). `lib/h2-outreach/bump-lane.ts` (pure, tested) +
`/api/cron/bump-followup` (2 daily slots: 16:15Z / 20:15Z, limit 10) +
`.github/workflows/bump-send.yml` (on-demand catch-up dispatch).

- **Sticky number from the DELIVERY STAMP only** (`[H2 sent …] Quo msg …:`
  in `Verification_Notes`) — never a field (P3 drift evidence). No stamp →
  no bump, fail closed. Max 2 bumps (`Follow_Up_Count`), then silence.
- **Same rails as first touch:** master `H2_OUTREACH_HARD_DISABLE`, live
  needs `H2_OUTREACH_LIVE` + `STOP_OPT_OUT_LIVE` + `?dry_run=false`, send
  cap (auto coverage), quiet hours, KV run lock + per-attempt claims,
  positive-confirmation polling, carrier-failure auto-quarantine, and the
  >85%-of-list rail re-checked against the CURRENT list price. Scoped kill:
  `H2_BUMP_DISABLE=true` darkens bumps without touching first touch.
- **Forward-only:** `Source_Version` v2 gate; ANY inbound → the reply lane
  owns the thread; agents in live threads are never robo-bumped.
- **Freshness-reverify re-admission, budget-partitioned:** bump-waiting
  Texted records rejoin the re-verify pool (`isBumpReverifyCandidate` —
  only when the next bump lands inside the 48h window) at ≤40% of each
  batch (`partitionReverifyBatch`); core supply keeps priority. Per spine
  recFYBbF5H9YU1GWm ("re-admit THEN, budget-partitioned").

## 8e. NEW 2026-07-11 — Frontier rotation governor (#37)

The registry already held **88 ZIPs / 9 metros**, but the belt crawled only
~4-6/day (one daily run × static cap 6) — a ~15-day sweep with Detroit core
ZIPs stale since 6/22, while the RentCast plan ran far under budget.

- **`lib/crawler/frontier-governor.ts`** (pure, tested): daily crawl budget
  = (estimated remaining ÷ days left in cycle) − reserve (fallback:
  plan-pro-rata, can never overshoot); per-run cap clamps to the unspent
  daily allowance (KV meter `rentcast:intake:calls:<date>`, advisory).
  ~30 crawls/day ⇒ ~3-day rotation over the ~85 actionable ZIPs — the
  frontier shape, derived from the plan instead of an env knob.
- **Intake route**: `ZIPS_PER_RUN` default 6→10; 3 daily slots (13:00Z +
  17:20Z + 21:20Z) each followed by a seed-sweep (producers before
  consumers, same day: 13:35Z / 17:50Z / 21:50Z). Zero-ZIP responses now
  disambiguate `daily_crawl_budget_spent` (healthy pacing) from real
  misconfiguration.
- **Paused-market crawl leak FIXED**: Memphis rows sat tier=active, so the
  belt kept buying RentCast calls on a market paused at contract (38109
  burned a call 7/09). Intake now applies the same `isActionableMarket`
  gate the send path uses.
- **`/api/cron/frontier-rotation`** (weekly, Mon 07:10Z, apply=1):
  staged→launch promotion bounded by sustainable capacity (dailyBudget ×
  3-day cycle) — autonomous per the UNLEASH ruling; zero-yield ZIPs become
  `frontier_retire` PROPOSALS (never auto-paused — the `*_30d` registry
  stats are latest-run snapshots, not 30-day evidence).

## 8f. NEW 2026-07-11 — Forward-only gauge truth (#38)

The Forward Ruling encoded in code: **measurement surfaces count v2+
inventory only**. `lib/forward-inventory.ts` (`filterForwardInventory` /
`forwardInventorySplit`) is the one place the rule lives.

- **Pulse scan** (`/api/agents/pulse/scan`): the detector input pool
  (previously `getActiveListingsForBrief`, era-blind) is filtered to v2;
  the response reports `legacy_rows_dropped` so the gauge proves it.
- **`getActiveVerificationUrlCoverage`**: formula now requires
  `Source_Version = v2` — coverage % describes workable inventory.
- **freshness-reverify `livenessUnknown`**: v2-era only (an unstamped
  legacy row is a fenced ghost; a verify credit on it buys nothing).
- **Deliberately NOT filtered**: reconcile/sync paths (quo-sync,
  gmail-sync, quo-reconcile, webhook match pools), dedup/prior-contact
  indexes, and the sentinel reply queue — inbound on ANY thread revives it
  (Mahmoud/Memphis class stays fair game).

## 8g. NEW 2026-07-11 — P2 done-gate on appraiser-backfill (#35)

The */5-min `appraiser-backfill?selection=rehab_ready&limit=3` cron fired
ALL THREE legs (ARV/ScraperAPI, rehab/Anthropic vision, rent/RentCast) on
every eligible record every pass — and one permanently-missing leg kept a
record eligible forever (reccyLTGRZzMmbe2w: 5 identical vision reads,
conf 42, rehab_mid $51,183).

- **`lib/admin/p2-done-gate.ts`** (pure, tested): per-leg idempotency (a
  completed leg never re-buys its call); the rehab leg gets exactly ONE
  confirmation read — two agreeing reads (conf equal + mid within ±$5,
  env `P2_STABLE_REHAB_DELTA_USD`) mark the record STABLE in KV
  (`p2:rehab:stable:<id>`, 30d TTL) and the vision leg never fires again;
  a leg erroring 5× consecutively (env `P2_LEG_FAILURE_CAP`) is benched
  (KV, 7d TTL) instead of looping. KV unreachable → any completed read is
  treated as done (fail toward NOT spending). `force=1` overrides all.
- **Burn quantification**: apply response + audit carry `p2_done_gate`
  (calls_avoided by vendor, legs_skipped, stable_marked); dry-run
  `eligible_sample` previews each record's `leg_plan`.

## 8h. NEW 2026-07-22 — Outreach volume scaling: chew-and-move-on frontier + send ramp

Operator /goal: raise outreach volume (1 send 7/21, 6 sends 7/22) while keeping
every math safeguard. Root causes found: (a) ZIP_Registry frozen at 88 ZIPs / 9
metros with ZERO staged rows — the #37 promotion machinery had nothing to promote;
(b) the flat capacity model priced every ZIP at a 3-day recrawl forever, so the
registry saturated its own budget and the frontier could never expand; (c) dead
weight — 6 paused Memphis ZIPs held capacity seats and ~21 opener-HOLD TX ZIPs
recrawled at full pace despite being unable to price/send; (d) intake env-clamped
to ~30 crawls/day (3 slots × 10) below the budget governor's allowance; (e) send
caps defaulted 5/run × 6 slots = 30/day ceiling against a ruled 100/day supply
target.

Shipped (all pure logic unit-tested; spend brakes unchanged or tightened):

- **Tiered recrawl cadence** (`lib/crawler/zip-rotation.ts` `selectDueZipsTiered`,
  `recrawlCycleHours`): never-crawled ZIPs sweep first (a fresh metro's standing
  aged-DOM backlog is the highest-yield crawl there is); producing ZIPs keep the
  base 24h eligibility; sustained-zero-yield "chewed" ZIPs decay 72h→168h via
  `Below_Threshold_Streak_Days` (now maintained by the intake stats write-back);
  opener-HOLD markets idle at 336h. Chew through, move on, come back later.
- **Cost-weighted frontier capacity** (`lib/crawler/frontier-governor.ts`
  `zipDailyCallCost`): a chewed ZIP costs 1/7 call/day, opener-HOLD 1/14, vs 1/3
  producing — so budget freed by chewed metros converts directly into promotion
  seats. Paused-market rows (Memphis) excluded from capacity entirely.
- **Expansion auto-stage** (`lib/config/expansion-metros.json` +
  `lib/crawler/frontier-stage.ts`): 24 curated disclosure-state distressed metros
  (~150 ZIPs: OH/MI/IN/GA/AL/TN/PA/WI/KY/MD) feed tier=staged rows in config
  order — one metro at a time — via the frontier-rotation cron (now 2×/week).
  Restricted + non-disclosure states re-filtered in code; staged rows spend $0;
  promotion stays budget-capacity-bounded. Philadelphia/NY deliberately excluded
  (regulatory); config is operator-editable.
- **Intake throughput** (vercel.json): 3→6 listings-intake slots + 2 seed-sweep
  slots. The KV crawl meter + budget governor still bound daily RentCast spend —
  slots widen throughput, never spend.
- **Send ramp + NEW daily send brake** (`lib/outreach/send-cap.ts`): per-run
  default 5→12, per-zip 2→3 (ceilings 25/10 unchanged); h2-outreach 6→8 slots,
  queue-scan limit 10→25. NEW `H2_DAILY_SEND_CAP` KV meter (default 100 = the
  ruled supply target, ceiling 150) clamps every run to the unspent daily
  allowance — the day is bounded no matter how many slots fire. INVARIANTS §7
  updated.

Unchanged safeguards: value-anchored opener + all HOLD guards, never-over-list
clamp ≤ send rail, distress-sourcing gate (tier-8 doctrine #151), Firecrawl
breaker + hourly cap, RentCast quota gate, restricted-state exclusions, Memphis
pause, H2 hard-disable master kill, per-record idempotency + run mutex.

## 8i. NEW 2026-07-31 — Reply classification persists; the reply funnel becomes computable

**The hole.** `lib/reply-triage.triageSellerReply` has classified every genuine
inbound since it shipped, and nothing ever wrote the answer down. The label
reached three lossy places only: a `Verification_Notes` prose blob
(scan-replies), a `jarvis_reply` proposal (scan-comms — a queue ITEM, consumed
then gone), and the 6-way `Outreach_Status`, which collapses ten distinct
classifications onto "Response Received". **Measured: of 121 records carrying
`Last_Inbound_At`, exactly 3 had a classification recoverable from note prose.**
So the only question that matters — reply rate 11.5%, contract rate 0.1%, so
WHERE do threads die? — was unanswerable without re-reading raw Quo by hand.

**Shipped** (branch `claude/outbound-text-targeting-f3h19g`, commit `32c5656`;
3601 tests green, `tsc` clean — **not yet merged**):

- `lib/inbound/reply-classification.ts` (pure) — builds the persisted triple.
  Stamps the **inbound's own** timestamp, not now, so a backfill records
  history instead of relabelling it. Name-keyed + id-keyed variants (scan-comms
  writes by name, scan-replies by id).
- `scan-replies` now calls `triageSellerReply` (one classifier, and it yields
  `decisionKind`) instead of `classifyReply` + `determineNewStatus`.
- `scan-comms` writes the triple on **both** paths — the tier-0 auto-close (the
  biggest reply bucket, previously landing as a bare "Dead") and the draft mirror.
- `lib/outreach/reply-funnel.ts` + `GET /api/admin/reply-funnel` — cohort rollup:
  outcome mix, classification × outcome, reply→contract pct, and the **dropped**
  work-list (replied, never advanced past the send-side status). Reports its own
  `classificationCoveragePct`, so a partial backfill cannot read as a complete funnel.
- `GET /api/admin/reply-triage-backfill` — dry-run by default, `?apply=1` to write,
  `?limit=N` (default 40, max 150). Re-pulls the Quo thread and re-runs the SAME
  classifier over the original body: recovery, not re-interpretation.
  **Deliberately NOT a cron** — a standing sweep over a closed hole is the
  paid-call bleed #178 capped.

**Airtable schema** (Listings_V1 `tbldMjKBgPiq45Jjs`) — three new two-sided fields:
`Reply_Classification` `fld7vLOMdLthqccoy` (singleSelect, 10 choices) ·
`Reply_Classified_At` `fldoTXHschuUDi2Hx` (dateTime, utc) ·
`Reply_Decision_Kind` `fld13azWnqSx2YyoJ` (singleLineText). Registered in
`LISTING_FIELD_REGISTRY`; the airtable-map-parity snapshot was updated.

**OPEN — the backfill has NOT been run.** 118 records still report
`(unclassified)` until `/api/admin/reply-triage-backfill?apply=1` is called
repeatedly until `remaining_after_run` reaches 0.

### 8i-bis. Diagnostic finding — why the operator is still hands-on (no code change)

Recorded so it is not re-derived. Spine `rec21K0wT6BhuMIpB`.

- **Nine of ten** `ReplyClassification` branches return `needsDecision: true`;
  **eight** also return `suggestedReply: null` as a hardcoded literal. Only
  `rejection` self-resolves (tier-0 auto-close); only `soft_no` carries a draft,
  and that still lands in a *Pending* proposal. The operator's stated design —
  *reply to those replies when capable* — **was never written**. It is not dark
  and not flag-gated. That is the code-level reason every deal reaches his desk.
- **ARV auto-run is NOT the problem** (corrects a standing operator belief): of
  the 47 currently-engaged records, **zero** lack an ARV stamp and only 2 are
  stale >14d. The 2026-06-10 `autoRunOnEngaged` ruling shipped and fires.
  The real gap is **rehab — 12 of 47 engaged records have no `Rehab_Estimated_At`**
  — and it is *by design*: `lib/appraiser/auto-run-on-engaged.ts` skips rehab when
  the caller's lambda budget can't fit it, naming the manual "Run rehab" button as
  "the prepared one-click fallback per the ruling." A ruling made the operator's
  hand the fallback path. `rehab-vision-retry` **is** scheduled, so why those 12
  remain bare is **UNVERIFIED** — own investigation needed.
- Two coverage holes: `autoRunOnEngaged` is wired into `scan-replies` but **not**
  `scan-comms` (whichever cron sees the reply first decides whether the underwrite
  fires); and the backstop `auto-underwrite-engaged` (6 slots × limit=4 = 24
  records/day) filters on `Execution_Path === "Auto Proceed"`, leaving 7 of 47
  engaged records invisible to it.

**Proposed, NOT approved** (awaiting operator go): (1) build the auto-reply lane
for the four procedural buckets — `offer_format`, `disclosure_step`,
`appointment`, `seller_costs` — behind a dark flag with a dry-run route first;
(2) wire `autoRunOnEngaged` into scan-comms and drop the Auto-Proceed filter;
(3) give rehab its own queue; (4) **keep** `counter` and `acceptance` on the
operator's desk — that part of the design is correct. Item (1) puts a model on
the outbound wire and was explicitly not started.

## 8j. NEW 2026-07-31 — RentCast spend ceiling at the choke point

**The incident, reconstructed from vendor payment history.** RentCast auto-charges
whenever accrued overage crosses **$250**. June crossed it **four times** —
~**$1,125**, roughly **18,750 requests**, about **3× July's entire volume** — in
the same window as the documented Firecrawl runaway. Firecrawl got a circuit
breaker out of that incident. **RentCast did not.** July reconciles exactly to
plan (6,520 used → 5,520 × $0.06 + $74 = ~$405): no billing error, and the
trend is down 64% because #175 and #178 landed.

**Why the existing guards missed it** `[verified — read this session]`:
- `RENTCAST_24H_HARD_CEILING` was read in **one place** (the
  `auto-underwrite-engaged` cron). ~20 other call sites — the reply-triggered
  inline `autoRunOnEngaged` path, the manual dashboard buttons, every admin
  route — had no ceiling.
- `RENTCAST_MONTHLY_CAP` was enforced only in `lib/federation/rentcast-hydrate.ts`
  and `lib/maverick/sources/external-rentcast.ts` — never on the appraiser or
  underwrite paths.
- `lib/rentcast/failure-loop-breaker` bounds repeated **failures** of one call
  shape. A runaway making **successful** calls is invisible to it, and success bills.

**Shipped** (commit `367f0e1`; 3612 tests green, `tsc` clean — **not yet merged
or deployed**): `lib/rentcast/spend-ceiling.ts`, consulted inside
`lib/rentcast.paidFetch` — the single HTTP choke point every RentCast call
already passes through. **One gate, all call sites, nothing to wire up.**

Three windows, cheapest-first: **per-invocation** (in-memory, no I/O) ·
**per UTC day** (KV) · **per UTC month** (KV). Refusal returns a synthetic
**598**, deliberately distinct from the loop-breaker's 599 — "we stopped
spending" and "this shape keeps failing" have opposite remedies. Non-2xx either
way, so every caller fails closed unchanged. Refusals emit **both** a
`paid_api_call` row (cost 0, so refused work stays visible on the spend
dashboard) and a `rentcast_spend_ceiling_reached` audit.

**Fail posture, split deliberately.** The KV windows **fail OPEN** when KV is
unavailable (the Firecrawl breaker's doctrine — a monitoring outage must not
silently halt the pipeline), auditing `rentcast_spend_ceiling_degraded` every
time. The per-invocation window needs no infrastructure, always runs, and
**fails CLOSED**. *An outage degrades the ceiling; it never removes it.*

The counter increments **before** dispatch and is **awaited, not detached** —
the vendor bills on the request, and an un-awaited increment lets a tight loop
fire hundreds of calls before the first write lands.

| Env | Default | Note |
|---|---|---|
| `RENTCAST_PER_INVOCATION_CAP` | 60 | new; the KV-independent backstop |
| `RENTCAST_24H_HARD_CEILING` | **300** | **raised from 150** |
| `RENTCAST_MONTHLY_CAP` | 1000 | = Foundation plan's included requests |

The daily raise is deliberate: observed July baseline is **~120 calls/day**, so a
150 *global* ceiling would trip on an ordinary busy day and silently starve ARV
runs. 300 is ~2.5× baseline and a runaway still reaches it within the first hour.
Side effect stated in code: `auto-underwrite-engaged`'s ceiling loosens 150 → 300
because it now reads the shared constant instead of a second local reader of the
same env. That lane keeps its own check — it counts RentCast **+ ATTOM**, while
the choke point sees RentCast only.

**KNOWN IMPRECISION:** the month window buckets by **UTC calendar month**, while
RentCast bills on its own subscription cycle (which *resets on plan change*). The
two drift by up to weeks. Fine for a safety brake; **never** read it as "requests
left this billing period" — the vendor dashboard is authority.

**OPERATOR NOTE:** the KV month bucket starts **empty**. This does not
retroactively account for July's 6,520 — it counts from first deploy forward.

**Plan ruling (2026-07-31): stay on Foundation ($74).** Break-evens at real
rates — Foundation wins below ~3,100 calls/month, Growth ($199) from ~3,100 to
~13,300, Scale ($449) only above ~13,300. Peak month was 6,520. Scale was
briefly recommended off a wrongly-derived $0.33/request rate and **withdrawn**;
the real Foundation overage is **$0.06**.

## 8k. NEW 2026-07-31 — Placeholder-rehab HOLD + the vision queue (256 Westchester)

**The defect** `[verified — record read this session]`. `rec reckHdag4kCuTyNj1`,
256 Westchester Dr, Birmingham AL 35215. Renovated 4/2 (quartz waterfall island,
refinished hardwoods), 1,902 sqft, list **$234,900**, **DOM 380**,
Distress_Bucket "Extreme". RentCast auto-intake 09:12 → auto-promoted Auto
Proceed → **texted 15:01**, with `Real_ARV_Median`, `ARV_Validated_At`,
`Est_Rehab` and `Est_Rehab_Mid` **all empty**. Opener **$74,500**. Agent: *"No
where close, their bottom line is $230k."*

**The ARV was not wrong.** Reconstructed to the dollar:

```
ARV     = seed $/sqft × 1,902 sqft   ≈ $223,750   (~$117/sqft — agent said $230k)
rehab   = 0.30 × ARV                 =  $67,125   ← GUESSED
ceiling = 0.70 × 223,750 − 67,125 − 15,000 fee
opener                               =  $74,500   ✓
```

The system subtracted a **$67,125 gut renovation from a turnkey house.**

**Root cause — two defensible rules, lethal together:**
1. `lib/lowball-eligibility.ts:81` — DOM ≥ 60 is eligible *"on time-on-market
   alone **(no vision needed)**"*. The condition read is skipped for aged listings.
2. `lib/rough-opener-ceiling.ts:99` — with no vision rehab, rehab =
   `ROUGH_REHAB_PCT_OF_ARV` (0.30) × ARV.

A renovated house that sits is the *most common* way a listing reaches 380 DOM.
380 days at $234,900 means **overpriced, not distressed** — and the only signal
separating those is the one the eligibility gate skips.

**AMENDMENT: rehab is the largest term in the opener after ARV. Guessing it IS
guessing the offer. An opener resting on a placeholder rehab never reaches a seller.**

Carried as a **flag** (`PricerResult.placeholderRehab`), **not** an early return,
and converted to a HOLD **last** — in `priceOpenerWithSeed`, after the over-list
tripwire and corroboration gate have spoken. (Two earlier placements swallowed the
size-extrapolation and tripwire diagnostics; 4 existing tests caught it.) Those are
**ARV** problems — vision cannot fix an ARV problem, and labelling them "needs
vision" would route them to a drain that can never clear them.

**The bucket** (operator: *"not get buried in hundreds of other dead properties…
a bucket for me to either spot check images or run rehab with the system vision"*).
A held opener normally writes an `h2_opener_hold` proposal — a queue **533 pending**
deep. These are **machine work**, so they route away from the proposal writer
entirely into `Vision_Queue_State` (`fldqgrBDtoRceShP2`: `needs_vision` /
`vision_failed` / `cleared`). `routeHolds` splits on an **exact** reason match,
never a prefix — a permissive test re-buries them.

**`/api/cron/opener-vision-drain`** (new; 2 slots/day, `limit=6`, 13:20 + 20:20 UTC)
runs the appraiser's existing `collectPhotos` → `callRehabVision` →
`computeRehabRange` pipeline over `needs_vision`, writes `Est_Rehab_Mid` +
`Rehab_Estimated_At`, sets `cleared` — which **releases** the record so the next h2
pass prices it off a real rehab and may send. **Zero operator involvement.** Only a
genuine vision failure becomes `vision_failed` — the spot-check bucket, reported on
every drain run so it can never quietly grow.

Regression test reproduces the address end-to-end: HOLDs instead of texting $74,500;
SENDS above $130,000 once a real vision rehab exists.

### 8k-bis. STILL OPEN from this trace (found, NOT fixed)

- **h2's pre-send probe discards `review` verdicts.** It acts only on reject
  reasons `firecrawl_renovated` / `new_construction_excluded` /
  `wholesaler_excluded` / `firecrawl_inactive`. A `classifyVerifiedListing`
  outcome of **`review`** — including `condition_signal_missing_flagged` and
  `sqft_mismatch_flagged` — **falls through and sends.** On this listing the
  classifier correctly said "no distress signal on this page" and h2 ignored it.
- **Two floors, one concept.** `LOW_OPENER_FLOOR_PCT_OF_LIST` = **0.30** (h2 send
  path via `minOfferFloor`) vs `LOWBALL_FLOOR_PCT_OF_LIST` = **0.35**
  (`outreach-economics`). The looser one is live on the send path; at 35% the
  $74,500 opener would have held on the floor alone.
- **The `no vision needed` shortcut on aged DOM is untouched.** Time-on-market
  should earn *eligibility*, not a *price*.

## 8l. NEW 2026-07-31 — Conveyor rebalanced (opener holds off, vision on, ZIPs batched)

**The surface was already right.** `components/conveyor/ConveyorFeed.tsx` (operator
2026-07-11) is the one ranked feed; `removeItem` already pulls a card **out of state**
on action rather than crossing it off; the machine-work gate already hid all 235
`kill_dead_deal`. The problem was what it was being **fed**.

> **Correction to an earlier claim in this session:** "985 pending, 93% housekeeping,
> 190 HIGH dead deals" described the Airtable **table**, not the operator's screen.
> The real clutter was **`h2_opener_hold`: 533 in the decision feed against 72
> `jarvis_reply` — 8:1 burial of the only lane with a human in it.**

Mockup approved before any code changed (artifact `22d48240`).

**1. Opener holds are BACKLOG, not decisions.** New `BACKLOG_PROPOSAL_TYPES` =
`{h2_opener_hold}`. Counted as `hidden.backlog`, surfaced as a linked badge → `/system`,
never as cards. Reported **separately** from `machineWorkHidden` — machine work is
handled and forgotten, backlog is real work nobody has started — and checked **before**
the machine-work branch so 533 records can never be reported as "handled".

**2. `batchFrontierRetire`** (pure). 42 proposals with identical reasoning is **one**
coverage ruling. `FRONTIER_BATCH_MIN = 3`. Batching exposed a second problem: those 42
were written by the **old** governor (retire on a single empty crawl). The rule changed
2026-07-29 — `RETIRE_MIN_ZERO_YIELD_STREAK = 3`, `REVIVAL_COOLDOWN_DAYS = 30`,
*"pause is a rest, not an exit"* — and their reason string `zero_yield_latest_snapshot`
**no longer exists in the codebase**. When any row still carries it the card flips
"Retire all N" → **"Archive all N"** and says why. New `proposal_batch` action kind
(not a `proposalIds` array on the singular actions) so no handler can half-apply a
batch; the handler counts real writes and reports *"Archived 38 of 42"*, never a false
success.

**3. `/api/vision-holds`** returns **only** `Vision_Queue_State=vision_failed`.
`needs_vision` is deliberately excluded — the drain cron clears those twice daily with
nobody looking, and surfacing them would recreate the pile the lane exists to prevent
(*"if it renders, it needs you"*). Actions: **Run rehab** (primary — one tap, costs the
operator nothing) then **Spot-check images** (fallback for when the machine already
failed). List price is context text, **never** `dollars` — nothing has been offered on
a held record. `needs_vision` returns as a count for the rail only.

`ConveyorCard` gained a secondary-open render; without it the Run rehab / Spot-check
pair existed in the model and only one drew.

**Expected effect:** ~660 cards → **~126**, of which **72 are live seller threads**.

**NOT DONE, deliberately:**
- The 42 stale frontier proposals were **not archived**. The card is wired; pressing it
  is the operator's call (a 42-record production write).
- The **nine nav tabs** are untouched (Act Now, Pipeline, Deals, Buyers, Queue, System,
  Today, Funnel, Agents). `/queue` and `/` already render the identical feed by
  construction — consolidation is real but is its own change.

## 8m. NEW 2026-07-31 — Auto-answer lane (DARK), and the replay that reframed it

**Shipped** (commit `d34e6a6`; 3647 tests green, `tsc` clean, build compiles —
**not merged, not deployed, lane DARK**): `lib/reply-triage/auto-answer.ts` (pure
decision + deterministic composers), `auto-answer-send.ts` (I/O; mirrors
`lib/auto-ack` guard-for-guard), `/api/admin/auto-reply-dry-run` (**no apply mode,
cannot send**), wired into `scan-comms`. Flag: `REPLY_AUTO_ANSWER_LIVE`.

**Scope narrowed mid-build.** The approved proposal named **four** buckets. Two are
already forbidden by rules written in the triage itself:
- `disclosure_step` — *"the machine NEVER acknowledges legal disclosures for the
  operator; personal acknowledgment required."*
- `appointment` — *"operator owns the calendar commitment."*

Only **`seller_costs`** (a policy answer naming **no** number) and **`offer_format`**
(restates the delivery-stamped **sticky** number; no sticky → HOLD, per INVARIANTS §3)
survived. Composers are deterministic string builders, not model calls. The **amount
veto** outranks every other check — a seller who names a number is countering, whatever
else the sentence says (the 9360 Cheyenne shape).

### THE REPLAY — read this before extending the lane

Replayed through the real modules over the **121 recorded reply threads** (100
parseable, 21 with no recoverable inbound):

| classification | n |
|---|---|
| **unknown** | **50** |
| soft_no | 19 |
| interest | 14 |
| rejection | 14 |
| offer_format | 2 |
| counter | 1 |
| seller_costs / appointment / disclosure_step | **0** |

**The lane would have answered 2 of 100.** The premise behind the build — that these
were "the highest-volume non-rejection buckets" — was **wrong**. The build is correct
and safe; it is simply not where the volume is.

**Where the volume actually is: classification.** Sampling the 50 `unknown` bodies shows
three populations collapsed into one generic queue:
1. **Trivial acks needing no reply** — "Will do", "Ok, thank you.", "Not at all",
   "emailed". These should self-close, not queue.
2. **Mis-classified `offer_format`** — a bare email address *is* the answer to "what's
   the best email", and reads as `unknown`.
3. **Hot and urgent, sitting in a generic bucket** —
   *"Alex, did you receive my email with contract?"* ·
   *"Alex, what is going on with the contract I sent you?"* ·
   *"Hey Alex! That sounds like a great offer… probate… my client wanted this closed
   months ago"* — the last is near an acceptance; the first two are agents chasing the
   operator at **contract stage**.

**Recommended next (NOT approved, NOT started):** the classifier, not more auto-answer
buckets — (a) a *no-reply-needed* class so trivial acks self-close, (b) contract-stage
patterns, (c) softer acceptance patterns. `ACCEPTANCE_PATTERNS` is deliberately narrow,
which is right for auto-close but leaves warm leads in the generic bucket.

**Also unresolved:** 21 of 121 threads have no recoverable inbound body. The
reply-classification backfill (§8i) re-pulls from Quo and would cover them — **still
not run.**

## 8n. NEW 2026-07-31 — THE FIRST-TOUCH COLLAPSE (read this before adding any gate)

**Counting only `[H2 sent` markers — actual NEW offers, not follow-ups:**

| 7/22 | 7/23 | 7/24 | 7/25 | 7/26 | 7/27 | 7/28 | 7/29 | 7/30 | 7/31 |
|---|---|---|---|---|---|---|---|---|---|
| 22 | **37** | 24 | 15 | 6 | 9 | 12 | 11 | 11 | **3** |

**Peak 37 → 3. Down 92%.** An earlier count in this session reported "ramping, 7/30 = 35"
— that used `Last_Outbound_At`, which `parked-followup` and the bump lane also stamp.
**Follow-ups masked the collapse entirely. Count `[H2 sent`, never `Last_Outbound_At`.**

### Where the supply dies

Pure gate stack replayed over all **1,640** never-texted Active records (freshness values
real; seed $/sqft held constant, so this **models** the stack rather than reproducing
live per-ZIP pricing):

| gate | n | share |
|---|---|---|
| **freshness `verify_stale`** | **1,284** | **78%** |
| lowball `not_eligible_clean` | 262 | 16% |
| missing sqft or list price | 94 | 6% |

**Freshness is the binding constraint by a wide margin.** 1,284 records are eligible in
every respect except a `Last_Verified` stamp older than 48h.

### The exact ceiling on first-touch

```
2 freshness-reverify slots × limit=40      =  80 re-verifies/day
BUMP_REVERIFY_SHARE = 0.4 (already-Texted) = −32
                                   virgin  ≈  48/day  ← the number that must move
```

Everything downstream (lowball gate, coverage, per-zip caps, pricer holds, min-offer
floor) can only shrink 48. **Cost to move it: 1 Firecrawl credit per re-verify**, against
~420/day current burn and an **800-per-rolling-hour** cap. Re-verify does **not** touch
RentCast.

> **Correction to a theory floated in this session:** the 7/25–7/30 hardening wave
> (#165–#182) was suggested as the cause. The model does **not** support that as the
> primary driver. The better fit is a **stock drawdown** — 7/22–7/25 spent an accumulated
> fresh cohort (98 sends in four days), and from 7/26 the system has run at its refill
> rate. No added gate is needed to explain the curve.

### Placeholder-rehab hold NARROWED the same day (supersedes §8k)

The blanket hold from §8k would have blocked **1,266 of 1,555** never-texted records
(81%) against a drain clearing 12/day — **106 days**. With first-touch at 3/day that is
zero. *A correct guard that stops the business is not a correct guard.*

`placeholderRehabIsUnsafe(list, arv)` — the placeholder **assumes** rehab =
`ROUGH_REHAB_PCT_OF_ARV × ARV`, so a house needing that work cannot be worth more than
the remainder. An ask at or above `(1 − ROUGH_REHAB_PCT_OF_ARV) × ARV` contradicts the
assumption:

```
256 Westchester  $234,900 / $223,750 = 105% ≥ 70%  → HOLD
Detroit shell     $30,000 / $150,000 =  20% <  70% → SEND
```

Threshold is **1 − the placeholder itself**, so the two cannot drift. Unknown ask or
unknown ARV **fails closed**. Distressed cohort flows at full volume; only the turnkey
shape holds. No vision, no drain backlog, no new spend.

**DONE (operator approved, commit `d3ee40a`)** — re-verify raised **80/day → 200/day**:
4 slots × `limit=50` at **13:45, 16:00, 18:45, 21:00 UTC**, placed *ahead of* the h2 send
clusters so records are fresh when the sender runs rather than replenished in two bursts.
`limit=50` is the route's own `MAX_LIMIT`; no code ceiling was raised. After the 40% bump
reservation that is **~120/day virgin** against the 1,284-record stale cohort, feeding an
h2 send meter capped at 100/day. Cost: **1 Firecrawl credit each — 200/day against an
800-per-rolling-hour cap.** Re-verify never touches RentCast.

**Watch after deploy, in order:** (1) does first-touch rise from 3/day — count `[H2 sent`,
never `Last_Outbound_At`; if it doesn't, freshness wasn't the only constraint and coverage
/ per-zip caps are next. (2) the over-list tripwire below. (3) RentCast burn, which grows
with REPLIES not sends.

**FLAGGED, unmeasured:** an opener at 94% of list trips `NEVER_OVER_LIST_PCT` (0.85) and
HOLDs. On genuinely cheap asks the value-anchored opener can land above 85% of list, so
the over-list tripwire may be eating supply in the cheapest markets.

## 8o. NEW 2026-09-01 — Decision Queue source on the conveyor + Maverick Prime routine suite

Operator ruling 2026-09-01 (`docs/handoffs/NEXT_SESSION_DIRECTIVE.md`, Spine
`recDaxld9i1UBW2Ax`; Tier B ratified `recnvFB7rzuBmYB9V`). Two things shipped.

**Decision Queue = one more SOURCE on the existing conveyor, not a new page.**
The 2026-07-11 one-feed law stands; the home screen's `ConveyorFeed` now also
reads `/api/decision-queue`, which maps Listings_V1 straight into cards via the
pure `lib/conveyor/decision-queue.ts`:

- What renders: `Outreach_Status = Offer Accepted` (2B — terms are money),
  `Counter Received`, or `Negotiating` with `Latest_Counter_Usd` (2C). A card
  needs a live inbound (`Last_Inbound_At` within 14 days), no kill flag
  (`Blacklist` / `Do_Not_Text` / `Pipeline_Stage=dead`), and
  `Action_Card_State` not Cleared/Held.
- The math line is SOURCED ONLY (`List_Price`, `Contract_Offer_Price` or
  `Rough_Opener_Amount`, `Latest_Counter_Usd`, `Buyer_Ceiling`, `Deal_Spread`,
  `Decision_Verdict`) — blanks render as "—", never an estimate.
- Taps: **Approve** appends `[OPERATOR APPROVED <ISO> via Decision Queue] <staged
  action>` to `Verification_Notes` (via `/api/actions/append_note`) and clears
  the card (`/api/actions/clear`). It texts nobody — the operator's word is now
  ON THE RECORD, and a session's live-tail send discipline does the send.
  **Edit** opens the deal room. **Kill** = `/api/actions/mark_dead`.
- A pending `jarvis_reply` proposal for the same record wins the dedupe (it
  carries the dispatch rail). Re-opening after a new inbound is the machine's
  job (`Action_Card_State` back to Open) — not wired yet; today a cleared card
  stays cleared until a session or cron flips the state.
- Server feed (`lib/decision-feed-server.ts`, escalation SMS) does NOT include
  this source yet — follow-up.

**Routine suite (fresh-session Routines, created via claude-code-remote):**
Triage 3×/day (12:30/17:30/22:30 UTC), Follow-up Engine daily (15:00 UTC),
Nightly Pipeline Audit (04:30 UTC), Weekly Buyers List (Sun 12:00 UTC). The
old read-only "AKB daily brief" routine is DISABLED (it stalled on a Gmail send
approval 2026-09-01 and never delivered). UNVERIFIED at write time: whether
these Routines inherit MCP connectors (Quo/Airtable/Maverick/Gmail) and whether
their sends clear the permission gate — first firing is the test; if the audit
email does not arrive, re-create them from the claude.ai Routines UI with
connectors attached.

## 8p. NEW 2026-09-02 — Quo 402 breaker, pager email fallback, Machine Health screen

The prepaid-credits outage: Quo returned 402 from ~13:05Z; nine outreach slots and
the bump lane each processed 20 records, burned ~40 Firecrawl probe credits per run,
sent nothing, and the Pulse pager died on the same 402. Three fixes:

- **`lib/outreach/send-lane-breaker.ts`** — `isQuoCreditsExhausted(err)`,
  `checkSendLaneBreaker`, `tripSendLaneBreaker(lane, err)`, `clearSendLaneBreaker`.
  KV key `send_lane:quo_402`, TTL `SEND_LANE_402_TTL_S` (default 20 min so a top-up is
  picked up within a slot). `lib/quo.ts` now throws `QuoSendError` with a structural
  `httpStatus`. `h2-outreach` and `bump-followup` check the breaker before the loop,
  `break` on the first 402 (no further probes), trip it, and report
  `quo_breaker: { tripped, tripped_at }` in their audit summary. One audit row per trip:
  `crier/quo_credits_exhausted`. Dry runs never trip or honour it.
- **`lib/pulse/runner.ts`** — `pageOperator` (now exported) falls back to
  `sendEmail` → `ALERT_EMAIL` (default alex@akb-properties.com) when the SMS page
  throws; audit `pulse_page_email_fallback`. Dep seam `emailFn` (null disables).
- **`/health`** (`app/health/page.tsx`, pure shaping in `lib/health/machine-health.ts`)
  — read-only Machine Health: texts sent today vs cap, slots fired blank, Quo credits
  (from the breaker's audit row), replies drafted, connector rows (Quo / Firecrawl /
  RentCast-ATTOM / cron) from Pulse detections, last-24h send-slot table, detections.
  Data: `/api/agents/pulse/scan` + `/api/admin/audit-tail` only. Nav tab HEALTH.

## 9. Pointers

- Hard rules / invariants: **[`docs/INVARIANTS.md`](../INVARIANTS.md)** — load every session.
- Operator narrative + charter: `docs/handoffs/SYSTEM_HANDOFF.md`.
- Positive-confirmation (three-state truth) principle: `docs/Positive_Confirmation_Principle.md`.

## 8q. NEW 2026-09-05 — Dispo step 1 (hunted → contracted → dispo'ed) + Build Ledger

Operator directive: "Unpark the email engine and build step 1, deal pages public"; "my morning briefing
[must] include build data… It should all live in my dashboard." Delegation rule recorded on the spine
(recCNcyyqpLOz4FT5): top model plans/reviews/merges, Sonnet builds bounded pieces.

**Contract trigger.** `POST /api/contract-lifecycle/executed/[recordId]` (dashboard cookie / CRON_SECRET /
OAuth) — the first code writer of `Contract_Executed_At`. Pure math in `lib/dispo/contract-lifecycle.ts`:
option +10d (every contract keeps the option, EMD-cap rule), EMD +3d, close +21d, `Contract_Offer_Price`,
`Assignment_Price` (default contract + $10K). Refuses Dead, refuses re-stamp without `?force=1`, flips
status to Offer Accepted, appends a note line. Button: `components/MarkContractExecuted.tsx` on
`/pipeline/[id]`.

**Dispo trigger cron** `/api/cron/dispo-trigger` (25,55 * * * *): candidates via
`getDispoTriggerCandidates()` (server formula: executed, no `Dispo_Blast_Fired_At`, not Dead). Per record:
KV claim `dispo:blast:<rec>` 1h → `evaluateAssignmentSpread` gate (block/hold = no send, audited
`dispo_blast_gated`) → `collectPhotos` once → `Deal_Photo_URLs` (JSON array) + `Dispo_Public=true` →
`buildBuyerShortlist` top slice with email (`selectBlastRecipients`, cap `DISPO_BLAST_MAX_RECIPIENTS`
default 10) → deterministic `composeDispoBlastEmail` (one number + `/d/<rec>` link, no LLM) via Gmail →
buyer `Email_Sent_At` → notes + `Dispo_Blast_Fired_At` → audit `dispo_blast_fired`. All-sends-failed = no
stamp = retry next slot. **Buyer SMS is OFF** (Tier C). `?dry_run=1`, `?record_id=`. **DARK until
`DISPO_BLAST_LIVE=true`** (operator hold 2026-09-05: first blast is reviewed by eye) — dark runs report the
gate + recipients + email preview and send nothing.

**Public deal page** `/d/[recordId]` + `GET /api/public/deal/[recordId]` — the ONE unauthenticated read
path. `lib/dispo/public-deal.ts` is the allowlist projection (404 unless `Dispo_Public`); leak-tested
against contract/ARV/rehab/agent/notes. Intake form posts to `/api/buyers/intake`. AuthGate +
Navigation + MobileTabBar exempt `/d/`.

**Option tripwire cron** `/api/cron/option-tripwire` (5 13 * * *): `lib/dispo/option-tripwire.ts` stages
t5 (3<d≤5), t2 (0≤d≤2), lapsed (-14≤d<0). One fire per (record, stage) via KV `tripwire:<rec>:<stage>`
30d; writes Operator_Action_Items row + operator SMS (`OPERATOR_PERSONAL_PHONE`); audit
`option_tripwire_fired` / `option_tripwire_run`.

**Build Ledger** table `tblqMmkZ6zsPhxKBx`: `lib/build-ledger.ts` (fetch / upsert on Project+Step /
pure `summarizeBuildLedger`), `GET|POST /api/build-ledger`, dashboard tab `/build`, `build` section in
`/api/morning-briefing`, one "Build: N in works · M need you" line in the 8:30 digest SMS.

New Listings_V1 fields: `Assignment_Price` fldfXqvaRkjCaTTF3, `Dispo_Blast_Fired_At` fld9mpSy76DJ3FLfY,
`Deal_Photo_URLs` fldGWr6THoaLrBafp, `Dispo_Public` fldjGAK9f3tnCvpvU.
