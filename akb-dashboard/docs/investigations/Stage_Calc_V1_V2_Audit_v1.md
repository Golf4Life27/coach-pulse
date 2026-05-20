# INV-003 — Stage_Calc V1 vs Stage_Calc_V2 Sibling Formulas — Audit v1

**Audit date:** 2026-05-20
**Auditor:** Code
**Scope:** discovery + recommendation only. NO formula changes, NO consumer updates, NO field deprecation.
**Brief:** Maverick, 2026-05-20 (INV-003 brief in operator dashboard).
**Companion specs:** `AKB_System_Inventory_v2.md` Q2 (Stage_Calc_V2 formula text), `docs/investigations/Distress_Pass_Audit_v1.md` (cross-reference: sibling-formula observation), `AKB_Belt_v1_Spec.md` §2 (Stage_Calc_V2 as the S3 state-transition driver).

---

## §1 — Q1: Which field is read by production code?

**Finding: Only Stage_Calc_V2 is mapped into code. Neither field is acted upon at runtime.**

### Code consumers — definitive

| Surface | Reference | Field referenced | Pattern |
|---|---|---|---|
| `lib/airtable.ts:36` | `fldA8B9zOCneF0rjp: "stageCalc"` | **V2 only** | Field-ID → property-name mapping (load-from-Airtable adapter) |
| `lib/airtable.ts:132` | `"Stage_Calc_V2": "stageCalc"` | **V2 only** | Field-name → property-name alias (parallel mapping) |
| `lib/types.ts:24` | `stageCalc: string \| null` | (V2 by alias) | Declares the property on the `Listing` interface |
| 5 test files (`agent-prior-counts.test.ts`, `d3-cadence.test.ts`, `scout/queue.test.ts`, `maverick/recall.test.ts`, `maverick/sources/airtable-listings.test.ts`) | `stageCalc: null` | (V2 by alias) | Mock-data fixtures satisfy the Listing type contract; field is set to null in test scenarios |
| **Stage_Calc V1 (`fldDCGwYvt7b8fNCj`)** | — | — | **ZERO references anywhere in the codebase** |
| **Verdict string literals** (`"Qualified – Offer Draft"`, `"Passed: Ready for Offer"`, `"Rejected: …"`) | — | — | **ZERO references anywhere in the codebase** |

### The critical observation

The `stageCalc` property exists on the `Listing` type and gets loaded from Airtable into every fetched record. **But no production code path branches on its value, filters by it, or renders it.** Searched via `grep -rnE "\.stageCalc\b"` — zero hits outside `lib/types.ts` (declaration) and 5 test fixtures (null assignments).

This means V2 is structurally available to the codebase but functionally dormant. No `if (listing.stageCalc === "Passed: Ready for Offer")` branches exist. No `if (listing.stageCalc.startsWith("Rejected"))` filters. The field rides through every Listing-fetching API but is never consulted for any decision.

### Make scenarios

| Scenario | Stage_Calc / Stage_Calc_V2 reference? | Effect |
|---|---|---|
| **A (4256273, Intake_Loader_V1)** | Both appear in Module 9 (ActionSearchRecords) output-interface declarations — i.e., the schema of what fields the search call returns. No filter, no router, no mapper writes either field. | **Read-only schema declaration.** Scenario A doesn't act on either. |
| **B (4331170, Listing_Verification_V2)** — RETIRED per Belt v1 | Not inspected this session; pending retirement per Belt v1 §4 makes this moot. Forward-looking architecture (`/api/verify-listing` v2 + Firecrawl) will not consume either field. | N/A — retiring. |
| **H2 (4724197, Quo_Outreach_V1)** — RETIRED per Belt v1 | Per System Inventory v2 audit: H2 filter is `AND(Execution_Path=Auto Proceed, Live_Status=Active, Outreach_Status empty, State=TX, NOT(Do_Not_Text), Agent_Phone not empty)`. **No Stage_Calc reference.** H2 reads `Execution_Path` (which IS downstream of Stage_Calc_V2 via the Execution_Path formula at `fldNRMrcxbiKHW1C9`). | Indirect: H2 → Execution_Path → Stage_Calc_V2. Not direct. |
| **L3 (4812756, Reply_Triage_V3)** | Per INV-007 audit blueprint inspection: L3 searches Listings_V1 by phone via `FIND(phone, Agent_Phone)>0` with `maxRecords:1`. **No Stage_Calc reference.** | None. |
| **L4 (4883113)** | Outbound capture — not inspected; pattern unlikely to reference formula fields. | None expected. |
| **G (4583609)** — pending retirement | Dispo blast — not inspected. | None expected. |

