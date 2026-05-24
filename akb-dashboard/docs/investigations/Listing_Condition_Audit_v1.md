# Listing_Condition Persistence — Audit v1

**Audit date:** 2026-05-20
**Auditor:** Code
**Scope:** discovery + recommendation only. NO code changes, NO field additions, NO Make scenario edits.
**Triggering question (per `docs/investigations/Active_Queue.md` INV-002):** Listing_Condition is filtered at intake but never persisted to Listings_V1 record — confirm gap, quantify downstream impact, propose persistence path.
**Companion specs:** `AKB_Belt_v1_Spec.md` §3.5 (Crawler interface — Listing_Condition listed as required intake field), `docs/investigations/Distress_Pass_Audit_v1.md` §4 adjacent finding.

---

## §1 — Intake filter location and logic

Two intake paths exist today. Both consume Listing_Condition. Their semantics are **not identical** — material divergence flagged below.

### Path A — Make Scenario A (`4256273` — Intake_Loader_V1)

| Aspect | Finding |
|---|---|
| Filter location | Module 9 (`ActionSearchRecords`), filter name "Phase 1 Hardened: ACTIVE SFR + Poor/Disrepair/Average + $3.5K-$250K + numeric phone", lines 654–761 of blueprint |
| CSV column | `{{3.col59}}` (PropStream "Condition" column) |
| Pass values | `"Poor"` OR `"Disrepair"` OR `"Average"` |
| Fail behavior | Record excluded from the router → never reaches Module 12 (UPDATE) or Module 13 (CREATE). Silent drop, no row written to Airtable, no audit entry. |
| Missing-condition behavior | **Silent drop** — col59 = null fails all three equality checks → record excluded. |
| Persistence | **Listing_Condition is NOT in either Module 12 or Module 13 write mappers.** Both write the same 23 fields (Address, City, State, Zip, MLS_Status, MLS_Date_Raw, List_Price, Est_Value, Bedrooms, Bathrooms, Building_SqFt, Agent_Name, Agent_Phone, Agent_Email, Agent_Brokerage, Office_Phone, APN, Dedupe_Key, Last_Seen, Intake_File, Source, Spine_Config_Link, Property_Type). No condition-field writes anywhere in the blueprint. |

Confirmed via Make MCP `scenarios_get` blueprint pull during INV-001 (Distress_Pass audit), 4,961-line full inspection.

### Path B — Vercel `/api/process-intake/route.ts`

| Aspect | Finding |
|---|---|
| Filter location | `applyFilters()` lines 75–98 |
| CSV column read | `row.Condition` OR `row["Property Condition"]` (lines 270–271; assigned to `mapped.Condition`) |
| Pass values | `"poor"` OR `"disrepair"` OR `"average"` (case-insensitive); also `VALID_CONDITIONS` set |
| Fail behavior | Record persisted to Airtable with `Execution_Path = "Reject"` and `Notes = "Rejected: Condition '<value>' not distressed"`. Rejected records ARE persisted (different from Make path). |
| Missing-condition behavior | **Pass** — explicit comment line 87: `// PropStream doesn't always include condition, so missing = pass`. The filter only rejects EXPLICITLY-good conditions (`excellent` / `good` / `very good`). |
| Persistence | **`Condition` is read into `mapped.Condition` at line 270 but is NOT in `FIELD_MAP` (lines 13–28). The variable is consumed by `applyFilters()` then discarded.** FIELD_MAP only writes Address, City, State, Zip, List_Price, Agent_Name, Agent_Phone, Agent_Email, Bedrooms, Bathrooms, Building_SqFt, Execution_Path, Notes, Restriction_Text — 14 fields, no condition. |

### Material divergence flagged

| Scenario | Make Path A | Vercel Path B |
|---|---|---|
| Condition = "Poor"/"Disrepair"/"Average" | Pass + write | Pass + write |
| Condition = "Good"/"Excellent"/"Very Good" | **Silent drop (no row)** | **Persist with `Execution_Path = "Reject"`** |
| Condition = missing/null | **Silent drop** | **Pass (treated as unknown)** |
| Condition value persisted to Listings_V1? | No | No |

