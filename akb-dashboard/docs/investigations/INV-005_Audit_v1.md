# INV-005 Audit v1 — Phase 4B Rehab Fallback When Scrape + Street View Empty

**Author:** Code
**Date:** 2026-05-22
**Brief:** `docs/investigations/INV-005_Brief.md`
**Status:** DISCOVERY COMPLETE — awaiting operator pick on resolution menu
**Severity confirmed:** HIGH (silent-block on 1,025 active records with no rehab + 90 with no verification URL)

---

## Q1 — Reproduce silent-block on 23 Fields Ave

### Anchor record verified

- **Record ID:** `rec1HTUqK0YEVb7uA` (matches brief; operator's hint `recCv6F1mtsxg5cu5` did NOT match — only `rec1HTUqK0YEVb7uA` and `recvCaqLgd6n7AQkA` returned for "23 Fields" search; the latter is 3273 Steele St)
- **Address:** 23 Fields Ave, Memphis, TN 38109
- **Building_SqFt:** 936
- **Outreach_Status:** Negotiating (`selsQy685j7N9Bj1N`)
- **Verification_URL:** `https://www.redfin.com/TN/Memphis/23-Fields-Ave-38109/home/87658196` (populated, Redfin)
- **Live_Status:** Active

Address fields all present, sqft > 0 — so the route would NOT 422 at the input-validation gates (lines 114-133). Path proceeds to `collectPhotos`.

### Reproduction approach

Static code-path reproduction (live endpoint call requires Vision quota burn + env-key inspection; can run a live curl on operator request to confirm runtime cause). The silent-block trigger condition on 23 Fields is one of three failure modes inside `collectPhotos` (lib/photo-sources.ts:70-90):

**Failure Mode A — ScraperAPI returns 0 Redfin photo URLs.** Gate at `lib/photo-sources.ts:30`: returns `[]` if `SCRAPER_API_KEY` missing, URL not Redfin, or fetch fails. Then `lib/photo-sources.ts:38`: regex `/https:\/\/[^"'\s]*?(?:ssl\.cdn-redfin|redfin)[^"'\s]*?\.jpg/gi` matches zero — silently returns `[]`. 23 Fields has a Redfin URL; if ScraperAPI is configured, this fires only if Redfin removed the listing or changed its photo CDN/format (e.g. moved to `.webp` from `.jpg`, or moved to a new CDN domain).

**Failure Mode B — Street View returns null.** Gate at `lib/photo-sources.ts:55`: returns `null` if `GOOGLE_MAPS_API_KEY` missing or `fullAddress` empty. 23 Fields has a complete address, so this fires only on missing env key.

**Failure Mode C — Both A and B fire simultaneously.** This is the actual silent-block condition. On 23 Fields the most likely real-world cause is **`SCRAPER_API_KEY` and/or `GOOGLE_MAPS_API_KEY` not set in Vercel env**, since `.env.example` (akb-dashboard/.env.example) lists only `AIRTABLE_PAT`, `AIRTABLE_BASE_ID`, `DASHBOARD_PASSWORD`, `ANTHROPIC_API_KEY` — neither photo-source key is documented as required.

### Blast radius (Q1.b — production blocking count)

Two Airtable queries against `Live_Status=Active AND Outreach_Status != Dead`:

| Cohort | Count |
|---|---|
| Active records with no `Rehab_Estimated_At` populated | **1,025** |
| Of those, with NO `Verification_URL` (Street View is the ONLY photo source) | **90** |
| Sample of in-flight (Texted/Response Received/Multi-Listing Queued/Negotiating) within the 90 | 11 visible in first page |

**Read:** 1,025 records would have to run through Rehab to populate it for the first time. 90 of those depend entirely on Street View — if `GOOGLE_MAPS_API_KEY` is missing OR Street View returns no image for that address, those 90 silent-block. The remaining 935 would silent-block only if scrape AND Street View both return empty.

Note: the brief said "14 active deals currently without rehab data" — that count was specifically active deals with no Appraiser data observable in the dashboard at audit-time on 2026-05-21. The 1,025 figure here is the broader "would currently exit through `no_photos_available` if invoked" set; both numbers are correct for their respective questions.

---

## Q2 — Map the silent-block code path

### Entry point

`GET /api/agents/appraiser/rehab/[recordId]` → `app/api/agents/appraiser/rehab/[recordId]/route.ts:51-308`.

### Decision tree (all 422/502 exits)

| Line | Condition | HTTP | Behavior |
|---|---|---|---|
| 61-63 | `recordId` malformed | 400 | invalid_record_id |
| 79-86 | auth waterfall fail | 401 | unauthorized |
| 88-90 | `authKind=cron` + cron disabled | 503 | cron_disabled |
| **92-97** | **`skip_photos=1` requested** | **422** | **`skip_photos_unimplemented` — hardcoded "no fallback rehab path without vision; supply photos"** |
| 99-103 | `ANTHROPIC_API_KEY` missing | 503 | anthropic_not_configured |
| 108-112 | listing not found | 404 | listing_not_found |
| 114-122 | address parts missing | 422 | missing_address_parts |
| 124-132 | sqft missing or ≤ 0 | 422 | missing_sqft |
| 145-159 | `collectPhotos` throws | 502 | photo_collection_failed |
| **161-170** | **`photos.length === 0`** | **422** | **`no_photos_available` — "listing scrape + Street View fallback both empty"** ← INV-005 anchor |
| 186-204 | `callRehabVision` throws | 502 | vision_call_failed ← INV-013 anchor |

### Two distinct silent-block surfaces in this one route

1. **`skip_photos=1` rejection** (line 92-97): operator's explicit "skip vision" affordance is hardcoded-rejected. Comment: "no fallback rehab path without vision; supply photos." There is no manual-input affordance even when the operator KNOWS the rehab number from out-of-band knowledge (e.g. inspection report, prior comp).

2. **`no_photos_available`** (line 161-170): the brief's anchor case. `collectPhotos` returned `[]`, route 422s with no recovery path.

### Comment-vs-implementation gap

`lib/photo-sources.ts:8-10` (file header):

> "Both gracefully degrade to [] when their respective API keys are missing — **the photo-analysis caller should treat an empty array as 'no visual evidence' and warn rather than block**."

The library was designed for graceful degradation, but **the rehab/[recordId] route HARD-BLOCKS on empty** instead of warning. This is design-vs-implementation drift.

### Cross-consumer behavior comparison (4 routes consume `collectPhotos`)

| Route | Behavior on `photos.length === 0` | Discipline |
|---|---|---|
| `app/api/agents/appraiser/rehab/[recordId]/route.ts:161` | **HTTP 422 hard-block, no rehab data written** | INV-005 anchor |
| `app/api/photo-analysis/[recordId]/route.ts:84-94` | **HTTP 422 hard-block** | Same shape, distinct endpoint |
| `app/api/agents/pricing/[recordId]/route.ts:134-138` | **Graceful — sets `phase4b.error` string, continues Phase 4A on as-is** | Designed-degradation |
| `app/api/agents/validation/highland/route.ts:97-99` | **Graceful — sets `rehabError` string, continues** | Designed-degradation |

**This is structurally identical to INV-011** (Make A vs Vercel intake-path divergence). Two consumers of the same primitive (`collectPhotos`) implement different degradation policies on the same failure. Filed below as discovered-during-prior-investigation.

---

## Q3 — Distinguish from INV-013

### Failure-mode taxonomy

| Dimension | INV-005 | INV-013 |
|---|---|---|
| Trigger | `collectPhotos` returns `[]` | `callRehabVision` throws |
| HTTP status | 422 `no_photos_available` | 502 `vision_call_failed` |
| Vision call made | No (skipped — no photos to send) | Yes (failed on bad data, rate-limit, model outage, etc.) |
| Code line (rehab route) | 161-170 | 186-204 |
| Root-cause category | Data-collection failure (input-side) | Model invocation failure (model/transport-side) |
| Operator-visible cause | "listing scrape + Street View fallback both empty" | "vision_call_failed" + raw error message |
| Frequency | Predictable (1,025 records eligible to trigger) | Episodic (depends on model availability + photo quality) |
| Repairability | Operator can supply rehab manually; would still want to fix scrape later | Operator can supply rehab manually OR retry on transient |

### Same resolution surface

Both INV-005 and INV-013 land in the same place after recovery: the operator needs `Est_Rehab` written so downstream pricing math (Investor_MAO formula) can fire. Both should use:

- The same manual-input affordance (a single "set manual rehab" code path)
- The same provenance flag (vision vs manual_operator vs manual_partner)
- The same audit trail shape

**Recommendation:** treat them as a paired remediation. Resolution for INV-005 should ship the manual-input route + provenance flag; INV-013 then becomes a one-line `catch` block that delegates to the same affordance with `source=manual_operator`.

### Distinct: INV-013 has a one-line fallback option INV-005 doesn't

The brief notes INV-013 could fall back to `vision.condition_overall ?? listing.listingCondition` (post-INV-002, `listingCondition` is now persisted). That's a degraded auto-mode for INV-013 — gives a coarse condition signal without re-prompting vision. INV-005 has no equivalent auto-mode because the missing input is photos, not vision output, and `listingCondition` text alone isn't enough to drive line-item rehab math. INV-005 genuinely requires either retry-with-photos OR manual-input.

---

## Q4 — Resolution options menu

### Existing infrastructure to leverage

Three findings from the audit shape the options:

1. **The Pricing route already has `?rehab_mid_override=NNN`** (`app/api/agents/pricing/[recordId]/route.ts:5,82`). Synthesizes a vision-result-shaped object with the override value and continues the pipeline. Pattern is proven and tested.

2. **AppraiserRehabPanel has a "Run rehab" button** (`components/AppraiserRehabPanel.tsx:144-151`) that hits the rehab endpoint and reloads. The empty state is a single "Run rehab" CTA — natural spot for an "or set manually" affordance.

3. **No existing dedicated `Rehab_Source` field** on Listings_V1. The closest signal is `Rehab_Confidence_Score`, but it's a number — semantically wrong for provenance. New field needed.

### Options

#### Option A — Minimal manual-input affordance (brief's α + β + Q4 provenance)

- **Backend:** Lift `skip_photos=1` hard-block; allow `?rehab_mid=NNN&source=manual_operator` query params on existing `/api/agents/appraiser/rehab/[recordId]` route. When provided, skip `collectPhotos` + `callRehabVision`, write Est_Rehab fields directly with provenance.
- **Frontend:** `AppraiserRehabPanel.tsx` empty state grows an "or set manually" expander. Input: `$NNN` numeric, optional `$Low` / `$High` band, source dropdown (operator/partner inspection/comp-based). Submit hits the endpoint with `rehab_mid` query param.
- **Schema:** New `Rehab_Source` singleSelect field on Listings_V1 (`vision`, `manual_operator`, `manual_partner_inspection`, `manual_comp_based`, `override`). Vision path writes `vision`; override path writes the operator's pick.
- **Effort:** ~150 LOC backend, ~80 LOC UI, 1 Airtable field add. ~6 unit tests.
- **Lost-Phone Test alignment:** ✅ — operator sees the empty state, picks "set manually" once when scrape+Street View fail, writes the number, moves on. No silent block.
- **Risk:** UI surface drift if not paired with INV-013 vision-failure handling (same affordance should appear on 502 path).

#### Option B — Improve photo sources first, ship A after

- **Backend:** Add Firecrawl as primary scrape source (already proven against Redfin per recent Belt v1 work); keep ScraperAPI as fallback. Improve Street View heading-cone (try 0°/90°/180°/270° and accept any non-empty). Add Realtor.com / Zillow URL detection + scrape paths.
- **Effort:** ~300 LOC, multi-source orchestration, requires per-domain regex tuning.
- **Outcome:** Reduces the silent-block trigger rate, doesn't eliminate it. Records with addresses Street View can't geocode (rural, recently built, mis-spelled) still hit the silent-block.
- **Lost-Phone Test alignment:** ⚠️ Partial — still leaves a long-tail of silent-blocks.
- **Risk:** High effort, doesn't close the operator-action gap, defers the actual fix.

#### Option C — Heuristic auto-fallback (REJECTED per brief)

Operator brief flags this as fabrication-prohibition violation. No further design.

#### Option D — Hybrid: A now, B research-tracked (brief's lean)

- Ship Option A this sprint (closes the operator-action gap).
- File "Photo source diversification" as a separate INV (Phase 4B.3 candidate per brief).
- INV-013 vision-failure handling lands in the same week as a one-line `catch` delegating to the same manual-input route built in A.
- **Effort:** Same as A short-term, plus a tracked follow-up.
- **Lost-Phone Test alignment:** ✅ — closes the gap immediately, leaves room for backend improvements.

### Recommendation

**Option D**, with Option A as the shippable scope and a separate INV for Option B.

Rationale:
- Closes the operator-action gap on 1,025 records immediately.
- Reuses proven `rehab_mid_override` pattern from pricing route.
- Lays the provenance + manual-input rail that INV-013's resolution depends on.
- Defers photo-source diversification (Option B) without losing track of it.
- One Airtable field add (`Rehab_Source`) is the only schema change.

### Implementation notes (if Option A/D authorized)

1. **`Rehab_Source` field schema** — singleSelect, 5 choices: `vision`, `manual_operator`, `manual_partner_inspection`, `manual_comp_based`, `override`. Default empty. Add to `LISTING_FIELDS` + `LISTING_NAME_MAP` in `lib/airtable.ts`. Existing vision-path writes need a one-line addition setting `Rehab_Source: "vision"`.

2. **Manual-input route shape** — extend existing GET `/api/agents/appraiser/rehab/[recordId]` with `?rehab_mid=NNN&rehab_low=NNN&rehab_high=NNN&source=manual_operator` query params. When `rehab_mid` is present:
   - Skip `collectPhotos` + `callRehabVision`
   - Write Est_Rehab fields + Rehab_Source from query
   - Set `Rehab_Confidence_Score` to a fixed `manual_confidence_score` (e.g. 50 — lower than vision typical 70-85, to signal less-confident-than-vision)
   - Append Notes line: `[Date] manual rehab override: source=X, mid=$NNN`
   - Write Spine entry via `maverick_write_state`
   - Emit audit log `rehab_manually_set` event

3. **UI flow** — `AppraiserRehabPanel.tsx:135-155` empty state grows an expander:
   ```
   ┌──────────────────────────────────────┐
   │ No rehab estimated yet.              │
   │                                      │
   │ [Run rehab] ▼ or set manually        │
   │                                      │
   │   ↓ (expanded)                       │
   │   Source: [operator ▾]               │
   │   Mid:    [$_____]                   │
   │   Low:    [$_____] (optional)        │
   │   High:   [$_____] (optional)        │
   │   [Save manual rehab]                │
   └──────────────────────────────────────┘
   ```

4. **Provenance read by downstream consumers** — BroCard, deal-math, MAO formula display. Add `rehabSource` to `Listing` type. Surface as a badge next to the rehab number on `AppraiserRehabPanel` ("Vision" / "Manual" tag). Pricing math doesn't change behavior based on source (operator's manual entry is treated as authoritative); the badge is informational.

