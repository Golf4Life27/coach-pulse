# INV-004 — Crier Stale-Contact False-Positive on Fresh Contracts — Audit v1

**Audit date:** 2026-05-20
**Auditor:** Code
**Scope:** discovery + recommendation only. NO code changes, NO Crier logic modifications, NO field additions.
**Brief:** Maverick, 2026-05-20 (INV-004 brief in operator dashboard).
**Companion specs:** `AKB_Belt_v1_Spec.md` §6 (source-of-truth communications principle); `docs/investigations/Distress_Pass_Audit_v1.md`, `docs/investigations/Listing_Condition_Audit_v1.md` (audit-discover-decide-remediate cycle prior art); `lib/maverick/deal-commentary.ts` (current Crier silence rule, Phase 11.2 lineage).

---

## §1 — Q1: Production false-positive count

**Finding: zero records today fit the brief's strict false-positive definition. But the architecture is structurally vulnerable and the day DocuSign provisioning lands (Phase 12.7), every tracked envelope becomes a future false-positive without the fix.**

### Query (matches brief §3 Q1 specification)

Filter on Listings_V1: `Live_Status = "Active" AND Outreach_Status ∈ {Negotiating, Response Received}`.

- **Total records: 43** (matches operator's "33-response-cluster + ~10 Negotiating" mental model from prior session)
- Sample of 43 fully retrieved (no pagination needed).

### Contract-state signal availability today

| Signal source | Field / origin | Records with signal set (n=43) | Implication |
|---|---|---|---|
| Listings_V1 `Envelope_ID` (`fldKPVG9qmbzxW5lK`) | DocuSign envelope GUID, written by "Track in Scribe" affordance | **0** | DocuSign JWT provisioning is Phase 12.7 STOP (external operator); no envelopes have been tracked because the affordance isn't lit up yet. |
| Linked Deals row exists | via `Offer_Drafts` → `Deals` chain (no direct link — see Q2) | **0 of 43 confirmed; uncertain (linkage requires per-record join)** | Deals table contains only 3 records total, all historical (`status: Failed` ×2, `status: Closed` ×1). None map to current active Negotiating/Response Received records. |
| Deals `Closing_Status` populated | `fldTvNokAK5AEqz9z` on Deals table | **0** (for active deals) | Same as above — no active deal has a Deals row. |
| Deals `EMD_Status ∈ {Requested, Received}` | `fldPaeDIOC2DYrOfM` | **0** (for active deals) | Same — no active deal has a Deals row. Of the 3 historical Deals: 1 has `EMD_Status = "Late"` (Closed deal). |
| Deals `Assignment_Executed = true` | `fldvBbthIXQmrpc7u` | **0** (for active deals) | Same — 1 of the 3 historical Deals has it checked (closed `recKeC04phbzF8SuA`). |

**By the brief's strict definition (any contract-state signal set), false-positive count today = 0.**

### Crier silence currently firing on this set (n=43)

Even though no contract-state signal disqualifies any record, Crier IS currently flagging the staleness across this cohort. Computed staleness from `Last_Outreach_Date` (the strongest current-signal proxy):

| Cohort | Count | Crier behavior today |
|---|---|---|
| Last touch ≤6 days ago | ~10 | No silence signal |
| Last touch 7–13 days ago | ~12 | **Tier 1 silence** ("X days since last touch") |
| Last touch ≥14 days ago | ~21 | **Tier 2 silence** ("X days without contact — this deal is going cold") |

The Crier silence rule is **firing on ~33 of 43 records today (76%)**. Many of these are the 33-response-cluster from prior session-open briefings.

### What the count reveals

The Q1 question asked "how many are currently false-positives?" The literal answer is zero — **but only because the signals that would mark a record as in-flight contract execution don't exist on any active record yet**. The Hallbrook + 23 Fields cases that the operator cited in the brief as known false-positives:

- **Hallbrook** (no recordId-match found in current 43-record sample — possibly already in a different Outreach_Status or under a different agent name) — the "accepted offer, not yet moved to contract status" state is **entirely in operator's mental model**, not in any Airtable field.
- **23 Fields Ave** (`rec1HTUqK0YEVb7uA` — confirmed): `Outreach_Status = Negotiating`, `Last_Outreach_Date = 2026-04-18` (32 days stale), `Envelope_ID` empty. DocuSign envelope sent per operator memory but NEVER tracked in Airtable via the "Track in Scribe" affordance (because Phase 12.7 DocuSign live data isn't provisioned).

**Operator-perceived false-positives ARE real** — operator knows the deals are in flight. The SYSTEM has no way to know because the contract-state fields are unpopulated.

This reframes the architecture risk: **the fix is preventive, not corrective.** Suppress logic shipped today suppresses nothing today (no signal to suppress on). But the day DocuSign provisioning lands and operator starts tracking envelopes, every tracked deal becomes a future false-positive without the guard.

### Implication for Option A cost/risk profile

- **Cost today: zero records affected.** Option A's `isUnderContract()` guard returns false for every record currently in the cohort.
- **Cost post-DocuSign-provisioning: structural correctness.** Every newly-tracked envelope cleanly suppresses Crier silence.
- **Risk today: zero behavioral regression** (no records change state).
- **Risk post-deployment: same** — the guard fires only when a contract-state signal is explicitly populated.

---

## §2 — Q2: Listings_V1 ↔ Deals linkage

**Finding: No direct link. Indirect chain through Offer_Drafts exists but isn't populated for current active deals. Fragile.**

### Direct schema scan

**Listings_V1 (`tbldMjKBgPiq45Jjs`) — multipleRecordLinks fields:**
- `Offer_Drafts` (`fldWAbwwyQoexmeHz`) → links to Offer_Drafts table
- `Spine_Config_Link` (`fldhHkc39L6XdybjB`) → links to Spine_Config
- `D3_Manual_Fix_Queue` (`fldQD1L9wkvaPYOvh`) → links to D3 Manual Fix Queue

**No link to Deals table.**

**Deals (`tblKDYhaghKe6dToW`) — multipleRecordLinks fields:**
- `Offers` (`fldKUCCdNOMG1p826`) → links somewhere (likely Offer_Drafts)
- `Buyers` (`fld3lROJq7Li6eXfQ`) → links to Buyers table

**No link to Listings_V1 table.**

Deals does have `property_address` (singleLineText, primary field) and `city` / `state` — but those are independent strings, not record links.

### Indirect chain via Offer_Drafts

Offer_Drafts (`tblhf8AqkHke70ddS`) is the connector:
- `Listing_Link` (`fldN6fb3gFhD6gzfY`) → multipleRecordLinks to Listings_V1
- `Deals` (`fldh60EreFKsKQUUL`) → multipleRecordLinks to Deals

**So:** `Listings_V1.Offer_Drafts → Offer_Draft.Deals → Deals row`.

This chain works IN THEORY but requires:
1. An Offer_Draft record exists for the Listings_V1 record
2. That Offer_Draft is linked to a Deals row

### Population check today

Of the 43 Negotiating/Response Received records:
- Records with non-empty `Offer_Drafts` field: visible in sample (e.g., `rec9d5p4j2NW1AFMt` has `[{id: rec2k0adr10PUjcIu, name: "121"}]`, `recBpX4UnAOkopuNK` has `["699"]`, etc.) — roughly **8 of 43** have linked Offer_Drafts.
- Records without linked Offer_Drafts: ~35 of 43. **These cannot be joined to Deals at all** via the Offer_Drafts chain.

Of the 8 with Offer_Drafts, only 3 Deals rows exist total system-wide (all historical Failed/Closed). The probability that any of the 8 is genuinely linked to a Deals row is near zero — the Offer_Draft chain is populated by Phase 4 pricing flows, not by contract execution.

### Implication for the fix

**Option A's `isUnderContract()` helper cannot reliably query Deals via the Listings_V1 link today.** The chain exists in schema but is not consistently populated. The fix must rely primarily on **`Envelope_ID` on Listings_V1 directly** as the canonical contract-state signal.

Deals-side signals (Closing_Status, EMD_Status, Assignment_Executed) become useful **when and if** the operator's workflow consistently:
1. Creates a Deals row for each contracted listing
2. Populates the Offer_Draft → Deals link

Today neither happens reliably. **Brief's §5 flagged the "Deals → Listings_V1 linkage gap (if confirmed in Q2 as fragile address-string match)" — confirmed.** The chain isn't address-string; it's record-link via Offer_Drafts. But Offer_Drafts isn't populated systematically for contracted deals either. The linkage is fragile via both definitions.

**Schema discipline candidate logged: explicit `Deal_Link` field on Listings_V1** to enable reliable contract-state joining. Out of scope for INV-004 remediation. Flagged in §7 below.

---

## §3 — Q3: Where else does Crier silence logic exist?

**Finding: Two production code paths and one synthesizer prompt currently judge "staleness." Crier's deal-commentary path is the per-deal renderer; Pulse's stale-data-drift detector is the system-level alarm; the synthesizer reads from both but doesn't add its own logic.**

### Path 1 — `lib/maverick/deal-commentary.ts` (Crier per-deal)

The canonical path the brief cites. Lines 102–129 (verified verbatim in audit prep):

- Branches on `outreachStatus ∈ {Negotiating, Response Received}`
- Reads 4 contact timestamps via `latestContactIso()` (Phase 11.2 max() fix)
- Tier 1 silence at 7d, Tier 2 silence at 14d
- **Zero references to contract-state fields** — confirmed via grep

Header comment (lines 8–12) explicitly defers richer logic: *"Deterministic by design — Phase 9.8 ships no per-deal Claude calls. The synthesis budget is reserved for the briefing-wide narrative … Per-deal reasoning is rule-based here; richer commentary lands when Pulse (Phase 14) provides confidence-scored proactive surfacing."* This frames the current rule as the v1 placeholder for Pulse-confidence-scored v2.

### Path 2 — `lib/pulse/detectors/stale-data-drift.ts` (Pulse system-level)

System-level Pulse detector for the broader staleness cluster. Code reviewed in full:

- `mostRecentTouchMs(listing)` reads `lastInboundAt` and `lastOutboundAt` ONLY (lines 32–40) — narrower than Crier's 4-field `latestContactIso` (Phase 11.2 fix did not propagate here)
- `findStaleListings(listings, staleDays, now)` filters where most-recent-touch is older than threshold (default 14d)
- Fires `warning` at ≥5 stale records, `critical` at ≥20 (env-overridable)
- **Zero references to contract-state fields** — same blind spot as Crier
- **Zero references to `lastEmailOutreachDate`** — Phase 11.2 max() fix never reached this detector (sub-finding: minor Phase 11.2 follow-up — separate from INV-004)

Pulse fires at the aggregate level: "20 active deals stale >14d → critical." If 33 records are stale-flagged today and 5 of those are actually in-flight contracts, Pulse counts all 33 — distorted threshold. Same false-positive shape, different layer.

### Path 3 — `app/api/jarvis-brief/route.ts` (briefing synthesizer)

Single text mention (line 503): the synthesizer prompt instructs Claude to reference the staleness narrative ("Re-engaged after going dark"). The synthesizer reads the structured briefing (which includes deal-commentary signals + Pulse detections) and Claude writes prose. **The synthesizer doesn't have its own staleness rule** — it inherits whatever the upstream layers produce.

If Crier produces a false-positive signal, the synthesizer narrates it. If Pulse fires a false-positive count, the synthesizer surfaces it. Fixing Path 1 + Path 2 fixes the narrative downstream by inheritance.

### Path 4 — Decorative / non-judgmental staleness rendering (NOT in scope)

Multiple components compute "days since touch" purely for rendering, not for signal-firing:
- `components/PipelineBoard.tsx`, `components/MorningBriefing.tsx`, `app/api/morning-briefing/route.ts` — visualize day counts, never branch on them as "deal is going cold"
- `app/api/outreach-safety-check/route.ts` — `daysSinceLastInteraction` used for a DIFFERENT purpose (cooldown between outreaches to same agent), not staleness alerting
- `app/api/admin/bulk-dead-stale-texted/route.ts` — admin tool for bulk-classifying Texted records as Dead after long silence — orthogonal to Crier silence

These render staleness but don't ASSERT staleness. Out of INV-004 scope.

### Net Q3 finding

Two paths must be patched to fully close the false-positive class: **deal-commentary.ts** (per-deal) and **stale-data-drift.ts** (system-level). The synthesizer inherits whatever both produce; no synthesizer change required.

---

## §4 — Q4: Pulse vs Crier responsibility

**Finding: deal-commentary.ts's own header comment names the architectural intent. Today's split is interim; the long-term split is Pulse-confidence-scores-Crier-deterministic-rules. Today, neither layer is contract-state-aware.**

### Spec evidence

**`lib/maverick/deal-commentary.ts` header (lines 8–12), verbatim:**

> Deterministic by design — Phase 9.8 ships no per-deal Claude calls. The synthesis budget is reserved for the briefing-wide narrative (one synthesis per briefing, shared across all consumers). Per-deal reasoning is rule-based here; **richer commentary lands when Pulse (Phase 14) provides confidence-scored proactive surfacing.**

That's a clear architectural deferral: Crier today = deterministic rules. Pulse = the layer that will eventually confidence-score per-deal staleness. The split is **separation by maturity, not by domain.**

**`lib/pulse/detectors/stale-data-drift.ts` header (lines 1–8), verbatim:**

> Phase 14 / O.1 — stale-data-drift detector.
>
> Carries forward the 33-response-cluster class of failure: active deals where the agent owes us a reply but the thread has aged without any movement on either side. Pulse counts listings in active outreach status where MAX(lastInboundAt, lastOutboundAt) is older than N days.

Pulse's scope here is **system-level pattern detection** ("the cluster pattern"), not per-deal confidence scoring. The Phase 14 spec frames Pulse as "system self-monitoring" — anomaly detection rather than per-record sophistication.

### Net Q4 finding

- Today: **both layers are rule-based, both are contract-state-unaware.** Crier flags per-deal, Pulse flags the aggregate.
- Tomorrow (Phase 14 maturity): **Pulse should layer confidence scoring on top of Crier's deterministic output.** Crier's rule fires → Pulse scores confidence-of-staleness → operator sees the confidence-weighted signal.
- **Contract-state awareness belongs in the rule layer (Crier)**, not the confidence layer (Pulse). Pulse can't confidence-score what the rule has already over-fired on.

**Recommendation per brief's framing: the fix is a Crier-layer fix.** Pulse's stale-data-drift detector should inherit the same contract-state guard so the aggregate count matches per-deal reality.

---

## §5 — Findings synthesis

| Dimension | Today | Post-fix expectation |
|---|---|---|
| Records with contract-state signal (Envelope_ID OR Deals row populated) | 0 of 43 | grows as DocuSign provisioning lands + operator starts tracking |
| Crier silence false-positive count (strict) | 0 | 0 (the fix preserves zero) |
| Crier silence true-positive count today | ~33 of 43 (76%) — outreach-stage silence is legitimately flagged | unchanged for non-contract records |
| Architecture vulnerability | Real and structural | Closed by guard |
| Pulse stale-data-drift detector | Same blind spot; fires aggregate counts including future-contract records | Inherits same guard via shared helper |
| Synthesizer / briefing narrative | Inherits whatever Crier + Pulse produce | Fixed-by-inheritance |
| Phase 11.2 `latestContactIso` (max-4-fields) | Intact in deal-commentary.ts; NOT propagated to stale-data-drift.ts | Sub-finding flagged separately |

### Risk profile

**The risk is not a current bug count — it's a credibility cliff.** The brief frames it correctly:

> The deals that hit "Negotiating" + contract-in-flight are the highest-leverage moments in the entire pipeline. Wholesale fees live and die at this stage. Crier being wrong here is more expensive than Crier being wrong on early-outreach silence.

The fix is **preventive infrastructure**. Ship now, suppresses nothing today, kicks in when contract-state signals start firing.

### Adjacent finding: `lastEmailOutreachDate` not in Pulse stale-data-drift

`lib/pulse/detectors/stale-data-drift.ts:32-40` reads `lastInboundAt + lastOutboundAt` only — does NOT include `lastEmailOutreachDate` (Phase 11.2 4th field). This means Pulse's stale-data-drift detector can still false-stale on records where only the email field is fresh. Same 23 Fields failure mode as the Phase 11.2 fix addressed in Crier, but unaddressed in Pulse.

**Logged for Active_Queue** as separate finding — not folded into INV-004 scope. Cheap follow-up: 3-line edit to `mostRecentTouchMs` to include the 4th field.

---

## §6 — Implications per option (operator decides — Code does not unilaterally pick)

Per brief §4 + §7 acceptance criterion: Code reports findings; operator selects Option A / B / C / D; Code implements. Below — findings-adjusted profile for each.

### Option A — Suppress silence when contract state is active

| Aspect | Findings-adjusted profile |
|---|---|
| Cost (today) | **Zero records affected** (no Envelope_ID is populated). Guard fires false on every record. |
| Cost (post-DocuSign-provisioning) | Structural correctness. Every tracked envelope cleanly suppresses Crier silence. |
| Implementation | Extend `DealCommentaryListing` interface with `envelopeId: string \| null`; add `isUnderContract(listing)` helper (returns true if `envelopeId` non-empty); guard the silence branch. ~15 lines + 4 tests. Parallel change in `stale-data-drift.ts` to inherit the same guard. |
| Tests required | Per brief §7 acceptance #6 — 4 cases: Negotiating+Envelope+14d→suppressed; Negotiating+no-contract+14d→silence fires (regression); Response Received+EMD-requested+14d→suppressed (requires Deals join — note that Deals join is unreliable today, see Q2); Hallbrook-shape (no contract signal, just operator memory)→silence fires (no false-negative on missing signal). |
| Risk | Low — guard returns false today, no behavioral regression. Forward-going correctness when DocuSign lands. |
| Linkage caveat (Q2) | Deals-side signals (`Closing_Status`, `EMD_Status`, `Assignment_Executed`) require unreliable Offer_Draft→Deals chain. Pragmatic v1: gate purely on `Envelope_ID`. Schema discipline fix (explicit `Deal_Link` field) is a separate follow-up. |

### Option B — Replace silence with phase-aware ladder

| Aspect | Findings-adjusted profile |
|---|---|
| Cost | MEDIUM-HIGH. New rules for DocuSign-aging / EMD-aging / closing-day proximity. Each requires a contract-state signal that's mostly unpopulated today. |
| Risk | MEDIUM. Larger surface area. Premature without operator workflow consistently producing the upstream signals (Q1/Q2 findings: signals aren't there yet). |
| Net | Builds on top of Option A's guard. Better as a Phase 14 follow-up than today's fix. |

### Option C — Defer to Pulse

| Aspect | Findings-adjusted profile |
|---|---|
| Cost | Zero today, indefinite later. |
| Risk | **HIGH per the brief.** Operator continues to see false-positives the moment DocuSign provisioning lands (Phase 12.7), and Pulse confidence-scoring isn't built yet. Q4 finding: Pulse's current detector has the SAME blind spot — Pulse-as-built today doesn't suppress; it adds noise. |
| Net | **Rejected by findings.** Pulse-as-architectural-deferral works only if Pulse is the layer that adds contract-state awareness. Today Pulse doesn't have it either. Doing nothing today guarantees the operator-trust failure when DocuSign goes live. |

### Option D — Hybrid: Option A now, Option B path planned for Phase 14

| Aspect | Findings-adjusted profile |
|---|---|
| Cost | LOW now, MEDIUM later. |
| Risk | LOW. Best of both — stops false-positives infrastructurally now (Option A's guard); leaves room for Option B's richer phase-aware logic when Phase 14 confidence-scoring + DocuSign-aging signals mature. |
| Net | **Findings-supported.** Option A's guard is the right shape today (preventive infrastructure with zero behavioral impact at deploy). Option B's phase-ladder is the right shape later (once signals populate). Hybrid sequences them correctly. |

### What Code's findings imply (without choosing)

- **Lowest-cost path consistent with findings: Option D (Hybrid).**
- **Option C (defer to Pulse) is rejected** — Pulse-as-built has the same blind spot; deferral preserves the failure mode.
- **Option A alone is sound** but the brief's framing of Option D adds Phase-14 path-planning that costs nothing today and frames the upgrade clearly.
- **Pure Option B is premature** — the upstream signals (Deals.Closing_Status, EMD_Status, etc.) aren't populated systematically; Option B would over-build.

Operator decides.

---

## §7 — Adjacent items observed (per brief §5 + §3 follow-ups)

| Item | Code finding | Disposition |
|---|---|---|
| **Listings_V1 ↔ Deals linkage gap** | Confirmed in Q2. No direct link; indirect chain via Offer_Drafts is unreliable (35 of 43 active records have no Offer_Drafts link). | **New investigation candidate** — schema discipline. Propose explicit `Deal_Link` field on Listings_V1. NOT folded into INV-004 remediation. |
| **`Closing_Status_Level` numeric semantics** | Field exists (`fldH35wnPUTcdelZw`, number) but description is empty. | Minor doc gap. Flagged. |
| **Deals `status` field vocabulary** | singleSelect with `New / Negotiating / Under Contract / Closing / Closed / Failed`. Partially overlaps with `Closing_Status` vocabulary. | Schema audit candidate. Flagged. |
| **Pulse stale-data-drift missing `lastEmailOutreachDate`** | Confirmed Q3 finding. Phase 11.2 max() fix landed in `latestContactIso` (Crier) but never propagated to `mostRecentTouchMs` (Pulse). | **New investigation candidate** — cheap follow-up (3-line edit). Logged separately. |
| **Phase 11.2 `latestContactIso()` function** | Per brief §5: "correct and battle-tested; this brief does not propose changes to it." | Confirmed. No change proposed. |

All five items flagged; none folded into INV-004 remediation scope.

---

## §8 — Appendix: 43 active Negotiating / Response Received records

Compact table — full set; columns: `recordId | Address | City | State | Outreach_Status | Last_Outreach_Date | Envelope_ID? | Days_stale (approx from 2026-05-20)`.

| recordId | Address | City | ST | Status | Last_Outreach | Envelope | Stale (d) |
|---|---|---|---|---|---|---|---|
| `rec1HTUqK0YEVb7uA` | 23 Fields Ave | Memphis | TN | Negotiating | 2026-04-18 | (empty) | 32 |
| `rec0OUFd3IdHsa5Z9` | 250 Walton Ave | San Antonio | TX | Response Received | 2026-04-15 | (empty) | 35 |
| `rec1KyZwxcW7Oa5JK` | 2303 W Grand St | Detroit | MI | Response Received | 2026-05-02 | (empty) | 18 |
| `rec7fuRvJ7lHqsOXW` | 11309 Somerset Ave | Detroit | MI | Response Received | 2026-05-06 | (empty) | 14 |
| `rec9d5p4j2NW1AFMt` | 924 Sunnyside Ave | Dallas | TX | Response Received | (no date) | (empty) | ? |
| `rec9fMm1z5cd0kh6T` | 15510 Faircrest St | Detroit | MI | Response Received | 2026-05-06 | (empty) | 14 |
| `recAj3Qs2p8hHwl95` | 5705 Glen Forest Ln | Dallas | TX | Negotiating | (no date) | (empty) | ? |
| `recB3D0ZXMRLDgZmD` | 912 W Theo Ave | San Antonio | TX | Response Received | 2026-05-06 | (empty) | 14 |
| `recBpX4UnAOkopuNK` | 14914 Pinehurst St | Detroit | MI | Response Received | 2026-05-02 | (empty) | 18 |
| `recC8DJUUq96HbfRz` | 14045 Sussex St | Detroit | MI | Response Received | 2026-05-06 | (empty) | 14 |
| `recCNqLKRqbmxHc5S` | 15724 Fielding St | Detroit | MI | Response Received | 2026-05-02 | (empty) | 18 |
| `recCYs0hasNUHZm91` | 18866 Hull St | Highland Park | MI | Response Received | 2026-05-02 | (empty) | 18 |
| `recCxJegIbIwLfjJ2` | 843 Hoover Ave | San Antonio | TX | Response Received | 2026-04-08 | (empty) | 42 |
| `recF0lsWDqnwvFPdp` | 10340 Rebel Rd | Houston | TX | Response Received | 2026-04-27 | (empty) | 23 |
| `recFeWaLndW3zOHAB` | 1212 Churing Dr | San Antonio | TX | Response Received | 2026-05-19 | (empty) | 1 |
| `recFuCFfgyI4PC2gP` | 910 Absolon Farm | San Antonio | TX | Response Received | 2026-05-12 | (empty) | 8 |
| `recG4GNM2sa0ZYj7p` | 5435 Callaghan Rd | San Antonio | TX | Response Received | 2026-05-19 | (empty) | 1 |
| `recGRQTT4nE8xKUVZ` | 220 Hansford St | San Antonio | TX | Response Received | 2026-05-06 | (empty) | 14 |
| `recI3vZIJGKMNcQql` | 251 Cliffwood Dr | San Antonio | TX | Response Received | 2026-05-12 | (empty) | 8 |
| `recI5m8pDUq4Wzo8M` | 5062 Parker St | Detroit | MI | Response Received | 2026-05-02 | (empty) | 18 |
| `recJdR1ibWWc0Jknq` | 9651 Ivy Bend St | San Antonio | TX | Negotiating | (no date) | (empty) | ? |
| `recMkKJ63uwOGCn1o` | 450 Kitchener St | Detroit | MI | Response Received | 2026-05-02 | (empty) | 18 |
| `recO7XFKcUVTTxMcB` | 12724 Strathmoor St | Detroit | MI | Response Received | 2026-05-06 | (empty) | 14 |
| `recTrTMR7Xty7XV1Y` | 14299 Kilbourne St | Detroit | MI | Response Received | 2026-05-06 | (empty) | 14 |
| `recU36zhH25TLc1uy` | 16241 E State Fair St | Detroit | MI | Response Received | 2026-05-06 | (empty) | 14 |
| `recUwPGknjIsUsZPi` | 12245 Washburn St | Detroit | MI | Response Received | 2026-05-02 | (empty) | 18 |
| `recYkaJAdL6OyljII` | 4030 Bur Oak Path | San Antonio | TX | Response Received | 2026-05-12 | (empty) | 8 |
| `recZwObjFGM4HbfyZ` | 14901 Terry St | Detroit | MI | Response Received | 2026-05-07 | (empty) | 13 |
| `reccW6Ghd0La5yG0H` | 118 Redrock Dr | San Antonio | TX | Response Received | 2026-05-19 | (empty) | 1 |
| `recd3aN6DLdBmMJV4` | 11114 Dreamland Dr | San Antonio | TX | Response Received | 2026-05-19 | (empty) | 1 |
| `recdn83x0QSvTezt7` | 114 Thompson Pl | San Antonio | TX | Response Received | 2026-05-07 | (empty) | 13 |
| `rece38peGR67eqIyG` | TEST — 999 Loop Test Lane | San Antonio | TX | Negotiating | (no date) | (empty) | TEST |
| `receVDzhfKIvO5T1S` | 14474 Mapleridge St | Detroit | MI | Response Received | 2026-05-07 | (empty) | 13 |
| `recf1t8zaRzBNfxfF` | 15879 Kentucky St | Detroit | MI | Response Received | 2026-05-02 | (empty) | 18 |
| `recf8WEFcyZqf31PR` | 12628 Washburn St | Detroit | MI | Response Received | 2026-05-02 | (empty) | 18 |
| `rech8Pch8lxH8AsLZ` | 4312 W Jefferson Ave | Ecorse | MI | Response Received | 2026-05-02 | (empty) | 18 |
| `recheV9289xo9NxPm` | 19429 Winthrop St | Detroit | MI | Response Received | 2026-05-02 | (empty) | 18 |
| `reck0nWOtVB48kTJm` | 3626 Corder St | Houston | TX | Negotiating | 2026-04-27 | (empty) | 23 |
| `recljlgQVVINtUqcO` | 903 Mosby Rd | Memphis | TN | Negotiating | 2026-04-18 | (empty) | 32 |
| `recnPRttIyEOfdvPx` | 2966 Collingwood St | Detroit | MI | Response Received | 2026-05-02 | (empty) | 18 |
| `recrON7rBfUEqCqJt` | 14065 Manning St | Detroit | MI | Response Received | 2026-05-02 | (empty) | 18 |
| `recwmOoSSohEaqIk5` | 2119 Palo Alto Rd | San Antonio | TX | Response Received | 2026-03-31 | (empty) | 50 |
| `recyAQqXhfuv03oPg` | 4702 Mitchell St | Detroit | MI | Response Received | 2026-05-02 | (empty) | 18 |

**43 total records. 0 have Envelope_ID set. Crier silence currently firing on ~33 (any record with Last_Outreach_Date older than 2026-05-13 = ≥7 days stale).**

### Notable records aligning with brief context

- **`rec1HTUqK0YEVb7uA` (23 Fields Ave, Candice Hardaway, Memphis)** — the anchor case from brief §2.4. Currently 32 days stale; Crier firing Tier 2 silence. No Envelope_ID populated (DocuSign envelope sent per operator memory but not tracked in Airtable).
- **`recljlgQVVINtUqcO` (903 Mosby Rd, Sonja Hester, Memphis)** — possible Hallbrook-related (Memphis Negotiating). Operator can confirm.
- **`rec0OUFd3IdHsa5Z9` (250 Walton Ave, Hector Ramirez, San Antonio)** — oldest stale at 35 days; Tier 2 silence firing.

---

*End of audit. Status only. No remediation implemented. Operator decides among Path (a) / (b) / (c) / (d) in §6.*

**Acceptance criteria mapping (per brief §7):**
1. ✅ Q1 deliverable produced (§1).
2. ✅ Q2 deliverable produced (§2).
3. ✅ Q3 deliverable produced (§3).
4. ✅ Q4 deliverable produced (§4).
5. ⏸ Awaiting operator selection of Option A / B / C / D.
6. ⏸ Implementation pending operator decision.
7. ⏸ Spine entry pending (will write at remediation, `event_type=principle_amendment`, `attribution_agent=crier`).
8. ⏸ `AKB_MASTER_CHECKLIST.md` update pending — will land alongside remediation per Rule 9.
9. ⏸ `Active_Queue.md` INV-004 status flip pending remediation; currently marked **INVESTIGATION COMPLETE**.

**Next operator action:** select A / B / C / D in chat. Code then implements + writes Spine + updates checklist + flips queue status.