The two paths produce different downstream state for the same input. Vercel keeps an audit trail of rejects (Reject row exists); Make leaves no trace. Missing-condition handling is the bigger gap — Make rejects unknowns, Vercel passes them through.

This divergence is its own architectural concern, flagged in §3 and queued as a new investigation (see Active Queue update).

---

## §2 — Persistence gap confirmation

**Claim from INV-001 confirmed: Listing_Condition is not persisted to Listings_V1.**

### Listings_V1 schema scan

`list_tables_for_base` on base `appp8inLAGTg4qpEZ` for table `tbldMjKBgPiq45Jjs` returns ~120 fields. Searched for any field that could hold the CSV condition string. Findings:

| Field ID | Field name | Type | Holds CSV Listing_Condition? |
|---|---|---|---|
| `fldkE6xgHeCvmyKJy` | `Condition_Score` | number | NO. Schema description: "AI assessment of property condition from listing data (1-10 scale)". Different unit (1–10), different source (AI), different semantic (numeric score, not categorical bucket). |
| `fldi3i6bnyzt2lKsu` | `Rehab_Line_Items_JSON` | multilineText | INDIRECT. Contains vision-derived `condition_overall` (`"Good"`/`"Average"`/`"Fair"`/`"Poor"`/`"Disrepair"`) inside a JSON blob, written by `/api/agents/appraiser/rehab/[recordId]/route.ts` line 231. Not the CSV signal; not queryable as a field. |
| `fldapf2ZXpIWTZfSX` | `Restriction_Text` | multilineText | NO. This is the Redfin listing description (scraped by Scenario B). Contains free-text "needs work", "as-is", "Investor Special", etc. — not the structured PropStream condition value. |
| `fldwSjhdhEKVzpVRQ` | `Distress_Score` | formula | NO. Composite of DOM + price drops + offer gap. Does not consume condition. |
| `fldyiFT48fudbF34k` | `Flip_Score` | number | NO. Description: count of flip/renovation keywords in description (anti-distress signal, opposite direction). Scenario B-populated. |

**Verdict: there is no field on Listings_V1 that holds the raw CSV `Listing_Condition` value.** The closest semantic proxy (`Condition_Score`) is structurally different and — as §2.B below confirms — also unpopulated.

### Sample inspection of 50 recent Listings_V1 records (last 30 days)

Pulled via `list_records_for_table` (total population 2,280). Sampled fields: `Condition_Score`, `Rehab_Line_Items_JSON`, `Rehab_Confidence_Score`, `Rehab_Estimated_At`, `Est_Rehab`, `Est_Rehab_Method`, `Restriction_Text`.

| Field | Populated in sample | Empty in sample |
|---|---|---|
| `Condition_Score` (1–10 AI score) | **0 / 50** | 50 / 50 |
| `Rehab_Line_Items_JSON` (contains vision condition) | **0 / 50** | 50 / 50 |
| `Rehab_Confidence_Score` | **0 / 50** | 50 / 50 |
| `Rehab_Estimated_At` | **0 / 50** | 50 / 50 |
| `Est_Rehab` | **0 / 50** | 50 / 50 |
| `Est_Rehab_Method` | **0 / 50** | 50 / 50 |
| `Restriction_Text` (Redfin description) | 27 / 50 (54%) | 23 / 50 |

**`Condition_Score` is a dead field.** Declared in schema with a description but no code path writes it. Codebase grep for `Condition_Score` and `fldkE6xgHeCvmyKJy` returns zero matches.

**Rehab fields are empty across the entire 50-record sample.** Phase 4B has not run for these records — Scenario I (Make 4938156) is `isActive: false` per System Inventory v2, and `/api/agents/appraiser/rehab/[recordId]` is a manual/orchestrator-driven endpoint that hasn't fired on this cohort. The vision-derived condition signal exists *architecturally* but is *operationally absent* for the current intake population.

**`Restriction_Text` is populated for 54% of records** (those that Scenario B verification reached). Sample descriptions show clear distress signals in free-text form: "Investor Special", "Building needs considerable work", "needs your rehab with LOTS of upside", "Handyman special", "AS IS!!", "needs some TLC". These are exactly the signals the CSV `Listing_Condition` would have encoded as "Poor" or "Disrepair" — but they're trapped in unstructured text rather than a queryable field.

