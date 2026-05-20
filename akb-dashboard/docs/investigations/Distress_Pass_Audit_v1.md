# Distress_Pass Evaluation Integrity — Audit v1

**Audit date:** 2026-05-20
**Auditor:** Code
**Scope:** discovery + recommendation only. NO code changes, NO field updates, NO Make scenario edits.
**Triggering question (from Belt v1 spec §8 item 18):** Is the logic that sets `Distress_Pass` (`fldlQJV00psn0vucy`) on Listings_V1 producing a material false-negative rate?
**Companion specs:** `AKB_Belt_v1_Spec.md` §2/§8, `AKB_System_Inventory_v2.md` Q2.

---

## §1 — Setter location(s)

**Finding: there is no "setter." `Distress_Pass` is a formula field on Listings_V1. It is computed, not written.**

The investigation brief asked where the logic that *writes* `Distress_Pass` lives — candidates being Make Scenario A, the Vercel `/api/process-intake` route, or an Airtable automation. None of those write the field. The field is type `formula` on `tbldMjKBgPiq45Jjs` and evaluates deterministically against two upstream fields whenever a record is read.

### What was checked

| Candidate location | Tool used | Result |
|---|---|---|
| Make Scenario A (4256273 — Intake_Loader_V1) blueprint | Make MCP `scenarios_get` — full blueprint dump, 4,961 lines, every module mapper inspected | `Distress_Pass` and `fldlQJV00psn0vucy` appear ONLY in output-interface declarations of Modules 9/12/13 (i.e., the Airtable read-back schema) and in test-record sample output. NO mapper writes the field. The scenario writes 23 basic property fields (address, MLS data, agent info, pricing, condition); none are distress-related. |
| Vercel `/api/process-intake/route.ts` | Read in full (363 lines) | `FIELD_MAP` declares 14 fields (Address, City, State, Zip, List_Price, Agent_Name, Agent_Phone, Agent_Email, Bedrooms, Bathrooms, Building_SqFt, Execution_Path, Notes, Restriction_Text). `Distress_Pass` is not in the map and is never written. The route hardcodes base id `appp8inLAGTg4qpEZ` and listings table `tbldMjKBgPiq45Jjs`. |
| Codebase grep for `Distress_Pass` / `fldlQJV00psn0vucy` | `grep -rni` across `*.ts *.tsx *.js *.json *.py *.md` | Only matches: this spec, the Belt v1 spec, and System Inventory v2. No production code references the field as a write target. |
| Airtable automation on Listings_V1 | Implicitly via schema — Airtable formula fields are not writable | N/A. The field's `type: "formula"` is conclusive — no manual or programmatic write is even possible. |

### The formula body (read via Airtable MCP `get_table_schema`)

```airtable
IF(
  AND({fldfsGAAae2mGXzvC}, {fldrHvFPTyQZ95mFx}, {fldfsGAAae2mGXzvC} >= {fldrHvFPTyQZ95mFx}),
  1,
  0
)
```

Mapped to field names:

```airtable
IF(
  AND({DOM_Calc_V2}, {Cfg_Distress_DOM_Min}, {DOM_Calc_V2} >= {Cfg_Distress_DOM_Min}),
  1,
  0
)
```

### The threshold

`Cfg_Distress_DOM_Min` is a lookup field (`fldrHvFPTyQZ95mFx`) that pulls `Distress_DOM_Min` from the linked Spine_Config record. Active Spine_Config record `rec8d31sIFkt8HlCL` (`Active_Config: true`, `Active: true`) sets:

| Spine_Config field | Value |
|---|---|
| `Distress_DOM_Min` | **60** |
| `Price_Drop_Min` | 1 |

So the operational threshold is **DOM ≥ 60 days**, evaluated lookup-style per record.

### What `DOM_Calc_V2` reads

`DOM_Calc_V2` (`fldfsGAAae2mGXzvC`) is itself a formula: `IF({MLS_Date_Clean}, DATETIME_DIFF(TODAY(), {MLS_Date_Clean}, 'days'))`. `MLS_Date_Clean` is parsed from `MLS_Date_Raw` (the `col66` CSV column). If `MLS_Date_Raw` doesn't parse, `DOM_Calc_V2` is null, the formula's AND() short-circuits, and `Distress_Pass = 0`.

### Implication

The investigation premise — "the setter logic is currently unverified" — resolves cleanly: **the setter is the formula itself, and the formula is fully visible.** There is no hidden ingestion-time logic. Whatever issue exists with rejection volume is a question about the formula's design, not about a buggy writer.

---

## §2 — Ground-truth audit findings

### Population

Pulled via Airtable MCP `list_records_for_table` with filter `Distress_Pass = 0 AND Last_Seen within past 30 days`. Reference query:

- **Rejected on No Distress, last 30 days:** `totalRecordCount = 980`
- **Passed Distress_Pass, last 30 days (control):** `totalRecordCount = 1,300`

