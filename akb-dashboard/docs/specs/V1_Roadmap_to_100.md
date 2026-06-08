# V1 Roadmap to 100% — Inevitable / Crawler / Maverick

**Paired with the INV-026 Progress Meter** (`/api/admin/progress-meter`,
`lib/progress-meter/`). This roadmap and the meter read the SAME registry
(`lib/progress-meter/stages.ts`), so a number on the meter always has a
corresponding row here. When a stage advances, edit the registry — both
update.

Authored 2026-06-08, post enrich + off-market-veto ship, post 346-Modder
end-to-end audit.

---

## The honest headline

The system's own doctrine (INV-026) says **% complete is the misleading
frame** — the load-bearing metric is *operator-required → operator-optional*.
So read the meter in this order:

1. **Lost-Phone stall count** — how many stages pile up if the operator
   vanishes for 7 days. **Today: 4 HIGH (underwrite, negotiate, contract,
   dispo) + 3 MEDIUM (outreach-reply, ARV, rehab).**
2. **Deal velocity** — **$0/mo** trailing 90d. Target: **$40K/mo for 3
   consecutive months** = Crawler 2.0 unlock (Bible §1.2).
3. **Operator hours** — **~33–58 h/wk** (est, unmeasured). Target **<15**.
4. *(secondary)* **Build %** — front half (intake→outreach) works; back
   half (underwrite→dispo) is the unbuilt majority of the money.

**Critical-path insight:** the back half is gated on **one** missing
capability — `Buyer_Median` hydration. Until it exists, the underwrite
gate (PC-26) HOLDs every record, and nothing downstream can run lights-out.
That is the single highest-leverage build in the system.

---

## The critical path (do these in order)

The fastest route from "$0/mo, 4 stalls" to "deals close without me":

### Phase A — Unblock the underwrite gate (highest leverage)
The whole back half is dammed here. 346 Modder proves it: a live
seller-agent reply with zero underwriting data behind it.

- **A1. Hydrate `Buyer_Median`** (INV-022). Two tracks:
  - γ (now, zero new code): operator-manual per-deal population for the
    active cluster — unblocks today's hot deals (346 Modder included).
  - α (durable): build the InvestorBase scraper / API client. 2–4 day
    lift, operator credential install. This is what makes it autonomous.
- **A2. Ship the INV-022 federation layer** — PropStream + RentCast +
  FEMA → `Property_Intel` with per-field provenance, triggered on
  `Negotiating`/`Offer Accepted`.
- **Moves:** underwrite 40→70, removes 1 HIGH stall.

### Phase B — Event-wire the appraisal cascade
Today enrich → ARV → rehab → underwrite are decoupled cron sweeps
(`appraiser-backfill`, limit=3/day, no trigger from enrich). Hot deals wait
days.

- **B1.** Emit an `enrichment_complete` event; subscribe ARV to it.
- **B2.** Prioritize the sweep by pipeline stage (hot deals first) and/or
  raise throughput now that Vercel is Pro.
- **Moves:** ARV 65→85, rehab 50→65, drops 2 MEDIUM toward LOW.

### Phase C — Close the negotiation loop
Inbound replies are operator-relayed (Quo/Gmail). This is the biggest
operator-hours sink after data hydration.

- **C1.** Ship INV-020 inbound triage: classify → attribute → auto-draft
  holding reply → operator-approval queue.
- **C2.** Build the unified attribution layer (INV-007 Step 2) — resolves
  INV-014/015/016 in one shot.
- **C3.** Stage-aware alert suppression (INV-010); close Quo delivery-
  confirmation gap (INV-017/019).
- **Moves:** negotiate 25→60, outreach 80→90, removes 1 HIGH stall, cuts
  operator hours materially.

### Phase D — Contract execution
- **D1.** Provision DocuSign; wire envelope create/send.
- **D2.** INV-024 webhooks (sent→viewed→signed→completed) → Action Queue.
- **D3.** INV-008 comms→DD-field auto-extraction.
- **Moves:** contract 30→70, removes 1 HIGH stall.

### Phase E — Dispo / closing orchestration
- **E1.** Buyer-blast + smart-match off the Buyers table.
- **E2.** Title-coordination cadence engine (the `Closing_F3..F9`
  idempotency keys are already stubbed in the Deals schema).
- **E3.** Assignment-execution → Closed transition + per-deal P&L
  (Phase 15.5) — **this is what makes the velocity number move off $0.**
- **Moves:** dispo 15→70, removes 1 HIGH stall.

### Phase F — Autonomous geographic expansion (the wife-retirement bet)
Only meaningful once A–E let a deal close lights-out.

- **F1.** Author the INV-025 Crawler Engine brief (D1–D4 decisions now
  groundable in real per-ZIP data).
- **F2.** Route planner over `ZIP_Registry` + `ZIP_Daily_Stats` density,
  explore/exploit budget split, per-ZIP eligibility.
- **Moves:** intake 70→95.

### Phase G — Instrument the meter itself
- **G1.** Replace the operator-hours estimate with a measured value
  (instrument code-paste coordination + dashboard time).
- **G2.** Add a Pulse detector for material meter movement → INV-026
  Type 2C card (a HIGH→MEDIUM drop or a velocity change should announce
  itself, per the brief).

---

## Per-stage ledger (mirrors the registry)

| # | Stage | Build | Risk | Stalls? | Path to 100% |
|---|-------|-------|------|---------|--------------|
| 1 | Intake / Crawler | 70% | LOW | no | INV-025 route planner |
| 2 | Verify | 85% | LOW | no | re-verify sweep; dedup v1/v2 |
| 2.5 | Enrich | 80% | LOW | no | backfill Year_Built; emit enrich event |
| 3 | Outreach | 80% | MED | yes | INV-020 reply handling; Quo delivery |
| 4 | ARV | 65% | MED | yes | event-wire; throughput; confidence floor |
| 5 | Rehab | 50% | MED | yes | photo reliability; INV-021 contract unify |
| 6 | **Underwrite** | 40% | **HIGH** | yes | **Buyer_Median (INV-022)**; INV-023 V2 |
| 7 | Negotiate | 25% | **HIGH** | yes | INV-020; INV-007 attribution; INV-010 |
| 8 | Contract/DD | 30% | **HIGH** | yes | DocuSign provision; INV-024; INV-008 |
| 9 | Dispo | 15% | **HIGH** | yes | buyer-blast; title cadence; P&L |

Infra (cross-cutting): **78%** — Pipeline_State engine, Spine, Pulse,
conveyor telemetry strong; data federation partial; event bus absent.

---

## How "100%" is defined

V1 is **100%** when the Lost-Phone stall count is **0** — a deal can flow
intake → dispo without the operator for 7 days — AND the velocity number
is live (deals actually closing). Build-% reaching 100 is necessary but
not sufficient; the stall count is the contract.

Sequencing rule: **A before everything.** B–E are largely parallel once A
lands, but each removes exactly one HIGH stall, so order them by which hot
deal is closest to that wall (today: C, because 346 Modder is sitting on a
live reply).