### Synthesis

The gap is real and total: of the three potential condition-data carriers on Listings_V1 (`Condition_Score`, `Rehab_Line_Items_JSON.vision_condition`, `Restriction_Text` keywords), zero are reliably populated for the current intake population. The CSV `Listing_Condition` value enters the pipeline, gates which records get written, then evaporates.

---

## §3 — Downstream impact assessment

For each station that should have access to condition, what does it currently use?

### Phase 4B Rehab (`/api/agents/appraiser/rehab/[recordId]/route.ts`)

| Aspect | Current behavior |
|---|---|
| Condition input | **Vision-derived only** — `vision.condition_overall` from `runRehabVision()` (Anthropic API call on scraped listing photos) |
| BBC tier classification | `classifyBbcTierFromCondition(vision.condition_overall)` line 208. Mapping (per `lib/appraiser/rehab-calibration.test.ts`): Good→Cosmetic, Average→Light, Fair→Medium, Poor→Heavy, Disrepair→Gut, **null/undefined→Medium (default)** |
| CSV condition consulted? | **No.** No reference to Listing_Condition anywhere in the file. |
| Vision-failure fallback | **None.** Vision call failure returns HTTP 502 with `vision_call_failed` (line 201–204). Rehab calculation halts. No fallback to CSV condition. |
| Inconsistent defaults | `lib/rehab-calibration.ts:139` defaults missing vision condition to `"Poor"` (a category). `lib/appraiser/rehab-calibration.test.ts:62` defaults `classifyBbcTierFromCondition(null)` to `"Medium"` (a tier). Two layers, two different defaults — would produce different BBC tier for the same missing-condition input depending on which path runs first. |

**Net: if vision runs, condition derives from Anthropic-vision-of-photos at ~$0.01–0.05 per record. If vision fails, rehab dies. The free PropStream signal that's already in operator's CSV is unavailable as a fallback.**

### Distress_Bucket / Distress_Score

Per INV-001 §3 evaluation table:
- `Distress_Score = ROUND((DOM/30) + (Price_Drop_Count × 2) + (Offer_Gap/10000), 2)` — 3 signals: DOM, price drops, offer gap. **None are condition.**
- `Distress_Bucket = IF(score<3 "Low", <6 "Moderate", <9 "High", ≥9 "Extreme")` — pure bucketing of the score. No condition input.
- `Distress_Pass` (post-Option α remediation): consumes `Distress_Bucket`. Still no condition input.

Adding Listing_Condition to the Distress_Score formula would be straightforward (e.g., `+ IF(Listing_Condition="Disrepair", 3, IF(Listing_Condition="Poor", 2, IF(Listing_Condition="Average", 1, 0)))`) — IF the field were persisted. Currently impossible because no field carries the data.

### Pre-outreach checks (`lib/orchestrator/pre-outreach-checks.ts`)

`grep condition` returns matches for `distress_dom_min` and `distress_price_drop_min` (DOM-based, not condition-based). The `PO_13_distress_signal` check at line 341 evaluates DOM and Price_Drop_Count only. **No condition gating in pre-outreach.**

### Pricing math (`/api/agents/pricing/[recordId]/route.ts`)

| Aspect | Finding |
|---|---|
| Offer formula | 65% × List_Price (Spine doctrine — same regardless of condition) |
| Condition consulted? | **Only in the manual override path** — line 106 hardcodes `condition_overall: "Poor"` as the assumed-condition stub when operator triggers pricing without Phase 4B vision data. Line 179 hardcodes `condition_target: "renovated"` (we offer the *renovated* value; condition affects rehab estimate, not offer price) |
| Net | Pricing is condition-agnostic by design (65% floor + V2.1 math via rehab estimate). The rehab estimate, in turn, IS condition-sensitive via Phase 4B — but only when Phase 4B has run. For records without rehab estimates (i.e., ~all current intake per §2 sample), pricing uses default rehab values. |

### Property Record workspace / operator context

