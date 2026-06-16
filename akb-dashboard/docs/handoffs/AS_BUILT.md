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
> Last updated: 2026-06-16 · prod HEAD context: branch `claude/admiring-shannon-dzfnbm`, local HEAD `dff69b1` (builds on PR #27 verify-gate `8952d8c` + PR #28 backlog-reprice `7959eaf`).

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
| 1 | `pre_outreach` | verified → outreach_ready | `airtable_listing` only (14 items, PO-01…PO-14) |
| 2 | `pre_send` | outreach_ready → outreach_sent | `airtable_listing` (PS-01 needs `ARV_Validated_At`) |
| 3 | `pre_negotiation` | outreach_sent → negotiating | listing + `quo_thread` + `gmail_thread` + `live_listing` + `cma` |
| 4 | `pre_contract` | negotiating → contract | listing + `pa_document` (DocuSign) + `buyer_pipeline` |
| 5 | `pre_emd` | contract → emd | listing + `property_intel` + `airtable_deal` |

**Pre-Outreach config** (`lib/config/gates/pre_outreach.json`): blocked MLS statuses
`{Off Market, Sold, Pending, Withdrawn, Expired}`; restricted states `{IL, MO, SC,
NC, OK, ND}`; SFR-only; beds ≥ 2; sqft ∈ [500, 5000]; list ∈ [3500, 500000]; flip
score < 4; verify freshness ≤ 72h; distress = DOM ≥ 60 OR ≥1 price drop (warn-only).

**`pa_document` (DocuSign) is unwired in production (Phase 1)** — `gate-runner.ts`
`fetchSource("pa_document")` throws, so Gate-4 items depending on it resolve to
`data_missing`. `[verified — gate-runner.ts:304-311]`

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
| **`H2_OUTREACH_HARD_DISABLE`** | unset ⇒ `!== "false"` ⇒ **disabled** | `app/api/cron/h2-outreach/route.ts:171` `[verified]`; `app/api/outreach-fire/route.ts:110` `[sweep]` | **Hard kill on opener SMS** — route returns 503 before send. Added after a 2026-06-05 unauthorized-send incident. The ONLY thing standing between the system and live texts. |
| `H2_OUTREACH_LIVE` | unset ⇒ dry-run | `h2-outreach/route.ts:190` `[sweep]` | Even with `?dry_run=false`, stays dry unless `=="true"`. |
| `FOLLOWUP_SEND_ENABLED` | unset ⇒ off | `parked-followup/route.ts:85` `[sweep]` | Parked follow-up SMS never fire. |
| `CRAWLER_INTAKE_LIVE` | unset ⇒ dry-run | `listings-intake/route.ts:282` `[sweep]` | No Airtable creates from intake. |
| `CRAWLER_AUTO_PROMOTE_LIVE` | unset ⇒ Review | `listings-intake/route.ts:300` `[sweep]` | Crawled records land in Review, not Auto Proceed. |
| `CRAWLER_AUTOSEED_LIVE` | unset ⇒ skip | `listings-intake/route.ts:294` `[sweep]` | No renovated-comp seed pulls / opener writes ⇒ **`Rough_Opener_Amount` stays blank cohort-wide** (confirmed: none of the records sampled this session had a stored opener). |
| `MAVERICK_CRON_ENABLED` | unset ⇒ 503 on cron-auth | multiple crons `[sweep]` | Cron auth gate. |
| `EXCLUDED_STATES` (code const) | `{IL,MO,SC,NC,OK,ND}` | `lib/crawler/intake-filter.ts:30` `[verified]` + Pre-Outreach PO-05 `restricted_states` `[verified]` | Excluded-state listings are filtered at intake (the table has **0** NC records) and PO-05 blocks them at the gate. |

> **Manual-review parks:** crawled/un-promoted records sit in `Outreach_Status =
> Review` / `Parked` (Airtable singleSelect) awaiting operator action; auto-promote is
> off (`CRAWLER_AUTO_PROMOTE_LIVE`). `[verified — MCP record sample]`

---

## 5. State locations

| Kind | Where | Key/Detail |
|---|---|---|
| Listings / deals / buyers | **Airtable** base `appp8inLAGTg4qpEZ` | Listings_V1 `tbldMjKBgPiq45Jjs` `[verified]`; Deals, Buyers via `getDeals`/`getBuyers` `[verified]`; field→prop map `lib/airtable.ts:152 LISTING_NAME_MAP` `[verified]` |
| Operator decision log / build events | **Airtable Spine** `tblbp91DB5szxsJpT` | narrative + `event_type` audit `[verified — MCP this session]` |
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

- **Firecrawl breaker fails-OPEN on a KV/store outage** (both the scope gate and the
  spend breaker). A *simultaneous* outage could reconstruct the burn, capped only by
  the per-run ~1000 budget (~6k/hr). Flagged 2026-06-09 (Spine `recTes4PKeI6K96mS`)
  as "fix next: fail to a narrow `[48227]` allowlist". **Whether the fail-narrow fix
  shipped is `[unknown]`** — verify before trusting the breaker under outage.
- **Today's exact Firecrawl balance is `[unknown]`** — no `FIRECRAWL_API_KEY` this
  session and Vercel runtime logs were empty for the window. Most recent production
  evidence: ~26,000 credits, operator-topped-up 2026-06-15 (Spine); last machine
  probe 14,093 on 2026-06-09. The retry-loop that drained it to −821 is killed at
  root (PR #26 widen + PR #27 verify-gate, both in prod). See Step 0 of the session
  report.
- **`Pipeline_Stage` field mapping** for the fixtures was not confidently resolved
  from MCP field IDs (the candidate field carries crawl-status-like values); left
  `null` in fixtures. Affects only the `current_stage` display echo, not gate logic.
- **Cron rows tagged `[sweep]`** in §1a were gathered by a sub-agent and not
  individually re-read; schedules are verified against `vercel.json`, the one-line
  summaries are not.
- **`pa_document` / DocuSign** path is intentionally unwired (Phase 1) — Gate 4
  cannot pass until it lands.
- **Send paths (Quo, follow-ups, DocuSign) were NOT exercised** this session by
  design (out of scope). Their disable flags are documented in §4 from a sub-agent
  sweep + two spot-verifies; the others are `[sweep]`.

---

## 8. Pointers

- Hard rules / invariants: **[`docs/INVARIANTS.md`](../INVARIANTS.md)** — load every session.
- Operator narrative + charter: `docs/handoffs/SYSTEM_HANDOFF.md`.
- Positive-confirmation (three-state truth) principle: `docs/Positive_Confirmation_Principle.md`.
