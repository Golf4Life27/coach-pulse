# AKB Wholesale System — Build Status & Redesign

> **What this is.** A one-page map of (1) what's actually built and live today, (2) how the
> system would be designed from scratch, and (3) the incremental bridge between them. Written
> so the next session inherits the map instead of rediscovering it.
>
> **Visual companion:** [`system-map-redesign.html`](system-map-redesign.html) — open in any
> browser (self-contained, no internet needed). This `.md` is the text-of-record.
>
> Generated 2026-06-24 · grounded in `akb-dashboard` @ `main` `dd37960`. Status reflects the
> live env + `vercel.json` crons as of that date.

---

## 1. Build status — the belt, as actually built

A deal flows left→right through ten stages. **Most of the machine exists and is correct.** The
throttle is deliberately *off* on the expensive stages (cost safety) while we light it up stage
by stage. Status legend: 🟢 live · 🟡 built but gated dark (master switch off) · 🔵 built,
operator-triggered · 🟣 paused (off the clock, on-demand only) · ⚪ manual / operator-reserved.

| # | Stage | What it does | Status |
|---|-------|--------------|--------|
| 01 | **Source** | RentCast `fetchListingsByZip` — distress sourcing by ZIP | 🟣 Paused (`listings-intake` removed from `vercel.json`, on-demand only) |
| 02 | **Verify** | Firecrawl re-verify (still-active + URL confirm) | 🟣 Pausing (`url-backfill`, `freshness-reverify` removed) |
| 03 | **Enrich / Price** | RentCast AVM·comps·rent·tax → Appraiser ARV·Rehab·BuyerIntel | 🟡 Gated dark (`MAVERICK_CRON_ENABLED` unset → 503) |
| 04 | **Underwrite + Gates** | MAO, offer-readiness gate, opener floor, >85%-of-list block | 🟢 Live (Airtable formulas always compute) |
| 05 | **Promote / Sync** | Write eligibility fields (`Live_Status`, `Execution_Path`) from the math result | 🟡 Gated (lives on the MAVERICK crons → manual patch needed) |
| 06 | **Outreach · H2** | First-touch SMS via Quo. Agent-dedup · quiet-hours floor · send-cap | 🟢 **Live (2026-06-24)** · triple-locked · operator-triggered |
| 07 | **Reply handling** | `scan-comms` */10 → triage → tier-0 auto-close / tier-1 auto-ack / proposal+alert | 🟢 Live (auto-ack OFF by operator choice) |
| 08 | **Negotiate** | Counters, advanced comms | ⚪ Operator-reserved |
| 09 | **Contract** | Pre-contract math (INV-023) · DocuSign signatures | ⚪ Operator · built |
| 10 | **Dispo** | Assignment-spread gate · buyer fire-blast | 🔵 Built · operator-gated |

**Key numbers (2026-06-24):**

- **17** crons on a clock (after pausing 2 Firecrawl crons); most gated by one master switch.
- **~78** records in actionable statuses (mostly older SA / Memphis / Dallas inventory — not the focus).
- **3** fresh Detroit leads send-ready (19331 Hoover, 18681 Blackmoor, 19657 Gallagher); **2** sendable after the agent-dedup fix (Gallagher = shared brokerage line, correctly held).

**Where V1 stands right now.** The send path went live today (env deployed, route off the 503).
Math gates compute correctly. The one thing between here and first revenue is small and queued:
merge the agent-dedup fix → dry preview → operator approval → 2 texts. Cost is near zero:
RentCast **$0** (gated/removed), Firecrawl **$0** once the cron-pause merges. Everything
expensive is off a clock by design.

---

## 2. If it were built from scratch — one spine, not four substrates

**Root cause of the "endless loop of errors."** It is *not* bad business logic. It is that
**logic and state live in four places that must be hand-synced:**

1. Airtable formulas (`Execution_Path_Calc`, `Distress_Score`, `Stage_Calc`)
2. TypeScript "replicas" of those formulas (`lib/distress-score`, mls-date projection, …)
3. ~12 env flags (`H2_OUTREACH_HARD_DISABLE`, `MAVERICK_CRON_ENABLED`, `H2_COVERED_ZIPS`, …)
4. Vercel KV (idempotency claims, dispatch locks, seeded stores)

Almost every bug traces to a **desync** between these substrates:

- Dry-run reported 0 "Auto Proceed" while live produced them → the TS replica mis-modeled the Airtable formula (*logic in two places*).
- Fresh leads sat "stuck" with blank `Live_Status`/`Execution_Path` while the formula said Auto Proceed (*state in two places*; promote/sync was gated off).
- Repeated 503s → env flags set but not redeployed (*config that needs a deploy*).
- Agent-dedup over-blocked never-texted agents → the "contacted" definition was implicit and over-broad (*logic semantics unclear*).

**The redesign collapses the four substrates into one spine — seven moves:**

1. **One decision engine** — a single typed, tested module computes MAO / stage / eligibility. Airtable becomes a dumb store + UI. → zero drift; dry-run == live.
2. **One state machine per deal** — one status field with typed, guarded transitions, replacing `Live_Status` + `Execution_Path` + `Outreach_Status` + the formula twin. → "why is this stuck?" is always answerable.
3. **Config, not env-flag sprawl** — one runtime config record; going live = flip a value, effective instantly. → kills the "changed but not deployed" 503 class.
4. **One metered spend gateway** — every paid API call routes through a single gateway with a hard daily budget + kill switch + live meter. → cost is structural and visible, not policed by hand.
5. **Event-driven, not clock-driven** — a lead's state change triggers the next step; paid work happens once per lead at the right moment. → "nothing expensive on a clock" becomes the architecture.
6. **One autonomy line + one queue** — explicit line: auto left of it (source→price→first-touch→ack), operator right of it (counters, signatures, money), via one decision queue. → you always know what needs *you*, in one inbox.
7. **Observability built in** — one dashboard: pipeline funnel by stage, live spend meter, what's gated, what's stuck and why. → the system reports its own state; decisions stop vaporizing between sessions.

---

## 3. How the two differ

Same business (source → price → offer → negotiate → contract → dispo). The difference is
entirely in the **plumbing** — where logic, state, config, and cost live.

| Dimension | Today (organic V1) | Redesign (one spine) | Why it's more effective |
|-----------|--------------------|-----------------------|--------------------------|
| Business logic | Airtable formula **+** TS replica | One engine | No drift; test once |
| Deal state | 4 fields, hand-synced | One state machine | Never silently "stuck" |
| Go-live | Set env → redeploy | Flip one config | Instant, no 503s |
| Cost control | Yank cron entries | Metered gateway + cap | Structural, visible |
| Work trigger | ~17 clocks | Events | Pay per deal, not per tick |
| Operator touch | Scattered (statuses, proposals, alerts) | One decision queue | One inbox of "needs you" |
| Knowing status | Manual code/Airtable audit | Live funnel | Context survives sessions |

---

## 4. The bridge — don't rewrite, migrate after revenue

**A from-scratch rebuild would be the wrong move.** The redesign is a north star, not a next
step. The current system works and is one merge from sending; the directive is "activate V1,
make money, then clone and expand after seeing success." So the bridge is small, independently
shippable moves — no parallel build — *after* revenue, in payoff order:

| # | Move | Effort | Kills |
|---|------|--------|-------|
| 0 | **Ship V1 to first revenue.** Merge staged branches, send the 2 Detroit offers, work replies. Touch no architecture. | this week | — |
| 1 | **One runtime config replaces the env-flag toggles.** Go-live becomes a flip, not a redeploy. | small | the 503 / "not deployed" class |
| 2 | **Make eligibility self-syncing.** Promote writes `Execution_Path` straight from the math result. | small | leads stuck blank (tonight's manual patch) |
| 3 | **One metered spend gateway.** Route every RentCast/Firecrawl call through a budgeted gateway + live meter. | medium | "am I burning credits?" |
| 4 | **Collapse Airtable-formula logic into the engine.** TS engine becomes the only place stage/MAO/distress is computed. | medium | replica drift |
| 5 | **Event-driven pipeline** (replace polling crons) — only when volume justifies it. | later | clock-based burn risk |

**One-line takeaway.** Today's system is a capable organic V1 whose pain is plumbing, not
business logic. The redesign isn't "build it again" — it's *collapse four hand-synced layers
into one spine*, incrementally, **after** the machine has proven it makes money. **Moves 1–2
alone would have erased most of the failures fought through in the 2026-06-24 session.**