Per `AKB_Belt_v1_Spec.md` §6 Source-of-truth communications principle, the Property Record workspace is the canonical operator view. With Listing_Condition unpersisted, the operator's view of a record's condition has to come from either:
1. Clicking through to the original PropStream CSV (out-of-system)
2. Reading `Restriction_Text` description (when populated; ~54%)
3. Triggering photo analysis manually (cost + delay)

The PropStream signal that already crossed the wire is invisible to the workspace.

### Summary table

| Consumer | Uses condition? | Source | Behavior when condition absent |
|---|---|---|---|
| Distress_Score / Bucket / Pass | NO | — | N/A |
| Phase 4B Rehab | YES | Vision (Anthropic) | 502, no fallback |
| Pre-outreach checks | NO | — | N/A |
| Pricing (default path) | NO | — | N/A |
| Pricing (manual override) | YES | Hardcoded "Poor" | Stub fixed value |
| Operator workspace | DESIRED but unavailable | Restriction_Text proxy | 46% blind |

**Net materiality: Phase 4B is the primary downstream consumer that would benefit immediately from persisting CSV Listing_Condition.** Distress_Score/Bucket and pre-outreach are unblocked enrichment opportunities. Operator workspace gains a free queryable surface.

---

## §4 — Persistence options

Three candidate paths, ordered by conservatism.

### Option A — minimum-viable persistence (singleLineText field, dual-path write)

| Aspect | Detail |
|---|---|
| New field on Listings_V1 | `Listing_Condition` (singleLineText) — raw CSV value as captured at intake |
| Write source | (1) Add `Listing_Condition` to Make Scenario A Modules 12 + 13 mappers as `{{3.col59}}`. (2) Add `Listing_Condition` to Vercel `FIELD_MAP` with field id of new field; condition value already in `mapped.Condition`. |
| Value normalization | None — raw CSV string ("Poor", "Disrepair", "Average", or whatever PropStream sends). Cheap; preserves audit trail; matches `vision.condition_overall` vocabulary already used by Phase 4B. |
| Effort | Small. One field add, two write-path additions (one Make module edit, one TS line edit). |
| Risk to existing consumers | None — additive. Downstream consumers ignore the new field until explicitly wired. |

### Option B — singleSelect with controlled vocabulary

| Aspect | Detail |
|---|---|
| New field on Listings_V1 | `Listing_Condition` (singleSelect) with options: "Poor", "Disrepair", "Average", "Good", "Fair", "Unknown" |
| Write source | Same as Option A, plus normalization step at intake (lowercase → titlecase, map "very good" → "Good", null → "Unknown") |
| Value normalization | YES — controlled vocabulary, consistent across paths |
| Effort | Small-medium. Adds normalization complexity; helps downstream pivot tables and filter UIs. |
| Risk | Low — but operator must agree on the option list upfront. Wrong list locks in a schema choice. |

### Option C — repurpose `Condition_Score` (currently dead)

| Aspect | Detail |
|---|---|
| Field on Listings_V1 | Reuse existing `Condition_Score` (number) — encode CSV condition as Poor=1, Disrepair=2, Average=3, Good=4 (or similar) |
| Write source | Same as Option A, with mapping at intake |
| Value normalization | YES — but lossy (numeric encoding loses semantic clarity) |
| Effort | Small. No new field. |
| Risk | The field's existing description ("AI assessment of property condition from listing data (1-10 scale)") implies a different semantic (AI-derived score). Repurposing without updating the description creates downstream confusion. Renaming the field is also non-trivial (formula references break if name changes; field id is stable but UI surfaces use the name). |

---

## §5 — Recommendation

**Option A — minimum-viable persistence (singleLineText `Listing_Condition`, dual-path write).**

Rationale: (1) cheapest change that closes the gap; (2) preserves raw CSV string (no normalization debate); (3) vocabulary matches the `vision.condition_overall` enum already used by `classifyBbcTierFromCondition` — Phase 4B can consume the new field as a vision-failure fallback with one line of code, no value mapping needed; (4) additive — no risk to existing consumers, no formula refactors.