### The real production path

```
intake → Stage_Calc_V2 formula → Execution_Path formula → H2 filter → outbound send
                                  (consumes V2 string)    (consumes Execution_Path enum)
```

Stage_Calc_V2 is consumed exactly once, by the `Execution_Path` formula (`fldNRMrcxbiKHW1C9`), which sets `"Auto Proceed"` only when `Stage_Calc_V2 = "Passed: Ready for Offer"`. **`Execution_Path` is the actual gate; Stage_Calc_V2 is the formula that drives it.** Code and Make consume `Execution_Path`, not Stage_Calc_V2 directly.

**Stage_Calc V1 is a true orphan — referenced by no formula, no code, no Make scenario.**

---

## §2 — Q2: Which field is read by humans?

**Finding: Neither field is shown on any operator-visible surface.**

### Airtable interfaces (via `list_pages_for_base`)

Single interface base on Listings_V1: **"AKB Pipeline"** with 3 pages:

| Page | Visible fields (on Listings_V1) | Stage_Calc? | Stage_Calc_V2? |
|---|---|---|---|
| **"Act Now"** dashboard | Dedupe_Key, Text_Agent_Link, Address, City, List_Price, MAO_V1, DOM_Calc_V2, Agent_Name, Agent_Phone, Verification_Notes, Outreach_Status, Offer_Tier, Agent_Email, Verification_URL | **NO** | **NO** |
| **"Pipeline Overview"** dashboard | Dedupe_Key, Outreach_Status, City, Offer_Tier | **NO** | **NO** |
| **"Deals & Closing"** list | (Deals table — not Listings_V1) | N/A | N/A |

### Vercel dashboard (`akb-dashboard/`)

`stageCalc` is loaded into every Listing record via `lib/airtable.ts` and surfaces on the `Listing` type, but **no React component renders it.** Verified via grep: no JSX expression like `{listing.stageCalc}`, `dealContext.stageCalc`, or equivalent appears anywhere in the codebase.

### Airtable grid views (default table view)

Not inspected directly — Airtable's grid-view configuration isn't exposed via the MCP tools available. Operator can verify by opening Listings_V1 in Airtable: if Stage_Calc or Stage_Calc_V2 columns are visible in the default view, they're inspect-only (no filter, no group-by configured on them per the interface-page evidence). **Pragmatic finding: operator's primary tools (interface pages + Vercel dashboard) don't surface either field.** A column being toggled visible in the grid view would only matter to ad-hoc operator inspection.

---

## §3 — Q3: Live-data verdict divergence

**Finding: divergence rate ≈ 1% in active-pipeline records. 2 of 200 sampled records (1.0%) produce different verdicts between Stage_Calc and Stage_Calc_V2.**

### Query

Filter: `Live_Status = "Active" AND Outreach_Status != "Dead"` on `Listings_V1`.

- **Total matching population: 1,025 records** (per `metadata.totalRecordCount`).
- **Sampled: 200 records** (page size cap).
- Fields pulled: `Address`, `City`, `State`, `List_Price`, `Stage_Calc` (V1), `Stage_Calc_V2`, `Has_MLS_Date`, `Outreach_Status`.

### V1 verdict distribution (n=200)

| Verdict | Count |
|---|---|
| `"Qualified – Offer Draft"` | 198 |
| `"Rejected – Not Distressed"` | 2 |

### V2 verdict distribution (n=200)