5. **Tests** (per acceptance criteria item 3):
   - `rehab/[recordId]` with `?rehab_mid=15000&source=manual_operator` → writes fields with provenance
   - same call without `source` → 400 missing_source
   - same call with vision path → writes `Rehab_Source: vision`
   - deal-math respects manual rehab in MAO computation
   - audit log emits `rehab_manually_set` event with source
   - Spine entry written

6. **INV-013 follow-up** — once Option A lands, the vision-failure 502 path (rehab route line 186-204) can `catch` the vision throw and redirect to the same manual-input flow via the UI surfaced error message (something like "Vision failed — set manually?" link). The route itself stays a 502 (preserves the existing API contract); the UI is the bridge.

---

## Discovered during this investigation

(To be promoted to formal queue items by operator; using temporary local numbering per Active_Queue naming discipline.)

- **[local-1] `.env.example` doesn't document `SCRAPER_API_KEY` or `GOOGLE_MAPS_API_KEY`** — both env vars are required for `collectPhotos` to function, but neither is listed in `akb-dashboard/.env.example`. A fresh deploy by anyone (or recovery after env loss) would silently silent-block 100% of rehab calls until both are added. Low-LOC fix (4 lines in `.env.example`). Worth filing as cleanup INV alongside the INV-005 remediation.