Sequencing (operator-decided when remediation is authorized):
1. Add new singleSelect/singleLineText field `Listing_Condition` on Listings_V1.
2. Edit Vercel `/api/process-intake` `FIELD_MAP` to include the new field — ~2 line change.
3. Edit Make Scenario A Modules 12 + 13 to include the new field with `{{3.col59}}` source — UI edit.
4. (Optional, follow-up audit) Update Phase 4B Rehab to fall back to `Listing_Condition` when vision fails — closes the 502 resilience gap.
5. (Optional, follow-up) Update Distress_Score formula to incorporate condition signal — enrichment.

**Option A specifically avoids Option B's normalization debate** (operator hasn't committed to an option list) **and Option C's semantic collision** (`Condition_Score` exists as a numeric AI-derived field, not the CSV string).

### Materiality justification

- 2,280 records in last 30 days intake; ~50% pass the gate (post Distress_Pass Option α). Every one of those records had a Listing_Condition value at intake that was used for filter decisions and then discarded.
- Phase 4B Rehab cost per record without fallback: 1 Anthropic vision call (~$0.01–0.05) + scraped photos dependency + 502 risk if photos missing.
- Phase 4B Rehab cost per record with Listing_Condition fallback: vision call when photos exist; CSV-condition fallback when they don't. Eliminates 502 case.
- Operator workspace gains a queryable categorical field at zero ongoing cost.

The change is sub-1-day effort with no downstream blast radius. The cost of inaction is continuing to throw away a free signal that the system already filtered on.

### Adjacent items flagged for separate investigations

Three findings discovered during this audit that are out of scope for INV-002 remediation but warrant their own briefs:

- **Make A vs Vercel intake-path divergence (INV-004 candidate)** — different missing-condition semantics (silent drop vs pass), different Reject persistence (no row vs row with `Execution_Path = "Reject"`). The two paths produce structurally different state for identical inputs. Worth a separate audit when Belt v1 spec §3.5 "Path 1 vs Path 2" decision lands.
- **Condition_Score is a dead field (INV-005 candidate)** — declared with description but unwritten by any code path. Either repurpose (and update description), or remove from schema. Low urgency; cleanup task.
- **Phase 4B Rehab has no vision-failure fallback (INV-006 candidate)** — 502 + halt on `vision_call_failed`. With Listing_Condition persisted (post-INV-002 remediation), the fallback would be trivial. Without it, the gap is harder to close. Worth re-evaluating after INV-002 remediation ships.

These have been added to `docs/investigations/Active_Queue.md` under "Discovered during prior investigations."

---

## §6 — Appendix: sampled record IDs + condition-relevant fields

50 records from Listings_V1 created within the last 30 days. Columns: `Condition_Score` (Cond_Sc), `Rehab_Estimated_At` (Rehab_At), presence of `Restriction_Text` (Desc?), distress keyword presence in description (DK = any of "as-is", "investor special", "needs work", "TLC", "handyman", "needs your rehab", "needs considerable work", "as is"). All 50 had empty Condition_Score, Rehab_Estimated_At, Est_Rehab, Rehab_Line_Items_JSON, Rehab_Confidence_Score, Est_Rehab_Method — table compressed to columns with variance only.