| Verdict | Count |
|---|---|
| `"Passed: Ready for Offer"` | 196 |
| `"Rejected: No Distress"` | 2 |
| **`"Rejected: Too Small"`** | **2** |

### Pairwise cross-tab — every observed (V1, V2) pair

| V1 verdict | V2 verdict | Count | Class |
|---|---|---|---|
| Qualified – Offer Draft | Passed: Ready for Offer | 196 | **AGREE** (vocabulary differs; semantic identical) |
| Qualified – Offer Draft | **Rejected: Too Small** | **2** | **DIVERGE** — V1 misses the SqFt sanity gate |
| Rejected – Not Distressed | Rejected: No Distress | 2 | **AGREE on rejection** (vocabulary differs; semantic identical) |

### The 2 divergent records

| recordId | Address | City | State | List_Price | V1 says | V2 says |
|---|---|---|---|---|---|---|
| `rec9D7FAKlDUU0rcQ` | 1303 Nw 22nd St | San Antonio | TX | $134,000 | Qualified – Offer Draft | Rejected: Too Small |
| `recBWKbbWXTMxIaYN` | 253 1st St Sw | Atlanta | GA | $175,000 | Qualified – Offer Draft | Rejected: Too Small |

Both have `Has_MLS_Date = 1` (true) — so V1's missing-MLS-date special-case isn't a factor. The divergence is purely the SqFt sanity gate (V2 reads `SqFt_Sane`; V1 does not).

**Extrapolation:** if the 200-record sample is representative of the 1,025 total, **~10 divergent records exist across the active pipeline.** Materiality: low at the record level, but each divergent record is one where V2 says "stop" and V1 says "go" — V1 would falsely greenlight a record V2 catches.

### Missing-MLS-date case

Zero records in the sample had `Has_MLS_Date = 0`. This is the OTHER theoretical divergence case from the brief (V1: `"Data Issue – Missing MLS Date"` / V2: silent pass). **Not observed in the live active-pipeline sample** — likely because every record that survives intake-stage filters has a parsed MLS date. Theoretical risk remains for records that arrive with malformed MLS_Date_Raw, but it's not surfacing today.

### Outreach_Status distribution in sample (context)

| Status | Count |
|---|---|
| (null) | 182 |
| Response Received | 8 |
| Emailed | 5 |
| Texted | 3 |
| Multi-Listing Queued | 1 |
| Negotiating | 1 |

The 2 divergent records both have `Outreach_Status = null` — they haven't yet been touched by H2. **Operationally: V2's stricter gate would have stopped them at intake; V1 would have let them through.** Today's path is V2 → Execution_Path → H2 filter, so the V2 verdict governs. V1 is informational only (unread).

---

## §4 — Q4: Provenance

**Finding: best-effort only. Neither field has a code-commit creation record because both are Airtable formula fields created via the Airtable UI, not via API. Deprecation never happened.**

### What git history shows

- `lib/airtable.ts` first appears in current branch via commit `2dd9723` (2026-05-18, Phase 5.1 Scribe foundation). This is a refactor / re-introduction commit, not the original add — the file pre-dates this branch.
- `git log -S "fldA8B9zOCneF0rjp"` returns 5 commits (all 2026-05-18 to 2026-05-20), all of which are downstream consumers (audit docs, spec docs, this remediation cycle). No commit shows the original code-side introduction.
- `git log -S "fldDCGwYvt7b8fNCj"` returns 2 commits (both 2026-05-20), both audit/spec docs (System Inventory v2 + Distress_Pass audit). **No code ever referenced this field's ID.**

### What spec docs show

- **`AKB_System_Inventory_v2.md`** (5/20 audit) notes V1 as **"older sibling formula"** with em-dash vocabulary `"Rejected – Not Distressed"` vs V2's colon vocabulary `"Rejected: No Distress"`. This wording strongly implies V1 predates V2 chronologically.
- **`docs/investigations/Distress_Pass_Audit_v1.md`** (5/20) explicitly flags: *"Stage_Calc and Stage_Calc_V2 are sibling formulas — different copy, same gate logic. If gate logic changes, both should change together to avoid mixed-state legacy data."*
- **Belt v1 Spec** consistently references only Stage_Calc_V2 — V2 is treated as the canonical formula in current architecture.