The 30-day intake population is roughly **2,280 records**, of which **43% are gated out by `Distress_Pass = 0`** — a single composite formula gate. This is the materiality envelope.

### Sample

Pulled the first 100 rejected records (sorted by record id, page size 100, no skew). All 100 carry `Stage_Calc_V2 = "Rejected: No Distress"` — confirms the formula chain fires exactly as written.

### Why each record was rejected — DOM distribution

| Metric (rejected sample, n=100) | Value |
|---|---|
| DOM populated | 100 / 100 (no MLS-date-missing case in the sample) |
| Min DOM | 6 |
| Max DOM | **59** |
| Median DOM | 35 |
| Mean DOM | 35 |

**Critical: the maximum DOM in the rejected sample is 59 — every record fails the 60-day threshold by at least one day.** None are anywhere near it. The rejection is not a marginal call; it's a structural one against the entire "fresh listing" cohort.

### Cross-reference against `Distress_Score` (the system's own composite distress signal)

`Distress_Score` (`fldwSjhdhEKVzpVRQ`) is a separate Airtable formula on the same table:

```airtable
ROUND( (DOM/30) + (Price_Drop_Count × 2) + (MAX(0, Offer_Gap) / 10000), 2 )
```

`Distress_Bucket` (`fldpFHAXujnz9x72x`) buckets the score: <3 Low, 3–<6 Moderate, 6–<9 High, ≥9 Extreme.

**Distress_Bucket distribution across the 100 rejected records:**

| Bucket | Count | DOM range |
|---|---|---|
| **Extreme** (score ≥ 9) | **39** | 20–58 |
| **High** (score 6–<9) | **44** | 6–59 |
| Moderate (score 3–<6) | 15 | 7–59 |
| Low (score <3) | 2 | 36–40 |

**83 of 100 records (83%) score High or Extreme on the system's own composite distress signal — yet are gated out as not distressed.** The 15 Moderate records are borderline; only 2 Low records would qualify as defensible true-negatives by the score's logic.

### Classification

Using `Distress_Score`'s own bucketing as proxy ground truth (the operator's existing distress taxonomy):

| Class | Definition | Count (n=100) | Rate |
|---|---|---|---|
| **FALSE NEGATIVE** | Gate=0 but score-bucket = High or Extreme | **83** | **83%** |
| BORDERLINE | Gate=0 and score-bucket = Moderate | 15 | 15% |
| TRUE NEGATIVE | Gate=0 and score-bucket = Low | 2 | 2% |

**False-negative rate ≈ 83%** under the system's own existing distress definition.

This is well above the 10% materiality threshold the investigation brief specified.

### Cross-check via downstream signal — Execution_Path

`Execution_Path` of the rejected sample:

| Execution_Path | Count |
|---|---|
| Reject | 68 |
| (null) | 23 |
| Auto Proceed (historical, since flipped) | 5 |
| Manual Review | 4 |