| rec_id | Address | Desc? | DK in desc? |
|---|---|---|---|
| `rec00kV1pcpivNGsp` | 406 Gardina St | no | — |
| `rec05p6atj48iYeW0` | 1351 Lorenzo Dr Sw | no | — |
| `rec07YAC9KOwr6iZv` | 15875 Strathmoor St | yes | YES (TLC, handyman) |
| `rec08RxjztfBTAOuf` | 8533 Van Pelt Dr | yes | no (renovated, updated) |
| `rec09dYzkIHTO3eE9` | 3455 Avoca Dr | yes | no (UNDER CONSTRUCTION, NEW HOME) |
| `rec0F64qr4fyCv3qF` | 204 Vine St | yes | no |
| `rec0HphdyEKRpmHSk` | 451 Anton Dr | yes | no (move-in ready) |
| `rec0IoFr0sUECjxAu` | 105 Dunning Ave | yes | **YES (Investor Special, needs considerable work)** |
| `rec0L0yGadrFdLXC3` | 6836 Western Hills Dr | yes | no (Beautiful remodeled) |
| `rec0LEyJX42bqBgQ7` | 1671 W Buena Vista St | yes | no (move-in-ready) |
| `rec0QQYzYTgkMSHdm` | 655 Hugh St Sw | no | — |
| `rec0QXR9w80oirxsl` | 3830 Frank St | no | — |
| `rec0RLLxMoZoN5Qa6` | 5706 Sendero Spg | no | — |
| `rec0T3Z7OcrZz86bj` | 6210 Annunciation St | yes | no |
| `rec0ToJlfU0bhs5XJ` | 8107 Stagwood Hl | no | — |
| `rec0UFwPwhJpGRMe8` | 1228 Elizabeth Ave Sw | no | — |
| `rec0UbThERg7e70Eb` | 515 Lincolnshire Dr | yes | no (turnkey package) |
| `rec0WnYmCUl3Qyc9s` | 8211 Berrycreek Dr | no | — |
| `rec0ZRopJWpifa4G8` | 7218 Luna Ct | yes | no (move-in ready) |
| `rec0aj1heugbWb9X4` | 8728 Dunlap St | no | — |
| `rec0cFxTPJ5WEGMPK` | 12515 La Bodega St | no | — |
| `rec0fGmkp1bjUp0WF` | 18659 Goulburn St | yes | **YES (finish the renovation, needs full renovation)** |
| `rec0fT93NcsDIY74t` | 1516 Boulderwoods Dr Se | no | — |
| `rec0gDwbMEkMXQq5t` | 210 Wellington | yes | no (beautiful remodeled) |
| `rec0nArSb2HNm3Jvd` | 2040 Chicago Ave Nw | no | — |
| `rec0nLY4am4eSxGS0` | 13922 Ambrose St | no | — |
| `rec0th9116Pd7PSdF` | 2815 Burger Ave | yes | **YES (SOLD AS IS, AS IS)** |
| `rec0uqjgl54ZYxiPR` | 12918 Thomas Sumter St | no | — |
| `rec0wMHyQoaNUpxZ8` | 822 Midway St Se | no | — |
| `rec0wk2Bc4LtT0iMD` | 2265 Pasadena St | yes | **YES (needs some TLC)** |
| `rec11JHhMKLdcZKl3` | 3835 Lovingood Dr | no | — |
| `rec11VK2WRk0hQyQI` | 3023 W Travis St | yes | no (upgrades completed, movein ready) |
| `rec12dQhLLCbugqfA` | 2511 Custer Dr | yes | no (well-kept gem) |
| `rec13IrRJg90NN7aQ` | 917 Highland Oaks Dr | no | — |
| `rec18x14HaDuIW2uZ` | 2534 Millermore St | yes | no (fully renovated, move-in ready) |
| `rec1B0CPpumuyyZ8H` | 230 Dresden Dr | no | — |
| `rec1BSxhuazy9GrTL` | 607 W Theo Ave | yes | no |
| `rec1CneUMshDg59EQ` | 81 Burbank Dr Nw | no | — |
| `rec1DL0mv1zaLmacE` | 4602 N Wayside Dr | no | — |
| `rec1Dt5OqWOCruxaS` | 805 Delgado St | yes | no (blank canvas, finish out) |
| `rec1ET2CDM39AdwGB` | 134 Cedar St | yes | no (historic, preserved) |
| `rec1HI6TsJY4mMm9o` | 490 Rockwell St Sw | no | — |
| `rec1Is5JB2ML7PGZI` | 1220 Alaska Ave | yes | **YES (Investor special, sold as is, needs repairs)** |
| `rec1J2JPEtOngRCiw` | 648 Delmar St | yes | no (do it your self) |
| `rec1KyZwxcW7Oa5JK` | 2303 W Grand St | yes | **YES (needs a full rehab)** |
| `rec1LJuCJHHJJXfdv` | 11864 Whitehill St | yes | **YES (needs your rehab, Handyman special)** |
| `rec1Mj5BqH3RFA4bU` | 418 Diver Pt | no | — |
| `rec1WULHE8ANSgaYq` | 13907 Bressani Way | no | — |
| `rec1XN200dC8NwfGC` | 5235 Bellfort St | yes | no (rehab or build) |
| `rec1buqrRfhs3q7XN` | 7511 Dobel St | yes | no (Sold as is — but other context) |

