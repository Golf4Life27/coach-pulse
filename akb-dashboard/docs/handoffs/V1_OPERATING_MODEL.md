# AKB V1 — Operating Model (the one page)

The single reference for how V1 runs. Plain English. If anything in a chat
thread or a stray comment contradicts this, **this wins**. Updated 2026-06-23.

---

## The two data tools — different jobs, not interchangeable

- **RentCast = the lead faucet.** An API. You ask *"what's for sale in {ZIP}?"*
  and it returns a clean, structured list with everything you sort and act on:
  price, beds, **days-on-market, price drops** (your distress filters) and the
  **agent's name + phone** (what you actually text). It does **sourcing AND
  filtering in one call**, and it is the *only* reliable source of the agent
  phone + distress signals.

- **Firecrawl = the "is it still on-market?" checker.** It reads one listing
  page like a browser to confirm a lead hasn't already sold. Used for the
  **re-verify** step only. It **cannot source or filter** — scraping a search
  page doesn't reliably yield the agent phone or clean distress data.

> Decided 2026-06-23 (scoped and rejected): Firecrawl **cannot** replace
> RentCast for sourcing. Don't revisit it — it produces un-textable,
> un-filterable records.

---

## The cost rule (the only one that matters)

**Nothing expensive runs on a clock.** The ~$250/week bleed was scheduled crons
hammering RentCast 24/7 on a broken pipeline that threw every result away. Those
crons are **off**. Going forward, every paid call is a **deliberate, bounded run
tied to an actual outreach batch.**

> **Cost scales with activity, not time. A quiet day costs about $0.**

---

## The rhythm — the whole operation, end to end

1. **Source on purpose.** Trigger one RentCast intake run for a ZIP (you, or
   Claude on your word). Pennies. Fresh leads land as v2 / Auto-Proceed /
   math-gated, with agent phone + distress tags.
2. **Auto-price + floor.** The system caps each offer at
   `MIN(65%-of-list, Buyer_Median − fee)` — protects your spread (built + merged).
3. **You flip the send-lock once.** H2 texts the batch at the floored offer.
4. **Auto-respond.** The system closes the "no"s, acknowledges the "yes"s, and
   pings you only on real negotiations.
5. **You.** Advanced negotiation → contract → assign (the gate guarantees
   assignment ≥ contract + fee) → sign → wire.

---

## Who does what (so you stop juggling it)

- **Claude Code — the engineer.** Builds, fixes, triggers the runs, diagnoses,
  keeps the machine coherent. *Tracking the system is Claude's job, not yours.*
- **Cowork — your hands inside Airtable.** Review queue, approvals, judgment
  edits on records.
- **You — four things only.** Say *"source {ZIP}"*, flip the send-lock, handle
  real negotiations, sign/wire.

---

## Scheduled vs. on-demand vs. manual

| Cadence | What | Cost |
|---|---|---|
| **Cron (cheap, always on)** | Inbound-reply sync + auto-respond | SMS + pennies of AI |
| **On-demand (bounded, paid)** | RentCast sourcing · Firecrawl re-verify | Per batch — **never a cron** |
| **Manual (you / Cowork)** | Market selection, advanced comms, signatures, money | — |

---

## Go-live checklist (one time, your hand on the trigger)

1. **Reactivate RentCast billing** (app.rentcast.io).
2. **Trigger a sourcing run** for a target ZIP → fresh leads land.
3. **In Vercel, set:** `H2_OUTREACH_HARD_DISABLE` off · `H2_COVERED_ZIPS` = the
   ZIP(s) · `H2_OPENER_FLOOR_LIVE=true` · `REPLY_AUTO_ACK_LIVE=true`.
4. H2 texts the batch. You handle the negotiations it escalates.

---

## Current state (2026-06-23)

**Built, merged to `main`, 2,680 tests green, deployed:** math gates (buy-side
INV-023 + sell-side assignment-spread), interest auto-ack + rejection
auto-close, the re-verify belt + its controlled trigger.

**All send flags default-OFF — the send path is locked.** The only things
between here and live volume: **reactivate RentCast** + the **go-live flips**
above. Both are operator actions; everything else is done.
