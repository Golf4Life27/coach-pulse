# INV-020 Brief — Gmail Inbound Triage + Action Queue Surfacing for Active Deals

**Author:** Maverick (Owner's Rep)
**Date:** 2026-05-22 (v2 — autonomous-by-default rewrite)
**Status:** BRIEFED, awaiting Code audit
**Severity:** HIGH (active deals dying in operator inbox; concrete miss documented below)
**Pair-with:** INV-006 (cron reconciler architecture pattern), INV-008 (parse comms for structured signal), Reply_Triage L3 Make scenario 4812756 (existing inbound classifier — Quo SMS only), Decision Preconditions Amendment Rule 3 (Dashboard-First Autonomy Principle)
**Adjacent capability:** Quo MCP reconnected 2026-05-22 with `fetch-missed-calls` capability — missed calls become another inbound channel for the same triage architecture; fold into scope.

---

## 1. Symptom + concrete genesis

**Operator missed a hot Texas seller-agent response for 48 hours.** Email thread:

- **5/20 11:58 AM CT:** Operator sent cash offer to Les Mauck (lesmauck@gmail.com), seller's agent for 5435 Callaghan Rd, San Antonio TX 78228, at $127,000 cash quick close
- **5/20 12:06 PM CT:** Les replied — *"After a conference with my seller, she would like the offer presented in the standard 1-4 residential contract form."* 8 minutes later. Seller engaged immediately.
- **5/22 13:30 CT:** Maverick session 22h after seller engagement still showed this thread as unread

Also surfaced in same sweep: **1665 Ford St Mutual Release** sent via Authentisign on 5/11 — 11 days unsigned. Contract technically still in force without signed release.

**Two real deal-affecting items slipped through in 14 days, buried under ~20 newsletter/notification UNREAD entries in operator's inbox.**

Inevitable's explicit purpose is to prevent this exact failure mode. Lost-Phone Test: operator phone dies for a weekend, system continues running, operator returns to a triaged dashboard queue not a 200-message inbox dig.

---

## 2. Autonomy boundaries (Type 1 / 2A / 2B / 2C taxonomy — Constitution Rule 3)

This brief replaces a v1 that embedded "operator click to authorize" patterns throughout the happy path. Those were violations of Constitution Rule 3 (Dashboard-First Autonomy). Restated correctly:

**Type 1 (always autonomous, no operator surface):**
- Gmail inbound polling
- Sender → contact-graph attribution
- Subject + body → severity classification
- Attribution to active Listings_V1 / Deals record via reused `scorePropertyMatch`
- Spine entry per processed inbound
- Auto-archive of LOW classifications
- Auto-label of MEDIUM classifications (no dashboard surface, accessible if operator queries)
- Auto-draft of holding-reply text for HIGH-severity seller/agent engagement (e.g., "Got it, formalizing the offer on TREC 1-4, back to you within 48 hours")
- DocuSign / Authentisign envelope state polling for active deals (orthogonal to Gmail but adjacent — direct webhook surface)

**Type 2A (system drafts → operator approves in dashboard queue, SMS variant-picker for urgent):**
- The holding-reply itself ships into operator's dashboard Approval Queue as a Type 2A item with one-click send
- If the HIGH inbound is older than X hours without queue acknowledgment, Maverick SMS-variant-picks the operator with the queued draft. Operator replies → system sends approved variant. Operator silent → system HOLDS (per operator preference 2026-05-22: "Hold until operator responds in dashboard or to the text")
- Holding-reply graduation path: after N operator-approved holdings, surface the auto-send graduation in dashboard for operator authorization

**Type 2B (always operator-click, never auto-fires, never graduates):**
- DocuSign envelope signing (irreversible legal commitment)
- Authentisign envelope signing
- Mutual Release signing
- These don't graduate. Hardcoded operator-click forever.

**Type 2C (always operator-click, judgment required):**
- Inbounds containing counter-offers from sellers
- Inbounds containing buyer-side counter-offers when our property is for sale
- Inbounds containing inspection findings requesting credit/repair negotiation
- Surface to dashboard with full context + recommended response, but operator decides

**Anti-pattern forbidden by Rule 3:** "Click here to authorize the system to pull data" — never used in INV-020. The system has the data and the authority; it acts.

---

## 3. Forensic questions

**Q1 — Active-deal contact graph.**
Inventory all email addresses currently in active conversation with operator's `alex@akb-properties.com`:
- Sellers' agents on active Listings_V1 records (where `Outreach_Status` ∈ {Response Received, Negotiating, Offer Accepted, Contract Sent})
- Buyer-side contacts on active Deals records
- Title/escrow/attorney contacts on properties with `Envelope_ID` populated
- DocuSign/Authentisign system senders for active envelopes

Deliverable: contact-graph snapshot per active deal.

**Pre-investigation hint:** Airtable schema likely has `Listing_Agent_Email`, `Buyer_Agent_Email`, `Seller_Email`, `Title_Company_Contact` fields somewhere on Listings_V1 / Deals. Confirm.

**Q2 — Gmail inbound classification accuracy.**
Build classifier (regex-first, LLM fallback) to tag inbound emails with severity:

- **HIGH** = seller/agent engagement on active deal: "yes," "willing," "contract form," "send PA," "EMD wire instructions," DocuSign envelope requesting signature, mutual release, counter-offer, "let's close"
- **MEDIUM** = informational on active deal: "completed signing," "received," receipts, market reports for active markets
- **LOW** = newsletters, cold outreach, promotional content, service notifications, marketing

Run classifier against last 30 days of operator inbox. Document TP/FP/FN per severity tier.

Regression test: the 5/20 Les Mauck email scores HIGH.

Acceptance threshold: HIGH tier ≥95% recall before holding-reply auto-draft is enabled.

**Q3 — Architectural placement.**

- α: **Standalone Gmail watcher cron** — polls `Gmail:search_threads` every 5-15 min, runs classifier autonomously, drafts holding-reply for HIGH, writes everything to Airtable `Inbound_Queue` table, surfaces Type 2A items in dashboard. Mirrors INV-006 architecture (pure helper + thin orchestration).
- β: **Extend existing Reply_Triage L3** (Make scenario 4812756) — adds Gmail webhook trigger alongside existing Quo webhook. Less new code but couples two channels with different semantics.
- γ: **All-of-above** — α for surfacing + Quo `fetch-missed-calls` integration via β for L3, separate concerns.

Maverick lean: α first, integrate β later when Quo missed-calls inclusion warrants. The Quo `fetch-missed-calls` capability discovered 2026-05-22 should be folded in once the inbound-classification surface is proven on Gmail.

**Q4 — Attribution to active deal.**
When inbound arrives, system needs to match sender + subject + body to a specific Listings_V1 / Deals record. Reuse existing attribution infrastructure:
- `lib/timeline-merge.ts:scorePropertyMatch` (already used for Quo SMS attribution; see INV-016 candidate for known bug on price-match)
- Listing_Agent_Email exact match → instant attribution
- Subject-line property-address regex → secondary signal
- Body content + recipient context → tertiary signal

Document attribution confidence thresholds — at what confidence does the system auto-classify vs surface for operator clarification?

Recommended: ≥0.7 confidence → autonomous classification + holding-reply draft. <0.7 → surface for operator confirmation as Type 2C (genuine ambiguity).

**Q5 — Holding-reply autonomy and re-prompt cadence.**
Once HIGH classified + attributed:

- System auto-drafts holding-reply tuned to the inbound type
- Draft lands in operator's dashboard Approval Queue (Type 2A)
- Maverick SMS-variant-picks operator after X hours if queue unacknowledged (X configurable; recommended 4h for HIGH inbounds)
- Per operator preference 2026-05-22: if both dashboard AND SMS go unanswered, **system HOLDS — never auto-fires Type 2A outbound on timeout**
- Re-prompt cadence: SMS retry at +4h, +12h, +24h. After that, escalation card in dashboard (still no auto-fire)
- Operator can mark "I see this, holding off intentionally" — pauses re-prompts without dismissing the draft

Deliverable: state machine + re-prompt schedule + hold semantics.

**Q6 — DocuSign / Authentisign integration.**
DocuSign already has direct webhook surface. Authentisign too. Both should bypass Gmail-inbound classification entirely:

- DocuSign envelope state changes → direct write to dashboard Action Queue as Type 2B item (envelope ready to sign)
- Authentisign envelope state changes → same shape
- These never flow through INV-020's Gmail classifier — wrong channel, wrong shape

Confirm with Code: do DocuSign/Authentisign webhooks already wire to dashboard? If not, file as INV-024 candidate.

---

## 4. Resolution options

- **A** — α + holding-reply Type 2A draft pipeline + SMS variant-picker for HIGH. Full surface.
- **B** — α only (classify + surface to dashboard, no auto-draft of holding-reply). Lightweight v1; auto-draft layers in v2 after operator confidence with the surface.
- **C** — β extension of Reply_Triage L3.
- **D** — Hybrid: B ships now (classification + dashboard surface + SMS variant-picker on HIGH for operator-drafted reply), A layers on after classifier hits ≥95% HIGH recall.

Maverick's lean: **D**. The Les Mauck miss would have been caught at B level (just surfacing) — A is the autonomy graduation, not the urgent fix. Ship B fast, graduate to A once classifier accuracy is proven.

---

## 5. Constraints

- Forward-going only. No backfill of pre-INV-020 inbox.
- Proposal-before-commit. Q1-Q6 returned; operator picks A/B/C/D.
- Constitution Rule 3 (Dashboard-First Autonomy) governs all surfaces. Type 1 work is autonomous. Type 2A surfaces drafts to dashboard queue. No "click to authorize data pull" anywhere.
- Fabrication prohibition. Classifier shows evidence (matched text snippet) for HIGH classification; no auto-promotion on LLM "vibe."
- HIGH-tier classifier needs ≥95% recall (operator cannot afford another Les Mauck miss).
- LOW-tier classifier needs ≥98% precision (operator's phone cannot be SMS-spammed by newsletters).
- Gmail allowed connection ID is `8085651` (per memory). Never use `6351889`.
- Per operator preference 2026-05-22: Type 2A holding-replies HOLD if dashboard + SMS both unanswered. Never auto-fire on timeout.

---

## 6. Acceptance criteria

1. Q1-Q6 deliverables produced.
2. Operator selects A/B/C/D.
3. Code implements + writes tests covering:
   - Classifier regression test: the Les Mauck 5/20 email scores HIGH
   - Classifier regression test: representative newsletter scores LOW
   - Attribution test: Les Mauck email attributes to 5435 Callaghan Rd record
   - State machine test: SMS variant-pick fires within 4h of dashboard-unacknowledged HIGH inbound
   - Hold semantics test: dashboard + SMS both unanswered → no auto-fire, holding-reply remains in queue
4. Spine entry via `maverick_write_state` (`event_type=principle_amendment`, `attribution_agent=jarvis`).
5. `AKB_MASTER_CHECKLIST.md` updated.
6. `Active_Queue.md` flips INV-020 to SHIPPED.

---

## 7. Compounding payoff

Operator stated explicit goal: *"need to finish up my build so I can spend 95% of my time in the Dashboard, so emails like this don't slip through the cracks."* INV-020 is the load-bearing investigation for that goal.

The dam-break: operator phone dies for a week → system classifies inbounds, surfaces HIGH items to dashboard, SMS-prompts for variant approval on critical ones, HOLDS on no-response so nothing wrong happens → operator returns to a 5-item triaged queue, not a 200-item inbox dig. Worst case the deal stalls a few days. Best case operator processes one queue per day and the system runs.

Estimated impact based on observed 14-day sample: 1 critical-miss + 1 high-priority-miss out of ~20 inbounds. Catch rate target post-INV-020: 100% on HIGH-tier, false-alarm rate ≤5%.