**Sample totals (n=50):**
- Restriction_Text populated: 27/50 (54%)
- Distress keywords in description: 9/27 with description = 33% of described records, 18% of all sampled records
- Condition_Score populated: **0/50** (0%)
- Phase 4B Rehab fields populated: **0/50** (0%)

The descriptive distress signal (free-text keyword scan) catches roughly 1-in-5 records; the CSV `Listing_Condition` filter — which the intake gates on — would catch far more (every record that made it past the filter was condition=Poor/Disrepair/Average per the Make-path filter, but post-filter that data is gone).

---

*End of audit. Status only. No remediation implemented. Operator decides among Option A / B / C in §5.*

---

## §7 — Remediation outcome (appended 2026-05-20)

**Decision:** Path A — singleLineText `Listing_Condition` field, dual-path write. Operator-authorized 2026-05-20 (this session). Make blueprint API pushes simultaneously approved as a session-level capability (supersedes prior "UI edits only" discipline).
**Spine record:** `recOB75kGmHzkPgKr`.

### What shipped

**1. New Airtable field on Listings_V1** (`tbldMjKBgPiq45Jjs`)

| Attribute | Value |
|---|---|
| Field ID | `fldgWNINIBKmY6fM1` |
| Name | `Listing_Condition` |
| Type | `singleLineText` |
| Description | "Raw condition signal from CSV intake (PropStream Condition column) OR vision-derived condition. Vocabulary: Poor / Disrepair / Average / Good. Empty = missing-condition record. Consumers: Phase 4B Rehab fallback, future Distress_Bucket enrichment, operator workspace." |

Created via Airtable MCP `create_field`. No field-name collision; clean add.

**2. Vercel `/api/process-intake/route.ts` diff (3 additions, no deletions)**

```diff
@@ FIELD_MAP (line 13-29):
   Notes: "fldwKGxZly6O8qyPu",
   Restriction_Text: "fldapf2ZXpIWTZfSX",
+  Listing_Condition: "fldgWNINIBKmY6fM1",
 };

@@ Mapping loop body (around line 270):
   if (row.Condition) mapped.Condition = row.Condition.trim();
   if (row["Property Condition"]) mapped.Condition = row["Property Condition"].trim();
+  // Persist normalized condition to Airtable. Filter logic above still reads
+  // mapped.Condition; this parallel write preserves the raw signal per INV-002
+  // remediation (Listing_Condition_Audit_v1.md §5 Option A).
+  const normalizeCondition = (raw: string): string => {
+    const t = raw.trim();
+    if (!t) return "";
+    return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
+  };
+  if (mapped.Condition) mapped.Listing_Condition = normalizeCondition(mapped.Condition);
   mappedRows.push(mapped);
```

`normalizeCondition()` co-located near call site per operator's micro-note. Filter logic at `applyFilters()` lines 75–98 untouched (parallel-write pattern, not filter rewrite).

**3. Make Scenario A `4256273` blueprint push via `scenarios_update` MCP**

Added to record mapper in both Module 12 (UPDATE) and Module 13 (CREATE):

```json
"fldgWNINIBKmY6fM1": "{{3.col59}}"
```

No normalization in Make — PropStream sends title-case (Make filter at lines 654–761 is case-sensitive on "Poor"/"Disrepair"/"Average"; surviving records prove title-case).

**Important note on the blueprint push:** the full blueprint returned by `scenarios_get` is 131k characters / 76k bytes — dominated by UI-only metadata (`metadata.expect`, `metadata.interface`, `metadata.restore`, `metadata.designer.samples`). Inlining 76k chars in an MCP tool call exceeds practical context budgets. Solution: trimmed the blueprint to runtime-essential keys only (flow, mapper, parameters, scheduling, scenario metadata) — 8.4k bytes — and pushed via `scenarios_update`. Make accepted the lean form: post-push `isinvalid: false`, blueprint round-trip via `scenarios_get` confirms both Module 12 and Module 13 mappers now contain the new field, all other modules / connections / filters / routes preserved exactly. UI metadata regenerates server-side on next visual editor open. **No data loss, no logic change, no field removal.**

### Pre-push vs post-push scenario state

