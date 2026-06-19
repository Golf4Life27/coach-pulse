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

- **ARV buy-box path:** `opener = anchor × (ARV × arv_pct_max − rehab − fee)`.
- **Fallback:** flat **65% of list** (`FALLBACK_OPENER_PCT_OF_LIST=0.65`),
  anchor-independent, whenever ARV is thin/absent/distrusted.
- **Guards:** ARV-sanity (ARV < list ⇒ distrust as as-is value, drop to 65%);
  low-opener floor (`max(30%×list, $10,000)` ⇒ route to 65%); never-over-list cap
  (`0.90 × list`). `fee` default `DEFAULT_WHOLESALE_FEE = $5,000`.
- **Market config** (`markets.json`, matched by ZIP prefix then state): `detroit_mi`
  `arv_pct_max 0.6461` (zip `48`); `memphis_tn 0.7175` (zip `38`, **paused** per
  operator — pause-enforcement location `[unknown]`); `dallas_tx 0.5883`;
  `san_antonio_tx`/`houston_tx` have **no `arv_pct_max`** (→ always 65% fallback).
- **ARV seed** comes from Airtable `ZIP_ARV_Seed`; the dry-run harness mocks it
  `null`. Seeded ZIPs (Spine 6/15): `48202/48203/48205` STRONG, `48201/48204/48206`
  DONT_PRICE.

**What the cohort prices to (from the 3 dry-run fixtures):** all three land at ~65%
of list via *different* routes — no-ARV (rec00), ARV<list distrusted (rec02), buy-box
ceiling below floor (rec07). The buy-box path rarely beats 65% here because
`rehab + fee` eats most of `ARV × 0.6461`. **This is the evidence for the Milestone-2
pricing decision.**

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

## 9. Pointers

- Hard rules / invariants: **[`docs/INVARIANTS.md`](../INVARIANTS.md)** — load every session.
- Operator narrative + charter: `docs/handoffs/SYSTEM_HANDOFF.md`.
- Positive-confirmation (three-state truth) principle: `docs/Positive_Confirmation_Principle.md`.