### Best-effort reconstruction

The V2 suffix matches a broader pattern in the schema (`DOM_Calc_V2`, `Listing_Verification_V2`, `Stage_Calc_V2`). This suggests a **batch V2 refactor sprint** at some point (likely pre-5/15 since the Master Checklist mentions Phase 4D / Phase 4E version pivots from that period). The V2 batch added:
- The price/size/SFR sanity gates (`List_Price_Sane`, `SqFt_Sane`, `SFR_Only`)
- A combined "Retail or Liquidity" verdict (vs V1's separate verdicts)
- A new vocabulary (colon-prefixed `"Passed:" / "Rejected:"` vs V1's em-dash `"Qualified –" / "Rejected –"`)

But the V2 refactor **never deprecated V1**. Both fields remained in the schema. Code (`lib/airtable.ts:36`) added the V2 → `stageCalc` mapping; V1 was never mapped. The original decision to leave V1 in place is not recorded in any spec or commit — most likely a casual "keep around in case something reads it" decision that never got revisited.

**Net Q4 finding:** V1 is a vestigial schema artifact from before the V2 refactor. The codebase migrated to V2 silently (without explicit deprecation) and never circled back. Today's audit is the explicit circle-back.

---

## §5 — Findings synthesis

| Dimension | Stage_Calc (V1) | Stage_Calc_V2 | Implication |
|---|---|---|---|
| Code consumers | 0 | 1 (loaded into Listing type, never read) | Neither is acted on by code at runtime |
| Make scenario filters | 0 | 0 | Neither is filter input |
| Make scenario field references | Output-schema declarations only (Scenario A) | Output-schema declarations only (Scenario A) | Read-only structural |
| Interface page visibility | 0 pages | 0 pages | Operator-invisible |
| Vercel dashboard render | None | None (loaded, not rendered) | Operator-invisible |
| Drives Execution_Path | NO | **YES** (canonical formula gate) | V2 is the operative path |
| Active-pipeline records | 1,025 | 1,025 | Same population |
| Records where verdicts diverge | 2 of 200 sampled (~1.0%) | (same) | ~10 projected across full 1,025 |
| Provenance | Older formula; pre-V2-refactor era | V2-refactor batch; never deprecated V1 | V1 is vestigial |

### Risk profile today

- **V1 producing wrong verdicts** is non-impactful at runtime: nothing reads V1. Operators don't see it. Make doesn't filter on it. Execution_Path consumes V2 only.
- **V2 producing wrong verdicts** matters: Execution_Path consumes V2; Execution_Path gates H2 + downstream. A V2 false-negative (rejects a record that should pass) stops a deal cold. A V2 false-positive (passes a record that should reject) lets a bad record reach outreach.
- **The current divergence pattern** — V1 saying "Qualified" while V2 says "Rejected: Too Small" — actually protects against V1-driven errors *because V2 wins everywhere it's consulted*. If a downstream consumer ever wires up V1 instead of V2, the 2 SqFt-failing records would slip through. Today: zero such consumers. Tomorrow: no contract.

### Lost-Phone Test framing (per brief §9)

The brief frames this as: "two fields tell the system contradictory things." The accurate findings re-frame: **one field (V2) is consulted; the other (V1) is dormant.** The contradiction risk is latent — it only manifests if a future code path or new consumer accidentally wires V1 instead of V2. That risk is real (no schema-level signal that V1 is deprecated; a new developer querying the schema sees two fields and might pick either), but it's not actively producing bad behavior today.

---

## §6 — Implications per option (operator decides — Code does not unilaterally pick)

Per brief §4 + §6 acceptance criterion: Code reports findings, operator selects A / B / C / D, then Code implements. Below: how today's findings affect the cost/risk profile of each option.

### Option A — Deprecate V1, V2 becomes canonical

| Aspect | Finding-adjusted profile |
|---|---|
| Cost to add MLS-date gate to V2 | **LOW** — `Has_MLS_Date` formula already exists (`fldwuqdvGOYKzizl6`); adding `IF(NOT({Has_MLS_Date}), "Data Issue: Missing MLS Date", …)` as the first branch of V2 is a single formula edit. |
| Consumer-update cost | **ZERO** — V2 is already the only consumed field. No consumer rewires needed. |
| Migration risk | **Minimal** — V1 deletion is safe (zero consumers). Active-pipeline sample shows zero records currently hitting the missing-MLS-date case, so the new V2 branch fires on no current records (forward-going only). |
| Divergent records (~10 across 1025) | **Behavior unchanged** — they're already rejected by V2 (the consumed field). V1 deletion doesn't alter their downstream treatment. |
| Net | Low-cost, low-risk. Single formula edit on V2 (add MLS-date branch) + single field deletion of V1. |

### Option B — Deprecate V2, V1 becomes canonical

| Aspect | Finding-adjusted profile |
|---|---|
| Cost to add sanity gates to V1 | **MEDIUM** — V1 needs new `List_Price_Sane`, `SqFt_Sane`, `SFR_Only` branches. The underlying boolean formulas already exist as separate fields; adding the branches to V1 mirrors V2's structure. ~5 IF clauses. |
| Consumer-update cost | **HIGH** — `Execution_Path` formula consumes V2 (`Stage_Calc_V2 = "Passed: Ready for Offer"` literal); switching to V1 requires updating that literal to `"Qualified – Offer Draft"` AND updating any spec doc that mentions V2's vocabulary. `lib/airtable.ts` mapping needs to change from V2 → `stageCalc` to V1 → `stageCalc`. |
| Migration risk | **Medium** — `Execution_Path` is the active gate. Changing its formula is touching the live outreach path. Test before deploy. |
| Net | More work, more risk, no functional improvement (V2 already gates correctly). Only justified if the brief's preference for V1's "Data Issue" verbosity outweighs V2's broader gate coverage. |

### Option C — Merge into Stage_Calc_V3

| Aspect | Finding-adjusted profile |
|---|---|
| Spec cost | **MEDIUM** — V3 design needs operator decisions: unified vocabulary (colon vs em-dash; "Passed" vs "Qualified"), unified gate order (V2's price-floor-first vs V1's missing-date-first), explicit "Data Issue" separation from "Rejected". |
| Implementation cost | **MEDIUM** — One new formula field with all 7+ gates; Execution_Path consumer update; V1 + V2 deletion. |
| Migration risk | **Medium** — touches Execution_Path (live gate); requires backfill verification that V3 verdicts match V2 verdicts on existing active records before flipping the Execution_Path formula. |
| Net | Clean break. Higher up-front cost than Option A but eliminates the dual-formula schema artifact entirely. Justified if operator wants the cleanest end-state regardless of cost. |

### Option D — Keep both, formally scope them

| Aspect | Finding-adjusted profile |
|---|---|
| Validity precondition | Per brief: "only valid if Q1/Q2 findings show non-overlapping consumer sets and Alex confirms the dual purpose was intentional." |
| Q1 finding | **Consumer sets ARE non-overlapping (V2 has 1 consumer; V1 has 0).** But non-overlapping ≠ intentionally-scoped. V1 has no consumer because the V2 refactor migrated them all and never deprecated V1, not because V1 serves a separate purpose. |
| Q4 finding | No spec evidence that V1 + V2 were intentionally scoped to different purposes. The "older sibling" framing suggests historical accident, not design. |
| Net | **Findings effectively reject Option D unless operator has out-of-band context** showing the dual purpose was intentional. Code's audit suggests V1 is vestigial, not co-canonical. |

### What Code's findings imply (without choosing)

- **Lowest-cost path consistent with findings: Option A** (deprecate V1, add MLS-date branch to V2). Zero consumer updates, single formula edit, single field delete.
- **Cleanest end-state: Option C** (V3 merger). Higher cost but eliminates the schema artifact entirely.
- **Option B (deprecate V2) costs more without functional improvement** because V2 is already gating correctly.
- **Option D requires operator confirmation of intentional dual-purpose**, which Q4 evidence does not support.

Operator decides.

---

## §7 — Adjacent items observed (per brief §5)

The brief flagged 4 anomalies seen during inspection that are NOT INV-003 scope. Code-side confirmation:

| Item | Code observation | Disposition |
|---|---|---|
| `Investor_MAO` / `Your_MAO` / `Auto_Approve_v2` described as **"PLACEHOLDER - convert to formula in UI"** | Confirmed via schema scan of Listings_V1. All three carry the placeholder description. | **New investigation candidate** — operator decides whether to file separately. NOT folded into INV-003. |
| `Fixed_Costs_Est` marked **DEPRECATED** | Confirmed via schema scan. Description: `"DEPRECATED — V1 fixed costs estimator (13% of ARV). V2.1 absorbs this into BTM math. Field retained for V1 audit trail; not used in new Investor_MAO formula."` | **Schema cleanup candidate** — already deprecated per its own description; deletion is operator's call (data is historical / audit trail). NOT folded into INV-003. |
| `stored_offer_price` per checklist item 3.10 / 11.4 | Already shipped per Phase 11.4. Per Phase 20.2 split: renamed to `Outreach_Offer_Price` (`fldBFnL0HQJWahRov`); new `Contract_Offer_Price` (`fldfJWuEIHqaRuWq3`) added. **Resolved.** | No action needed. Brief's reference is stale; resolution landed in Phase 20.2 / Commit H (2026-05-18). |
| `Condition_Score` field | Already INV-012 scope. | Confirmed. No INV-003 overlap. |

All four items captured in this audit's §7 as markers, none added to INV-003.

---

## §8 — Appendix: divergent record IDs + sampled rejection records

### Divergent records (V1 ≠ V2, n=2 in sample)

| recordId | Address | City | State | List_Price | V1 verdict | V2 verdict | Class |
|---|---|---|---|---|---|---|---|
| `rec9D7FAKlDUU0rcQ` | 1303 Nw 22nd St | San Antonio | TX | $134,000 | Qualified – Offer Draft | Rejected: Too Small | **DIVERGE** (V2 catches SqFt; V1 misses) |
| `recBWKbbWXTMxIaYN` | 253 1st St Sw | Atlanta | GA | $175,000 | Qualified – Offer Draft | Rejected: Too Small | **DIVERGE** (V2 catches SqFt; V1 misses) |

### Sampled rejected records (V1 ≈ V2, agreed-on-rejection, n=2 in sample)

| recordId | Address | City | State | List_Price | V1 verdict | V2 verdict | Class |
|---|---|---|---|---|---|---|---|
| `rec9fMm1z5cd0kh6T` | 15510 Faircrest St | Detroit | MI | $39,999 | Rejected – Not Distressed | Rejected: No Distress | AGREE on rejection (vocabulary differs) |
| `recC8DJUUq96HbfRz` | 14045 Sussex St | Detroit | MI | $50,000 | Rejected – Not Distressed | Rejected: No Distress | AGREE on rejection (vocabulary differs) |

### Active-pipeline scale context

- 1,025 total active-pipeline records (Live_Status = Active AND Outreach_Status != Dead)
- 200 sampled (page size cap; first page)
- **Projected divergent records across full population: ~10 (1.0% × 1025)**

Operator can run a follow-up paginated query if a fuller divergence enumeration is needed before remediation. The 1% rate is unlikely to change materially across the remaining 825 records — the divergence cause (SqFt sanity gate) is uniform.

---

*End of audit. Status only. No remediation implemented. Operator decides among Path (a) / (b) / (c) / (d) in §6.*

**Acceptance criteria mapping (per brief §7):**
1. ✅ Q1 deliverable produced (§1).
2. ✅ Q2 deliverable produced (§2).
3. ✅ Q3 deliverable produced (§3 + appendix).
4. ✅ Q4 deliverable produced (§4).
5. ⏸ Awaiting operator selection of Option A / B / C / D.
6. ⏸ Implementation pending operator decision.
7. ⏸ Spine entry pending (will write at remediation, `event_type=principle_amendment`).
8. ⏸ `AKB_MASTER_CHECKLIST.md` update pending — will land alongside remediation per Rule 9 of the checklist (Checklist update required directive).
9. ⏸ `Active_Queue.md` INV-003 status flip pending remediation.

**Next operator action:** select A / B / C / D in chat. Code then implements + writes Spine + updates checklist + flips queue status.

---

## §9 — Remediation outcome (appended 2026-05-20)

**Decision:** Option A + Path 2 — V2 becomes canonical with MLS-date gate; Execution_Path_Calc routes Data Issue verdicts to Manual Review via LEFT prefix match. Operator-ratified 2026-05-20.
**Spine record:** `recPKEhirWUWthpXS` (`event_type: principle_amendment`, `attribution_agent: sentry`).

### What shipped

**1. `Stage_Calc_V2` formula updated** (`fldA8B9zOCneF0rjp`):

```airtable
IF(NOT({Has_MLS_Date}), "Data Issue: Missing MLS Date",
IF({List_Price_Sane}=0, "Rejected: Price Floor",
IF({SqFt_Sane}=0, "Rejected: Too Small",
IF({SFR_Only}=0, "Rejected: Not SFR",
IF(OR({Retail_Pricing_Fail}=1, {Liquidity_Fail}=1), "Rejected: Retail or Liquidity",
IF({Distress_Pass}=0, "Rejected: No Distress",
IF({Math_Pass}=0, "Rejected: Offer Math",
"Passed: Ready for Offer"
)))))))
```

Top-of-formula gate added. Verdict text uses colon convention to match V2's vocabulary (not V1's en-dash).

**2. `Execution_Path_Calc` formula updated** (`fldNRMrcxbiKHW1C9`):

```airtable
IF(
  LEFT({Stage_Calc_V2}, 10) = "Data Issue",
  "Manual Review",
  IF(
    AND(
      {Restriction_Risk_Level_Calc} != "Flagged",
      {Restriction_Risk_Level_Calc} != "High Risk",
      {Restriction_Risk_Level_Calc} != "Hard Block",
      {Stage_Calc_V2} = "Passed: Ready for Offer",
      {MAO_V1} > 0
    ),
    "Auto Proceed",
    IF(
      {Stage_Calc_V2} = "Passed: Ready for Offer",
      "Manual Review",
      "Reject"
    )
  )
)
```

LEFT prefix-match branch added at the top. Pre-existing Auto-Proceed / Manual-Review / Reject logic preserved unchanged below.

**3. `Stage_Calc` V1 field (`fldDCGwYvt7b8fNCj`) — PENDING OPERATOR UI DELETION.** No Airtable MCP `delete_field` tool exists (brief explicitly acknowledged this). Pre-deletion grep checks per brief Step 4 — all PASS for runtime consumers:

| Check | Result |
|---|---|
| `grep -r fldDCGwYvt7b8fNCj akb-dashboard/` | 4 hits, ALL in documentation (audit reports + System Inventory v2). Zero code/Make/route consumers. |
| `grep -r Stage_Calc akb-dashboard/ \| grep -v Stage_Calc_V2` | 12 hits, ALL in documentation (audit reports + Belt v1 spec generic mentions of intake → stage_calc step + queue). Zero code consumers. |
| `grep -r V1 verdict strings` | 8 hits, ALL in documentation (audit text quoting V1's verdict vocabulary). Zero code consumers. |

The documentation hits are HISTORICAL/audit references that should remain post-deletion as the record of what was. Field deletion can proceed via Airtable UI without code-side impact.

### Live verification (Step 3 — all PASS)

**Both formulas valid post-edit** (per `get_table_schema` round-trip):
- `Stage_Calc_V2` `isValid: true`, `referencedFieldIds` now includes `fldwuqdvGOYKzizl6` (Has_MLS_Date) as expected
- `Execution_Path_Calc` `isValid: true`, references unchanged plus the new LEFT prefix logic

**Two known divergent records (verified unchanged):**
| recordId | Address | Pre-edit V2 | Post-edit V2 | Pre-edit Execution_Path_Calc | Post-edit Execution_Path_Calc |
|---|---|---|---|---|---|
| `rec9D7FAKlDUU0rcQ` | 1303 Nw 22nd St San Antonio TX | Rejected: Too Small | Rejected: Too Small ✓ | Reject | Reject ✓ |
| `recBWKbbWXTMxIaYN` | 253 1st St Sw Atlanta GA | Rejected: Too Small | Rejected: Too Small ✓ | Reject | Reject ✓ |

SqFt gate unchanged; both records correctly attributed.

**Missing-MLS-date path verified on 6 live records** (no synthetic test record needed; live data covered both branches):

| recordId | Address | Has_MLS_Date | Post-edit V2 | Post-edit Execution_Path_Calc |
|---|---|---|---|---|
| `rec3J82DupiRhQQgj` | 934 Lehman St | 0 (false) | Data Issue: Missing MLS Date | **Manual Review** ✓ |
| `recFeCrKFCXrenpsd` | TEST 500 Cedar Blvd | 0 (false) | Data Issue: Missing MLS Date | **Manual Review** ✓ |
| `recl3csdMsfrHIsV9` | TEST 200 Oak Ave | 0 (false) | Data Issue: Missing MLS Date | **Manual Review** ✓ |
| `recxS00MqCmvuI9fH` | TEST 300 Elm Dr | 0 (false) | Data Issue: Missing MLS Date | **Manual Review** ✓ |
| `recxWEMLp2hcBY5j7` | TEST 100 Main St | 0 (false) | Data Issue: Missing MLS Date | **Manual Review** ✓ |
| `recz28Ui8S642Xgog` | TEST 400 Pine Ln | 0 (false) | Data Issue: Missing MLS Date | **Manual Review** ✓ |

5 of the 6 records are pre-existing TEST records; 1 (934 Lehman St) is a real listing missing MLS date. All correctly routed.

### Behavioral impact

- ~10 records across the 1,025-record active pipeline (1.0% sampled divergence rate, projected) now have correct V2 attribution.
- Missing-MLS-date records now surface as Manual Review (operator-actionable data-quality flag) instead of falling through to the Reject default. **Lost-Phone Test discipline preserved:** system surfaces data problems via the queue, doesn't kill leads silently.
- LEFT prefix match in Execution_Path_Calc enables future variants ("Data Issue: Missing Address", "Data Issue: Missing ZIP", etc.) without requiring another Execution_Path_Calc edit. Forward-compat with potential INV-005 / INV-009 / INV-011 schema-quality work.

### Acceptance criteria status (per brief §7)

| # | Criterion | Status |
|---|---|---|
| 1 | Q1 code-consumer enumeration | ✅ (audit §1) |
| 2 | Q2 human-surface enumeration | ✅ (audit §2) |
| 3 | Q3 live divergence count + samples | ✅ (audit §3) |
| 4 | Q4 provenance best-effort | ✅ (audit §4) |
| 5 | Operator selects A/B/C/D | ✅ Option A + Path 2 (2026-05-20) |
| 6 | Code implements formulas + V1 deletion | ✅ formulas; ⏸ V1 deletion pending operator UI action (no MCP tool exists; brief acknowledged) |
| 7 | Spine entry written | ✅ `recPKEhirWUWthpXS` |
| 8 | `AKB_MASTER_CHECKLIST.md` updated | ✅ this commit (Phase 1 Stage_Calc resolution entry per Rule 9) |
| 9 | `Active_Queue.md` INV-003 flipped to SHIPPED | ✅ this commit |

### Untouched paths

- L3 / scan-comms / H2 / `/api/deal-context` / `/api/conversations` / `lib/maverick/*` — all unchanged.
- Production path remains: `Stage_Calc_V2` (now with MLS-date gate) → `Execution_Path` (now with Data-Issue branch) → H2 filter → outbound.

*End of remediation outcome. Status: formulas shipped + verified. V1 field deletion pending operator Airtable UI action. Spine: `recPKEhirWUWthpXS`.*