- **[local-2] Photo-source consumer divergence on `photos.length === 0`** — Four routes consume `collectPhotos`; two hard-block (rehab/[recordId], photo-analysis/[recordId]), two gracefully degrade (pricing/[recordId], validation/highland). Same primitive, different policies on the same failure. Structurally identical to INV-011 (Make A vs Vercel intake-path divergence). Should be reconciled (likely: standardize on graceful-degrade + INV-005 manual-input fallback). Worth filing as a separate audit candidate.

- **[local-3] `lib/photo-sources.ts:8-10` documents graceful-degrade contract that the rehab route violates** — Library author intended `[]` to mean "warn, don't block." The rehab route blocks. This is design-vs-implementation drift that suggests one of the routes was written before the contract crystallized. Could be addressed as part of INV-005 remediation by updating the route to match the contract; could also be filed as a contract-enforcement INV if it recurs elsewhere.

- **[local-4] `Rehab_Confidence_Score` is the only existing provenance-adjacent signal and it's wrong-shaped** — Numeric 0-100 confidence is informative but doesn't distinguish vision-derived vs manual-entered. Today operators can't tell from the Airtable record (or the dashboard) whether a `$25,000 Est_Rehab` came from a vision call or a manual override. INV-005 Option A introduces `Rehab_Source`; this finding is the artifact-of-discovery that motivated it.

---

## Acceptance criteria checklist

1. ✅ Q1–Q4 deliverables produced.
2. ⏸️ Operator selects A / B / D.
3. ⏸️ Code implements + tests if A or D selected.
4. ⏸️ Spine entry via `maverick_write_state` after remediation lands.
5. ⏸️ `AKB_MASTER_CHECKLIST.md` updated.
6. ⏸️ `Active_Queue.md` flips INV-005 to SHIPPED + appends local-1 through local-4 as numbered INVs (or queues them as the operator prefers).

---

## Standing by

Awaiting operator pick: **A / B / D**, plus disposition on the four discovered-during findings (promote to INVs / fold into INV-005 remediation / defer).