The 5 records carrying `Execution_Path = "Auto Proceed"` are historical artifacts: they advanced at intake, fired through earlier verification, then `Stage_Calc_V2` flipped to "Rejected: No Distress" later (matches the 5/19 audit's note about historical Auto Proceed carry-forward). The 23 nulls are records where Execution_Path simply hasn't been re-evaluated yet.

### Cross-check via description keywords — Restriction_Text

Of the 100 rejected records, 47 had non-null `Restriction_Text` (scraped by Scenario B verification). Of those:

| Keyword | Hits |
|---|---|
| `as-is` / `as is` | 5 |
| `investor special` | 2 |
| `TLC` | 1 |
| `handyman` | 1 |
| `estate sale` | 0 |
| `cash only` | 0 |
| `needs work` | 0 |

Description-keyword distress signals are present at a non-trivial rate (~19% of records with descriptions). These are textbook distressed-listing signals that `Distress_Pass` does not check at all.

### Cross-check via price drops

`Price_Drop_Count` distribution in the rejected sample: **0 records with any price drops.** All 100 are at original list price. This is a sampling artifact of the recent-intake window — drops accumulate over time. Tells us nothing about gate logic, but means `Distress_Score` in this sample is being driven entirely by DOM and Offer_Gap.

### Sanity check on the passing population

Pulled 20 records with `Distress_Pass = 1` (last 30 days, page size 20). DOM range: **60 to 1,201 days**, with one record at 60 exactly. The minimum confirms the gate threshold cleanly: 60+ = pass, 59 or less = fail. The formula does what it says.

---

## §3 — Setter logic evaluation

### What the formula consumes

| Signal | Used by `Distress_Pass`? | Used by `Distress_Score`? | Notes |
|---|---|---|---|
| **Days on market (DOM)** | YES — single gate criterion | YES — `DOM/30` term | The only signal the gate sees |
| **Price drops** (`Price_Drop_Count`) | NO | YES — `drops × 2` term | Available, populated downstream by Scenario K; ignored by gate |
| **Offer_Gap** (List_Price − MAO target) | NO | YES — `gap / 10000` term | Available, formula-driven; ignored by gate |
| **Listing_Condition** (Poor / Disrepair / Average / Good) | NO | NO | Checked at Scenario A intake filter level (record excluded entirely if "Good" or unknown), but never written to Listings_V1 and never re-consumed downstream |
| **Description keywords** (estate sale, as-is, TLC, handyman, cash only, investor special, needs work) | NO | NO | Available in `Restriction_Text` after Scenario B verification; consumed only by `/api/pre-offer-screen` at Phase 11, not at gate time |
| **List price vs AVM / Est_Value** | NO | NO | `Est_Value` exists (`fldySDtSmDPpPAcxZ`) but is documented as "FOR REFERENCE ONLY — never used in offer calculations" and is not consumed by any distress signal |
| **Vacant / off-market / probate / pre-foreclosure status** | NO | NO | Not captured in current Listings_V1 schema |
| **MLS_Date missing** (data quality fail) | Implicitly → 0 (silent rejection) | Implicitly → BLANK | If MLS_Date_Raw doesn't parse, both gate and score go null; record silently dies |

### Gaps the gate doesn't check

The gate's single criterion is "this listing has aged on market past a configurable threshold." It assumes that distress correlates with aging, and aging only. Every other axis of the operator's working definition of distress — physical condition, pricing relative to value, seller-described situation, transaction-type signals — is unchecked at the gate.

### Architectural mismatch — the score is richer than the gate

The same Airtable base contains `Distress_Score` and `Distress_Bucket` formulas that already encode a multi-signal composite. They were authored with the intent that distress is a vector, not a scalar threshold. `Distress_Pass`, the gate that actually controls record advancement through `Stage_Calc_V2`, ignores both and substitutes a single hardcoded threshold. The gate and the score are two formulas living next to each other on the same row, computing related-but-divergent values, with downstream code consuming the gate and not the score.

The 5/19 forensic audit recorded this symptom: 41 of 43 records had `Stage_Calc_V2 = "Rejected: No Distress"`. At the time, the cause was attributed (correctly) to the formula chain; what was not surfaced was that the formula's input variable is one-dimensional. This audit closes that gap.

### Why this isn't a "bug"

The formula does exactly what its expression says. `Distress_DOM_Min = 60` is the active config. DOM ≥ 60 → pass, else → fail. There is no broken edge case, no misreferenced field, no formula syntax error. The formula is mechanically correct. It is *under-spec'd*: it operationalizes "distress" as DOM-only, which is a defensible 2024-era heuristic but inconsistent with the operator's 2026-stated distress taxonomy (condition + price + keywords + DOM) and with the system's own `Distress_Score` formula authored alongside it.

---

## §4 — Recommendation

**Path (c): the setter logic is fundamentally under-spec'd; recommend redesign with explicit distress-signal taxonomy.**

Path (a) is rejected: an 83% false-negative rate against the system's own composite score is not edge-case noise.

Path (b) is rejected: there is no surgical fix because there is no bug. Lowering `Distress_DOM_Min` from 60 to (say) 30 would advance more records, but it would still gate on a single signal, still ignore condition / pricing / keywords, and still produce a structurally narrow filter. A threshold tweak is not the answer.

### Proposed redesign — operator-decided, NOT implemented here

The redesign is a spec decision for the operator. Three candidate shapes, in order of conservatism:

**Option α — gate on existing `Distress_Bucket`:**
Change `Distress_Pass` to `IF({Distress_Bucket} = "High" OR {Distress_Bucket} = "Extreme", 1, 0)`. Reuses an existing formula and existing thresholds; immediately recovers ~83% of currently-rejected records. Still ignores Listing_Condition and description keywords. Single-edit change to one formula. Most conservative; defensible as "the system was already computing the right answer in `Distress_Bucket`; just consume it."

**Option β — multi-signal explicit gate:**
Rewrite `Distress_Pass` as `IF(OR({Distress_Bucket} ∈ {High, Extreme}, {Listing_Condition} ∈ {Poor, Disrepair}, description-has-distress-keyword), 1, 0)`. Requires a description-keyword formula companion field; would consume Restriction_Text via a regex/find expression. Broader recovery; introduces ambiguity (where do "Average" condition + low DOM + 1 price drop sit?) that needs explicit per-axis thresholds.

**Option γ — retire the boolean gate; route on Distress_Score directly:**
Replace `Stage_Calc_V2`'s `"Rejected: No Distress"` branch with a tiered route: score ≥ 6 → Auto Proceed candidate, 3 ≤ score < 6 → Manual Review, score < 3 → Reject. Eliminates the binary cliff; gives the operator a graduated dial. Larger refactor; impacts `Stage_Calc_V2` formula and downstream Execution_Path consumers.

### Materiality justification

980 records in the last 30 days carry `Distress_Pass = 0`. At an 83% false-negative rate by the system's own score, ~813 of those records are real candidates the belt has never seen. At even a 1% downstream conversion rate (intake → contract), that's ~8 missed deals per 30-day cycle from this gate alone. The cost of redesign (one to three formula edits, no new fields needed for Option α) is dramatically less than the cost of the current false-negative volume.

### Adjacent concerns flagged but out of scope

- **Listing_Condition is filtered at Scenario A but never persisted to Listings_V1.** The intake filter rejects records with "Good"/"Excellent" condition labels, but the surviving "Poor"/"Disrepair"/"Average" label is dropped before write. Downstream code cannot consume it because it's not there. If Listing_Condition becomes part of a redesigned gate, intake will need to persist the field.
- **Stage_Calc and Stage_Calc_V2 are sibling formulas** (`fldDCGwYvt7b8fNCj` and `fldA8B9zOCneF0rjp`) — different copy ("Rejected – Not Distressed" vs "Rejected: No Distress"), same gate logic. If gate logic changes, both should change together to avoid mixed-state legacy data.
- **Distress_Recheck_Flag** (`fld6LD21Qu4nAA1WK`) already flags records where price drops ≥ 2 OR DOM ≥ 45 OR score ≥ 6. This formula encodes an implicit "this looks distressed, take a second look" signal that could be the seed of Option β's multi-axis gate.

### What the operator decides next

This audit ends at the recommendation. Implementation requires an operator-side decision among α/β/γ, and that decision interacts with the broader Belt v1 spec (currently §4 marks Verification as `replace-with-Firecrawl-native` — Firecrawl-time would be a natural moment to also consume description keywords for the gate). Whichever path is chosen, the formula edit itself is small (one to three Airtable formula updates, no new fields under Option α).

---

## §5 — Appendix: sampled record IDs + classifications

Audit trail. 100 records, sorted by record id, all carrying `Distress_Pass = 0` and intake-dated within the last 30 days. Class column: `FN` = false negative (Distress_Bucket = High or Extreme), `BORDER` = Moderate, `TN` = Low.

| rec_id | Address | City | ST | List_Price | DOM | Drops | Score | Bucket | Exec_Path | Class |
|---|---|---|---|---|---|---|---|---|---|---|
| `rec00kV1pcpivNGsp` | 406 Gardina St | San Antonio | TX | $130,000 | 41 | 0 | 5.92 | Moderate |  | BORDER |
| `rec07YAC9KOwr6iZv` | 15875 Strathmoor St | Detroit | MI | $79,000 | 36 | 0 | 3.97 | Moderate | Reject | BORDER |
| `rec08RxjztfBTAOuf` | 8533 Van Pelt Dr | Dallas | TX | $465,000 | 50 | 0 | 17.94 | Extreme | Reject | FN |
| `rec0F64qr4fyCv3qF` | 204 Vine St | San Antonio | TX | $164,900 | 32 | 0 | 6.83 | High | Reject | FN |
| `rec0IoFr0sUECjxAu` | 105 Dunning Ave | San Antonio | TX | $185,000 | 21 | 0 | 7.18 | High | Reject | FN |
| `rec0QQYzYTgkMSHdm` | 655 Hugh St Sw | Atlanta | GA | $347,000 | 20 | 0 | 12.82 | Extreme | Reject | FN |
| `rec0RLLxMoZoN5Qa6` | 5706 Sendero Spg | San Antonio | TX | $279,000 | 30 | 0 | 10.78 | Extreme |  | FN |
| `rec0WnYmCUl3Qyc9s` | 8211 Berrycreek Dr | San Antonio | TX | $210,000 | 17 | 0 | 7.92 | High |  | FN |
| `rec0ZRopJWpifa4G8` | 7218 Luna Ct | San Antonio | TX | $169,000 | 29 | 0 | 6.89 | High | Reject | FN |
| `rec0cFxTPJ5WEGMPK` | 12515 La Bodega St | San Antonio | TX | $235,000 | 54 | 0 | 10.03 | Extreme | Reject | FN |
| `rec11JHhMKLdcZKl3` | 3835 Lovingood Dr | Dallas | TX | $210,000 | 33 | 0 | 8.45 | High | Reject | FN |
| `rec12dQhLLCbugqfA` | 2511 Custer Dr | Dallas | TX | $275,000 | 27 | 0 | 10.53 | Extreme | Reject | FN |
| `rec18x14HaDuIW2uZ` | 2534 Millermore St | Dallas | TX | $370,000 | 50 | 0 | 14.62 | Extreme | Reject | FN |
| `rec1B0CPpumuyyZ8H` | 230 Dresden Dr | San Antonio | TX | $228,700 | 38 | 0 | 9.26 | Extreme |  | FN |
| `rec1DL0mv1zaLmacE` | 4602 N Wayside Dr | Houston | TX | $99,000 | 7 | 0 | 3.71 | Moderate | Auto Proceed | BORDER |
| `rec1Is5JB2ML7PGZI` | 1220 Alaska Ave | Dallas | TX | $165,000 | 32 | 0 | 6.84 | High | Reject | FN |
| `rec1KyZwxcW7Oa5JK` | 2303 W Grand St | Detroit | MI | $45,000 | 57 | 0 | 3.47 | Moderate | Reject | BORDER |
| `rec1WULHE8ANSgaYq` | 13907 Bressani Way | San Antonio | TX | $290,000 | 49 | 0 | 11.78 | Extreme |  | FN |
| `rec1XN200dC8NwfGC` | 5235 Bellfort St | Houston | TX | $90,000 | 36 | 0 | 4.35 | Moderate | Reject | BORDER |
| `rec1g5krAR5n6Q95v` | 7108 Eastwood St | Houston | TX | $199,888 | 25 | 0 | 7.82 | High | Manual Review | FN |
| `rec1keLkXxbC30ZAu` | 819 Saint James | San Antonio | TX | $455,000 | 43 | 0 | 17.36 | Extreme | Reject | FN |
| `rec1kmaIfq1BectTq` | 5505 Malmedy Rd | Houston | TX | $210,000 | 44 | 0 | 8.82 | High | Reject | FN |
| `rec1nPfSOj6E8JPgv` | 6604 Conley St | Houston | TX | $99,882 | 7 | 0 | 3.72 | Moderate | Reject | BORDER |
| `rec1plmUSIRMS4JCr` | 4509 Kingsbury St | Houston | TX | $162,900 | 32 | 0 | 6.76 | High | Reject | FN |
| `rec1s5wQYvNiADhp8` | 4914 Yellowstone Blvd | Houston | TX | $159,000 | 34 | 0 | 6.71 | High | Reject | FN |
| `rec1yMf8oHfx1ei3z` | 7439 Circle Farm | San Antonio | TX | $165,000 | 39 | 0 | 7.08 | High | Reject | FN |
| `rec20I2fpeXHYQMfn` | 2651 Anderson St | Dallas | TX | $214,900 | 35 | 0 | 8.68 | High | Reject | FN |
| `rec21qaoncpt5Sdgk` | 241 Peabody Ave #3 | San Antonio | TX | $179,000 | 54 | 0 | 8.08 | High | Reject | FN |
| `rec22Kghf0TvhAQwj` | 108 Sunnyland Dr | San Antonio | TX | $174,999 | 34 | 0 | 7.26 | High |  | FN |
| `rec2Lz5L3ehajWrXb` | 2908 Scottsbluff Dr | Dallas | TX | $255,000 | 34 | 0 | 10.06 | Extreme | Reject | FN |
| `rec2Mhx7eyn7f8UjJ` | 4520 Utah Ave | Dallas | TX | $224,998 | 49 | 0 | 9.51 | Extreme | Reject | FN |
| `rec2S8YSZZhv6ZlT4` | 405 Frio City Rd | San Antonio | TX | $45,000 | 40 | 0 | 2.91 | Low | Reject | TN |
| `rec2VqY6nPjiTcj4L` | 7465 14th St | Detroit | MI | $40,000 | 36 | 0 | 2.60 | Low | Reject | TN |
| `rec2b4UDrUdViN2y9` | 3234 Falcon Grove Dr | San Antonio | TX | $285,000 | 21 | 0 | 10.68 | Extreme |  | FN |
| `rec2ciQzlyjQ8Khc3` | 2837 Gresham Rd Se | Atlanta | GA | $225,000 | 22 | 0 | 8.61 | High | Reject | FN |
| `rec2qYbg7oeLVZEjl` | 1115 Indian Creek Trl | Dallas | TX | $249,000 | 25 | 0 | 9.56 | Extreme | Reject | FN |
| `rec2r44vvJUz32tGr` | 8130 Panay Dr | Houston | TX | $182,000 | 29 | 0 | 7.34 | High | Reject | FN |
| `rec2uVwH4Lm8r23kX` | 5910 Wales St | San Antonio | TX | $225,000 | 39 | 0 | 9.18 | Extreme | Reject | FN |
| `rec2ulcrKX2gB1HgD` | 4114 Dakota Sun | San Antonio | TX | $154,900 | 53 | 0 | 7.18 | High |  | FN |
| `rec2wlmvkJl9QYAwU` | 1855 Oakmont Dr Nw | Atlanta | GA | $109,900 | 21 | 0 | 4.54 | Moderate | Reject | BORDER |
| `rec2wr0Q6TmK1lbBp` | 1214 W Winnipeg Ave | San Antonio | TX | $265,000 | 48 | 0 | 10.88 | Extreme | Reject | FN |
| `rec34WXoTUQDvqBfJ` | 2330 Idaho Ave | Dallas | TX | $275,000 | 30 | 0 | 10.63 | Extreme | Reject | FN |
| `rec36dkX7zt9b1PhL` | 4435 Hall Park Dr | San Antonio | TX | $170,000 | 26 | 0 | 6.82 | High |  | FN |
| `rec39k6S10GqFP5d0` | 10636 Wessex Dr | Dallas | TX | $205,000 | 48 | 0 | 8.78 | High | Manual Review | FN |
| `rec3A3OCmNt9JtArd` | 9427 London Bridge Sta | Houston | TX | $476,800 | 29 | 0 | 17.65 | Extreme | Reject | FN |
| `rec3GPHTQkJGvYNOH` | 5242 Grace Point Ln | Houston | TX | $229,950 | 15 | 0 | 8.55 | High | Auto Proceed | FN |
| `rec3GmTsE67SR0Pgs` | 3939 Tristan St | Houston | TX | $130,000 | 29 | 0 | 5.52 | Moderate | Reject | BORDER |
| `rec3Ij595KZ7hSpg0` | 351 Carroll St | San Antonio | TX | $171,000 | 25 | 0 | 6.81 | High | Manual Review | FN |
| `rec3L6CjIHaNftTH3` | 7818 Braun Bnd | San Antonio | TX | $300,000 | 50 | 0 | 12.17 | Extreme |  | FN |
| `rec3PeJP8XSdGAIH3` | 2266 Sutter St | Dallas | TX | $249,999 | 29 | 0 | 9.72 | Extreme | Reject | FN |
| `rec3SKQIG47xZCSgM` | 7702 Hedrick Farm | San Antonio | TX | $229,900 | 43 | 0 | 9.47 | Extreme |  | FN |
| `rec3TLJD5Y9Qletgr` | 11062 Milhof Dr | Dallas | TX | $374,900 | 43 | 0 | 14.55 | Extreme | Reject | FN |
| `rec3cTgDcpwTmFQbs` | 2705 Warren Ave | Dallas | TX | $220,000 | 29 | 0 | 8.67 | High | Reject | FN |
| `rec3gM2qwmhNc8iGM` | 1203 Saltillo St | San Antonio | TX | $179,999 | 35 | 0 | 7.47 | High | Reject | FN |
| `rec3j8ddIs7lrb2mh` | 7415 Lacey Oak Path | San Antonio | TX | $174,900 | 46 | 0 | 7.65 | High | Reject | FN |
| `rec3m5Y6XOUNerBCb` | 5935 Southseas St | Houston | TX | $195,000 | 6 | 0 | 7.03 | High | Auto Proceed | FN |
| `rec3nrc3pnUmJnjoS` | 10419 Idared | San Antonio | TX | $264,900 | 22 | 0 | 10.00 | Extreme | Auto Proceed | FN |
| `rec3oUqYASVMD0mWL` | 6208 Sidney St | Houston | TX | $115,000 | 56 | 0 | 5.89 | Moderate | Auto Proceed | BORDER |
| `rec3p9AUYQ9my2K3Z` | 398 Sawtell Ave Se | Atlanta | GA | $89,900 | 19 | 0 | 3.77 | Moderate | Reject | BORDER |
| `rec3uH9VI0ySKqE0H` | 9515 Apple Ridge Ln | San Antonio | TX | $217,500 | 29 | 0 | 8.57 | High |  | FN |
| `rec3weGoKmpMUe9pN` | 2846 Wyoming St | San Antonio | TX | $185,000 | 34 | 0 | 7.61 | High |  | FN |
| `rec3zP9UJmIUOB4MA` | 5519 Irish Hill Dr | Houston | TX | $260,000 | 39 | 0 | 10.40 | Extreme | Reject | FN |
| `rec47YJLdQquEutql` | 780 Emberwood Dr | Dallas | TX | $190,000 | 42 | 0 | 8.05 | High | Reject | FN |
| `rec4FEGkIeOHpY2nu` | 321 Huntington | San Antonio | TX | $144,400 | 22 | 0 | 5.80 | Moderate | Reject | BORDER |
| `rec4GNM3YjYrl49ad` | 6250 Candleview Ct | San Antonio | TX | $150,000 | 46 | 0 | 6.78 | High |  | FN |
| `rec4LfG4hvvVAYltD` | 8049 Woodhue Rd | Dallas | TX | $399,500 | 40 | 0 | 15.31 | Extreme | Reject | FN |
| `rec4OS7BUS9QoR9Hw` | 1735 Michigan Ave | Dallas | TX | $524,900 | 44 | 0 | 19.83 | Extreme | Reject | FN |
| `rec4P5ruD1kDAEuDQ` | 1759 Gross Rd | Dallas | TX | $280,000 | 36 | 0 | 11.00 | Extreme | Reject | FN |
| `rec4XjkxGP3PdCCjY` | 4806 Appaloosa Run | San Antonio | TX | $184,900 | 47 | 0 | 8.03 | High | Reject | FN |
| `rec4XxNf2is5GuJXP` | 5866 Summer Fest Dr | San Antonio | TX | $164,990 | 49 | 0 | 7.41 | High |  | FN |
| `rec4YMbODyPngyhKE` | 5434 Green Grove St | San Antonio | TX | $200,000 | 34 | 0 | 8.13 | High | Reject | FN |
| `rec4Yz81hdjflxWf1` | 7806 Nopalitos Cv | San Antonio | TX | $155,000 | 46 | 0 | 6.96 | High |  | FN |
| `rec4inULgSWRHQ74u` | 423 Timberlane Dr | San Antonio | TX | $224,000 | 35 | 0 | 9.02 | Extreme |  | FN |
| `rec4j5vtEy7uT1AYT` | 1714 Emerald Ave Sw | Atlanta | GA | $165,000 | 23 | 0 | 6.54 | High | Reject | FN |
| `rec4sM4Oblppma7ZH` | 9410 Rosehaven Dr | Houston | TX | $210,000 | 33 | 0 | 8.45 | High | Reject | FN |
| `rec4sWVs0M83rgwrV` | 1932 E Highland Blvd | San Antonio | TX | $99,000 | 59 | 0 | 5.44 | Moderate | Reject | BORDER |
| `rec4yk6qEn5slBDsZ` | 965 Stokeswood Ave Se | Atlanta | GA | $350,000 | 29 | 0 | 13.22 | Extreme | Reject | FN |
| `rec50e3W1wj3k0CPy` | 721 Woodacre Dr | Dallas | TX | $205,000 | 58 | 0 | 9.11 | Extreme | Reject | FN |
| `rec57AazUuAAcja8g` | 1331 Michigan Ave | Dallas | TX | $340,000 | 43 | 0 | 13.33 | Extreme | Manual Review | FN |
| `rec5EXLiM9fhcKTnj` | 9117 Brandon St | Houston | TX | $147,900 | 37 | 0 | 6.40 | High | Reject | FN |
| `rec5EYbRykFNHBejN` | 5751 Indian Sky Dr | San Antonio | TX | $155,000 | 59 | 0 | 7.39 | High |  | FN |
| `rec5M3wVyaK8bIsRc` | 6318 Illinois St | Houston | TX | $250,000 | 47 | 0 | 10.32 | Extreme | Reject | FN |
| `rec5ONJg7wuSW0NNw` | 5950 Doolittle Blvd | Houston | TX | $99,000 | 42 | 0 | 4.88 | Moderate | Reject | BORDER |
| `rec5RXc5ypSXcBw1a` | 4634 Kay Ann Dr | San Antonio | TX | $135,000 | 47 | 0 | 6.29 | High | Reject | FN |
| `rec5SapIRL2E41M6y` | 2321 Hartline Dr | Dallas | TX | $454,000 | 32 | 0 | 16.97 | Extreme | Reject | FN |
| `rec5g2C3TK8rB0ocN` | 2236 Hartline Dr | Dallas | TX | $450,000 | 47 | 0 | 17.32 | Extreme | Reject | FN |
| `rec5jEllOK3BwAyyO` | 1527 Firwick Dr | San Antonio | TX | $275,000 | 48 | 0 | 11.23 | Extreme |  | FN |
| `rec5ntyGhHbnzBAMi` | 2120 Healey Dr | Dallas | TX | $405,000 | 28 | 0 | 15.11 | Extreme | Reject | FN |
| `rec5qLraZdQ3mJd7w` | 311 Cottonwood Ave | San Antonio | TX | $195,000 | 27 | 0 | 7.73 | High | Reject | FN |
| `rec5y8UvNNTxGrOz1` | 2040 W Laurel | San Antonio | TX | $85,000 | 36 | 0 | 4.18 | Moderate |  | BORDER |
| `rec5yyXDzWAs09t6R` | 5739 Waterford Dr | Houston | TX | $200,000 | 42 | 0 | 8.40 | High | Reject | FN |
| `rec61dIa1h77PzXSS` | 4209 Leland College Dr | Dallas | TX | $195,000 | 28 | 0 | 7.76 | High | Reject | FN |
| `rec62XZvey2ZExO05` | 9055 Levelland | San Antonio | TX | $255,000 | 56 | 0 | 10.79 | Extreme |  | FN |
| `rec66Bc0FSX5n45hh` | 6248 Valley Queen | San Antonio | TX | $177,000 | 24 | 0 | 7.00 | High |  | FN |
| `rec6BlclMZi8YvBFD` | 809 Leal St | San Antonio | TX | $94,500 | 21 | 0 | 4.00 | Moderate | Reject | BORDER |
| `rec6SiDKYivTtcUI2` | 4531 Eisenhauer Rd | San Antonio | TX | $197,500 | 22 | 0 | 7.63 | High |  | FN |
| `rec6U5IyAnq0VZwbc` | 6245 Fenway St | Dallas | TX | $255,000 | 35 | 0 | 10.09 | Extreme | Reject | FN |
| `rec6VydYVcB35744G` | 1426 Alaska Ave | Dallas | TX | $468,999 | 28 | 0 | 17.36 | Extreme | Reject | FN |
| `rec6ZRXzlScdFmbGL` | 11058 Tree Line | San Antonio | TX | $167,500 | 46 | 0 | 7.38 | High | Reject | FN |
| `rec6bSrirDaBWTAev` | 435 Belmont | San Antonio | TX | $220,000 | 54 | 0 | 9.50 | Extreme | Reject | FN |

**Appendix totals:** 100 records | 83 FN | 15 BORDER | 2 TN. FN rate = 83%.

---

*End of audit. Status only. No fixes implemented. Operator decides next step among Path α / β / γ in §4.*

---

## §6 — Remediation outcome (appended 2026-05-20)

**Decision:** Path α — consume `Distress_Bucket`. Operator-authorized 2026-05-20 (this session).
**Spine record:** `rece3J2f0TbHXOuE2`.
**Implementation:** single Airtable formula update via `update_field` MCP. No code, no Make scenarios, no other fields touched. Stage_Calc V1 untouched per spec (V1 broadens as intended side-effect since both formulas consume `Distress_Pass`).

### Formula change

**Before** (verbatim):

```airtable
IF(
  AND({fldfsGAAae2mGXzvC}, {fldrHvFPTyQZ95mFx}, {fldfsGAAae2mGXzvC} >= {fldrHvFPTyQZ95mFx}),
  1,
  0
)
```

**After** (verbatim, verified via post-change `get_table_schema` round-trip):

```airtable
IF(
  OR({fldpFHAXujnz9x72x} = "High", {fldpFHAXujnz9x72x} = "Extreme", {fldpFHAXujnz9x72x} = "Moderate"),
  1,
  0
)
```

`referencedFieldIds` changed from `["fldfsGAAae2mGXzvC", "fldrHvFPTyQZ95mFx"]` (DOM + DOM_Min) to `["fldpFHAXujnz9x72x"]` (Distress_Bucket).

### Operator framing

Distress_Pass is the **permissive floor**, not the precise filter. Downstream stations (Stage_Calc_V2's other rejection branches, pricing math, pre-outreach checks, Execution_Path) carry the per-record verdict. Moderate-bucket records are the volume opportunity and shouldn't be excluded at the floor. The 7–17% gate-out target floated in the original brief was a sanity-check guardrail against the broken 43% gate, not a measured operational target — ~2% gate-out is acceptable given the gate's role as a floor.

### Post-change audit (30-day window, same query as §2)

Re-ran the identical Airtable `list_records_for_table` filter (`Distress_Pass = 0 AND Last_Seen within past 30 days`) immediately after the formula update. Total 30-day population unchanged at 2,280 records.

| Metric | Pre-change | Post-change | Δ |
|---|---|---|---|
| Distress_Pass = 0 (rejected on no-distress) | 980 | **35** | −945 (−96%) |
| Distress_Pass = 1 (passing the gate) | 1,300 | **2,245** | +945 |
| Gate-out rate | 43.0% | **1.5%** | −41.5 pp |

All 35 remaining rejections carry `Distress_Bucket = "Low"` — formula consumes the bucket cleanly, behaves exactly as designed. Spot-check on rejected sample confirms `Stage_Calc_V2` now returns `"Rejected: No Distress"` only for Low-bucket records (with one outlier hitting `"Rejected: Price Floor"` instead — multi-gate cascade still works correctly).

### N=100 sample re-classification (from §2)

The same 100 record IDs from the original audit (Appendix §5):

| Original class | Count | Post-change Distress_Pass |
|---|---|---|
| FN (gate=0, bucket=High/Extreme) | 83 | now 1 (advanced to belt) |
| BORDER (gate=0, bucket=Moderate) | 15 | now 1 (advanced per Moderate→1 mapping) |
| TN (gate=0, bucket=Low) | 2 | still 0 (defensibly rejected) |

98 of 100 previously-rejected records now pass. The 2 TN continue to reject — that's the floor doing the one thing it should still do.

### Reversibility

Single formula expression. Revertible via the same `update_field` call with the original formula body. No data was written; no fields were created; no schema was changed. Pre-change formula preserved verbatim above for audit trail.

### Adjacent items now queued

Spawned during this remediation, added to `docs/investigations/Active_Queue.md`:
- **INV-002** — Listing_Condition persistence (filtered at intake, dropped before write; high-leverage once persisted)
- **INV-003** — Stage_Calc V1 vs V2 sibling formulas (migration artifact; V1 deprecation candidate)

Both deferred — not in scope for this remediation.

*End of remediation outcome. Status: shipped + verified. Spine: `rece3J2f0TbHXOuE2`.*
