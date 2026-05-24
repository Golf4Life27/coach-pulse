# INV-023 Brief — Underwriter Agent (Contract-Phase Quality Gate)

**Author:** Maverick (Owner's Rep)
**Date:** 2026-05-22 (v2 — autonomous-by-default rewrite, supersedes v1)
**Status:** BRIEFED, awaiting Code spec design
**Severity:** STRATEGIC (load-bearing synthesis agent for contract-phase autonomy)
**Pair-with:** INV-005 (manual rehab affordance — data input), INV-020 (Gmail inbound triage — surface), INV-022 (Data Source Federation — hydration), Decision Preconditions Amendment Rule 1 (Pricing Precondition) + Rule 3 (Dashboard-First Autonomy)
**Dependency:** INV-022 must ship before INV-023 implementation begins. INV-005 + INV-020 + Decision Preconditions ratification recommended before INV-023 ships.

---

## 1. Premise

When a property transitions to `Outreach_Status: Offer Accepted`, the deal enters DD. Today, DD is operator-driven manual checklist work plus ad-hoc data pulls — violating Lost-Phone Test by definition. The Underwriter Agent is the **system layer that runs the DD checklist autonomously** between Offer Accepted and Ready_For_Contract.

---

## 2. Autonomy boundaries (Constitution Rule 3)

This brief replaces v1 which embedded "Posts to Action Queue: click here to authorize data pulls" — a Rule 3 violation. Restated:

**Type 1 (always autonomous, no operator surface):**
- Trigger: `Outreach_Status` flip (cron, same pattern as INV-006)
- Consumes INV-022 federated data (Buyer_Median, Rent_Comp, AS_IS_Value, sold-comps, photos, owner, liens, FEMA flood, crime grade, days-on-market, buyer pool)
- Runs full checklist evaluation
- Retries on transient data-fetch failure via INV-022 backoff
- On retryable hydration failure: agent waits, retries, surfaces NOTHING to operator
- Spine entry per checklist evaluation

**Type 2A (system drafts → operator approves in dashboard queue):**
- On PASS: buyer-outreach drafts queued for operator dashboard approval
- On PASS: DocuSign envelope content drafted, queued in Approval Queue

**Type 2B (always operator-click, irreversible):**
- DocuSign envelope signing
- EMD wire authorization
- Mutual Release signing
- Never graduates to autonomous (per operator preference 2026-05-22)

**Type 2C (always operator-click, judgment required):**
- Material discrepancies surfaced by INV-022 (owner mismatch, lien presence, flood zone)
- Structural FAIL: contract price > Your_MAO with no clean override → diagnosis surfaced
- Edge cases outside hardcoded rules

**Anti-pattern forbidden by Rule 3:** v1 said *"Posts to Action Queue: 2 missing preconditions; click to authorize data pulls"* — wrong. The agent attempts pulls autonomously via INV-022, retries until exhaustion, surfaces ONLY when all retries exhaust OR material discrepancy needs judgment.

---

## 3. Checklist preconditions

### DATA HYDRATION (powered by INV-022 — Type 1 autonomous)
- [ ] `Buyer_Median` (InvestorBase, V2.1 floor — no theoretical fallback per Rule 1)
- [ ] `Rent_Comp_Median` (RentCast `/v1/avm/rent`)
- [ ] `AS_IS_Value` (RentCast `/v1/avm/value` — NOT used as ARV)
- [ ] Sold-comp set (min 3 within 0.5-1mi, last 6 months, named reference comp)
- [ ] Listing photos (Firecrawl) OR documented retry exhaustion
- [ ] Owner record (PropStream) — title path clean
- [ ] Lien / mortgage / encumbrance check
- [ ] FEMA flood zone + crime grade
- [ ] Buyer-pool size check (min N=5 active buyers in subject ZIP + footprint, ≥1 recent purchase)
- [ ] Days-on-market + price-drop history + 12-month listing history

### MORTGAGE PAYOFF VIABILITY (Type 1 autonomous — added 2026-05-25 per operator learning on 23 Fields Ave)
- [ ] PropStream/public records pull surfaces recorded mortgage amount(s) on subject property
- [ ] Mortgage type flagged: fixed-balance (purchase mortgage, refi) vs revolving (HELOC, credit line, business LOC). Revolving lines carry elevated risk because current balance ≠ recorded amount.
- [ ] System computes: `payoff_headroom = Contract_Offer_Price − (Recorded_Mortgage_Amount + estimated_seller_closing_costs + listing_agent_commission_if_paid_from_seller_proceeds + buyer_agent_BSF_if_applicable)`
- [ ] HEADROOM ≥ $5,000: GREEN. Deal math viable. Proceed.
- [ ] HEADROOM $2,500–$5,000: AMBER. Surface as Type 1 informational note in deal-room: "Payoff math is tight; seller proceeds are thin. Recommended: confirm current mortgage balance with listing agent before EMD wire."
- [ ] HEADROOM < $2,500 OR negative: RED. Surface as Type 2C card with full diagnosis: "Mortgage payoff math may not close. Recorded mortgage $X, contract price $Y, estimated closing costs $Z, projected seller net $W. Action required: verify current mortgage balance with listing agent; if balance has grown above recorded amount, deal may not close on current terms. Options: (a) request seller bring funds, (b) renegotiate contract price upward + reprice assignment to end buyer, (c) terminate during inspection."
- [ ] If mortgage type = revolving line of credit (HELOC, business LOC, credit line revolving): elevate severity one tier. Recorded amount is the lower bound; current balance may be higher. Always trigger Type 2A draft: "Text/email to listing agent: 'Quick diligence question — can you confirm current mortgage balance from seller? Need to verify payoff math for closing.'"
- [ ] If multiple liens present (2nd mortgage, judgment liens, mechanic's liens, tax liens): sum all into payoff_total before headroom calculation
- [ ] Pre-EMD-wire gate: Operator's Type 2B EMD wire action requires this check to be GREEN, or operator must explicitly override with named justification recorded in deal Notes + Spine entry

Genesis: 2026-05-25 — operator under contract on 23 Fields Ave (Memphis 38109) at $61,750. Buyer-side agent Almira at Grandin Taylor Properties surfaced mid-inspection: "There is an existing mortgage on this property. Are they aware that they have to payoff the mortgage on or before closing?" Operator pulled PropStream records and found: Terrance Williams acquired property 12/18/2025 for $15,000 cash; immediately recorded $55,000 revolving credit line with Genesis Prop Managers Corp 01/06/2026. Payoff headroom against $61,750 contract = ~$5,000-6,000 after estimated closing costs + Candice Hardaway BSF. AMBER per this new check. Critically, revolving line type means current balance may exceed recorded $55K — operator now texting Candice for current Genesis payoff figure to confirm headroom is real. Operator's listing-agent thread (Candice Hardaway, KW) had referenced "math fit cleanly" on 23 Fields vs. Steele (where owner owed ~$115K and couldn't close), but specific 23 Fields mortgage figure was never explicitly disclosed — only implied by which deals Candice chose to send vs. hold.

Same regression class as INV-008 (parse comms for structured signal) + the existing contract-clause auto-extraction subsection — the data was in PropStream's public records, the system just didn't compute against contract price proactively. Underwriter Agent should make this check a hard precondition before any new deal advances to Outreach_Status = Offer Accepted.

Out-of-scope for v1: predicting credit-line draw behavior. System cannot know if Terrance has drawn additional funds since 01/06/2026 recording — that requires either listing agent communication or title company payoff letter. The check should flag the risk, not estimate the unknown.

### STRUCTURAL MATH (powered by Decision Preconditions Rule 1 — Type 1 autonomous)
- [ ] `Investor_MAO = Buyer_Median − Est_Rehab`
- [ ] `Your_MAO = Investor_MAO − Wholesale_Fee`
- [ ] Contract price ≤ `Your_MAO` (if higher: Type 2C surface with full diagnosis — never auto-pass)
- [ ] ARV ceiling with named reference comp

### PHYSICAL CONDITION (powered by INV-005 — Type 1 autonomous)
- [ ] `Rehab_Estimated_At` populated (vision or manual_operator with provenance)
- [ ] `Rehab_Source` flagged
- [ ] If `manual_operator`: nightly vision retry per INV-005 discipline
- [ ] Condition vs photos within tolerance (PN-07a Sturtevant regression)
- [ ] Insurance-relevant condition flags surfaced if Type 2C-worthy

### LEGAL + MARKET (Type 1 autonomous)
- [ ] State NOT in wholesale-restrictive list (IL, MO, SC, NC, OK, ND) — HARD FAIL, no override, Type 2C surface
- [ ] Assignment language confirmed (or double-close capital flagged)
- [ ] Inspection contingency present (HARD RULE, no override path)
- [ ] TN-specific: Memphis assignment clause checked

### CONTRACT-CLAUSE AUTO-EXTRACTION (Type 1 autonomous — folded into INV-023 scope per 2026-05-23 operator decision)
- [ ] Executed contract PDF detected and parsed (DocuSign / Authentisign / manually-uploaded TAR / TREC / state-specific PSAs)
- [ ] Purchase price extracted and cross-checked against Listings_V1 Contract_Offer_Price
- [ ] EMD amount + deadline + holder + holder contact info extracted into Property_Intel
- [ ] Financing contingency status (waived / loan-type-specified) extracted
- [ ] Appraisal contingency status (contingent / non-contingent) extracted
- [ ] Inspection period length + start date computed from Binding Agreement Date
- [ ] Closing date extracted, calendar invite auto-generated (Type 1)
- [ ] Title cost allocation parsed: who pays title search, who pays owner's policy, who pays mortgage policy
- [ ] Non-Assignability clause status: in force / struck through / explicitly amended
- [ ] Section 8 (Inspections) Buyer's Resolution Period length extracted
- [ ] Special Stipulations section parsed for any non-standard clauses
- [ ] Both-side closing cost preview generated: buyer-side total + seller-side total + assignee-side total (when contract is assignable)
- [ ] All extracted clauses surface in deal-room as Type 1 hydrated data; ambiguities surface as Type 2C cards

Genesis: 2026-05-23 operator + Maverick manually read 11-page TAR RF401 for 23 Fields Ave to answer (a) EMD refundability question, (b) Section 16 Non-Assignability strikethrough verification, (c) "Seller to pay for title search. Buyer to pay for owners/mortgage policies" cost-allocation buyer-clarification request from Almira at BBC. Each manual read consumed operator + Maverick time. Underwriter Agent should extract all of this on first PDF detection and store in Property_Intel with clause-level provenance. Same regression class as INV-008 (parse comms for structured signal) — the data is already in the document; the system shouldn't make operator re-read it.

Out-of-scope for INV-023 v1 implementation: clause-level semantic interpretation that requires legal judgment (e.g., "is this Special Stipulation enforceable in TN?"). That's Type 2C surface for attorney review, not Type 1 extraction.

### DOWNSTREAM CASCADE ON PASS
- [ ] `Ready_For_Contract = true` (Type 1)
- [ ] Crier announces transition with full summary (Type 1)
- [ ] DocuSign envelope auto-GENERATED with contract content (Type 1) — Approval Queue awaiting signature (Type 2B)
- [ ] Buyer-outreach drafts auto-generated for top N InvestorBase smart-match buyers (Type 1) → Approval Queue (Type 2A)
- [ ] EMD wire procedure card auto-created with deadline countdown (Type 1) — wire requires authorization (Type 2B)
- [ ] Calendar invite for closing date with title company contact (Type 1)

### ON RETRYABLE FAIL
- [ ] Agent waits, retries per INV-022 backoff (5m → 30m → 2h)
- [ ] After exhaustion: Type 2C card with named failure + recommended remediation
- [ ] **Never "click to retry"** — agent retries autonomously until exhaustion

### ON STRUCTURAL FAIL
- [ ] Agent computes full failure diagnosis
- [ ] Type 2C card: (a) named failure, (b) supporting data, (c) recommended remediation, (d) override path if applicable
- [ ] Wholesale-restricted state failure: NO OVERRIDE PATH (Constitution amendment required)

---

## 4. Forensic questions

**Q1 — Trigger surface.**
- α: `Outreach_Status` flip via cron-detected reconciler (autonomous)
- β: Operator-initiated "Run underwriter" button (operator-initiated re-run, not authorization)
- γ: Cron sweep nightly for Offer Accepted records without Ready_For_Contract (backstop)
- δ: All-of-above

Lean: δ. β is not a Rule 3 violation — operator-INITIATED re-run is different from operator-AUTHORIZING-work-system-could-do.

**Q2 — Idempotency.**
Multiple runs converge to same result. Partial-state detection. External-data-change handling. Race conditions if operator edits mid-run.

**Q3 — Type 2C surface UX.**
- α: Tier 1 Action Queue card with diagnosis
- β: Per-precondition card
- γ: Deal-status banner with expandable diagnosis
- δ: SMS on CRITICAL failures only

Lean: α + δ for CRITICAL.

**Q4 — Cost + latency budget.**
End-to-end latency. Per-run cost. Async (queue + callback) vs sync. Monthly burn at 30 DD-entries/month with nightly re-runs.

**Q5 — Dependency reality check.**
Minimum viable INV-022 subset for INV-023 v1. Phased delivery plan.

**Q6 — Override audit trail.**
Operator override on Type 2C: named justification required (no silent override). Spine + Notes entry. Override expiration on re-runs.

---

## 5. Resolution options

- **A** — Full spec ship after INV-022 lands
- **B** — Phased: v1 with minimum viable INV-022 subset; v2 expands as data sources land
- **C** — Pure spec doc only; defer until INV-005 + INV-020 + INV-022 SHIPPED
- **D** — Hybrid: Constitution amendment codifies checklist discipline now (binding on Maverick); Code implements when dependencies ready

Lean: **B + D**.

---

## 6. Constraints

- Forward-going only.
- Proposal-before-commit.
- Fabrication prohibition: agent NEVER fabricates pass. Missing data = retry until exhaustion, then surface.
- Constitution Rule 3 governs. No "click to authorize data pull."
- Operator override is Type 2C — explicit click + named justification.
- Inspection contingency NEVER waived (hardcoded).
- Wholesale-restrictive state NEVER bypassed at runtime (amendment required).
- All actions produce Spine entries.

---

## 7. Acceptance criteria

1. Q1-Q6 deliverables produced.
2. Operator selects A/B/C/D.
3. If B or D: Constitution amendment drafted for checklist refusal discipline.
4. Code implements + tests covering:
   - Full PASS: all preconditions met → Ready_For_Contract autonomous, DocuSign + EMD cards in operator Approval Queue
   - Retryable fail: pull times out → retry backoff → eventual success → resume
   - Exhausted retry: pull permanently fails → Type 2C surface
   - Structural fail: contract price > Your_MAO → Type 2C with diagnosis + override path
   - Hard-block: wholesale-restrictive state → Type 2C, NO override path
   - Regression: 23 Fields 5/12 scenario (theoretical pricing + missing Buyer_Median) → agent refuses
   - Override audit: operator override with justification → Spine entry written
5. Spine entry via `maverick_write_state`.
6. `AKB_MASTER_CHECKLIST.md` updated.
7. `Active_Queue.md` flips INV-023 to SHIPPED.

---

## 8. Compounding payoff

Synthesis agent. Operator's north star — *retire wife, 99% autonomous, operator decides important things only* — requires contract-phase autonomy safe by default.

The dam-break: operator unavailable for a week. New deals trigger Underwriter. Underwriter pulls all data via INV-022. Computes math, runs checklist, makes pass/fail. On PASS: DocuSign envelope + EMD card sit in operator queue. On FAIL: Type 2C card with diagnosis sits in queue. **Operator returns, processes queue, decides on flagged items, clicks signatures and wires.** No data-authorization clicks. No "did the system do this" anxiety.

---

## 9. Out of scope

- Buyer-side underwriter (dispo-phase quality gate)
- Closing-day agent
- Renegotiation agent
- Tenant verification (DD V3.0 parser scope, INV-008)
- Contractor walk-through scheduling
- Insurance pre-quote API

---

## 10. Open coordination questions

1. Canonical pre-existing `DD_Checklist` field shape? INV-023 replaces, extends, or consumes it?
2. Existing Appraiser agent (INV-005) becomes sub-agent of Underwriter or remains standalone?
3. Crier the right surface for "Ready_For_Contract = true"?
4. Underwriter Agent in `lib/maverick/agents/underwriter.ts` or as Make scenario?

---

## 11. Note on v1 → v2 rewrite

v1 embedded "click here to authorize data pulls" — Constitution Rule 3 violation (system being lazy, asking operator to authorize work the system has authority to do). v2 removes those violations:

- Hydration failures retry autonomously; surface only on exhaustion
- Type 2A surfaces only for outbound human communication
- Type 2B surfaces only for irreversible commitments (DocuSign, EMD)
- Type 2C surfaces explain WHY operator's call is needed, with full diagnosis

v1 retained in git history as discipline lesson.