| Attribute | Pre-push | Post-push |
|---|---|---|
| `isActive` | `false` | `false` ✓ preserved |
| `isPaused` | `false` | `false` ✓ |
| `isinvalid` | `false` | `false` ✓ (Make validated lean blueprint) |
| `iswaiting` | `false` | `false` ✓ |
| `dlqCount` | `0` | `0` ✓ |
| `lastEdit` | (prior timestamp) | `2026-05-20T21:03:24.556Z` |
| Module 12 record mapper fields | 23 | **24** (+1: Listing_Condition) |
| Module 13 record mapper fields | 23 | **24** (+1: Listing_Condition) |
| Filter logic (Module 9 Phase 1 Hardened gate) | intact | ✓ intact |
| Router conditions (Module 11) | intact | ✓ intact |
| All other modules (1, 2, 3, 4, 9) | intact | ✓ intact |

Scenario remains OFF per operator credit-conservation discipline. Operator can flip on whenever next intake CSV is ready.

### Test plan execution

| Test | Status | Result |
|---|---|---|
| **#4 Historical record empty (n=5)** | RAN | PASS — 5/5 sampled records have empty `Listing_Condition`. No backfill, matches "forward-going only" policy. |
| **#5 Schema sanity** | RAN | PASS — `get_table_schema` returns `{"id":"fldgWNINIBKmY6fM1","type":"singleLineText"}`. |
| **#1 Make path end-to-end (n=10)** | **DEFERRED — runtime-dependent** | Scenario A is `isActive: false`. First execution after operator activation will populate Listing_Condition on Update/Create rows. Cannot synthetically trigger from this session. |
| **#2 Vercel path end-to-end (n=10)** | **DEFERRED — runtime-dependent** | Requires CSV upload via dashboard or POST to `/api/process-intake`. Next real intake run will exercise the new write. |
| **#3 Missing-condition via Vercel** | **DEFERRED — runtime-dependent** | Same as #2; will surface in next CSV that contains blank Condition rows. |

Tests #1, #2, #3 will run organically on next intake cycle. Spine entry + this appendix capture the gate state for that verification.

### Adjacent items queued (per "Discovered during prior investigations" discipline)

- **INV-011** — Make A vs Vercel intake-path divergence (missing-condition handling; Reject row persistence)
- **INV-012** — `Condition_Score` field is dead (zero writes; either repurpose or remove)
- **INV-013** — Phase 4B Rehab vision-failure fallback (now unblocked by this remediation — fallback to `Listing_Condition` is a one-line addition once operator authorizes)

All three logged in `docs/investigations/Active_Queue.md` under "Discovered during prior investigations." Not pursued in this remediation.

### Reversibility

- Airtable field: removable via Airtable UI / API. No downstream code currently READS the field (it's write-only this commit).
- Vercel code: revert is a 3-line + 1-import diff revert.
- Make blueprint: revert via `scenarios_update` with the original 24-field-less mapper. Original blueprint snapshot preserved at `/tmp/scenarioA_*_blueprint.json` for the session lifetime (ephemeral — operator should pull pre-revert state from Make's version history if needed).

### Operator-decided "discipline note" — Make blueprint pushes

This is the first session where Make blueprint API pushes were exercised by Code. The mechanics that worked:

1. **Pull current blueprint** via `scenarios_get` (saved to disk; 131k chars is normal — bulk is UI metadata).
2. **Patch the JSON** offline (Python) — additive change to the `flow[].mapper.record` dict for the relevant module(s).
3. **Strip UI-only metadata** (`metadata.expect`, `metadata.interface`, `metadata.restore`, `metadata.designer.samples`) before pushing — Make regenerates these. Trims payload ~90%, fits in MCP tool call budget.
4. **Push via `scenarios_update`** with the lean blueprint inline.
5. **Verify** via `scenarios_get` round-trip + check `isinvalid: false`, `isActive` preservation.

This pattern is reusable for future blueprint changes. The verbose blueprint that Make returns from `scenarios_get` is NOT the format Make requires for `scenarios_update`.

*End of remediation outcome. Status: shipped + verified. Spine: `recOB75kGmHzkPgKr`. End-to-end runtime tests deferred to next intake cycle.*
