# Operator-Ready Punch List — what stands between you and running this yourself

> **Companion to [`SYSTEM_MAP_AND_REDESIGN.md`](SYSTEM_MAP_AND_REDESIGN.md).** The map shows the
> architecture and the long-term north star. *This* is the short, concrete list to migrate your
> **daily work from chat → the dashboard.**
>
> **You do NOT need the redesign/rebuild to operate.** You need the **4 wires** below closed.
> Each is a standalone PR like the ones from the 2026-06-24 session — reviewable, mergeable,
> no parallel build.
>
> Written 2026-06-24, grounded in the live `akb-dashboard` surface.

---

## The bar — what "operating from the dashboard" means

A full money-making day touching only:

- **The dashboard** — decide, approve, send, watch the funnel + spend.
- **Quo** — the actual texting relationship with agents.
- **DocuSign / bank** — signatures and money.

…with **no chat session** required to patch state, fire a workflow, or answer "where do we
stand / am I burning money." Quo, DocuSign, and the bank are *always* outside the dashboard —
that's the human/legal/money layer and it should stay human. The dashboard makes you the
operator of the **pipeline**, not a replacement for the relationship.

---

## What already works (this is not greenfield)

- **`/queue`** — a real decision inbox: pulls reply proposals from `scan-comms`, with working
  **Approve / Reject / Snooze** buttons.
- **`/pipeline`, `/funnel`, `/deals`, `/buyers`, `/pulse`, `/pipeline/[id]`** — pages exist.
- **The engine** — send path, math gates, reply triage, send-cap, quiet-hours, cost safety —
  built and (mostly) live.

The skeleton of "run your day here" is already in the repo. Four wires are open between that
skeleton and you actually operating.

---

## The 4 wires

| # | Wire | Done when | Removes (why I get pulled in) | Size |
|---|------|-----------|-------------------------------|------|
| 1 | **See + send outreach from the dashboard** | You open a screen of today's priced, eligible offers and fire the batch (dry preview → live) yourself | Firing sends is a GitHub workflow / me | **M** |
| 2 | **Approve-actually-sends** | Clicking Approve on a reply in `/queue` dispatches the drafted response (with edit-before-send) | Approve only marks `Approved`; the actual reply send isn't wired | **S–M** |
| 3 | **Eligibility auto-sync** | A fresh lead that clears the math gate becomes send-eligible with **no** manual Airtable patch | Leads land blank (`Live_Status`/`Execution_Path`) and I hand-fix them | **S** |
| 4 | **Trustworthy awareness** | One landing page shows live pipeline counts + a spend meter you trust without asking | "Where do we stand / am I burning credits" → me | **M** |

### Wire 1 — See + send outreach from the dashboard
- **What:** a review screen (extend `/today` or `/pipeline`) listing today's send-ready leads
  (eligible · covered ZIP · within caps) with the **exact rendered offer**, plus a **Send**
  action that calls the existing H2 send path in dry then live mode.
- **Touches:** one page + a thin operator-auth (`DASHBOARD_PASSWORD` session) action that hits
  the outreach route. The route, send-cap, quiet-hours floor, and triple-lock already exist —
  this is UI + a safe operator trigger, **not** new send logic.
- **Done when:** you fire the day's batch from the dashboard; every existing safety gate still
  enforced; no GitHub Action, no me.

### Wire 2 — Approve-actually-sends (close the reply loop)
- **What:** today, approving a `jarvis_reply` proposal in `/queue` only sets `Status=Approved`
  in Airtable. Make Approve **dispatch** the drafted SMS (the `Suggested_Action_Payload` already
  carries `to` + `draftBody`), with **edit-before-send** so you can adjust wording first.
- **Touches:** `app/api/proposals/route.ts` approve branch — reuse the proven send rails
  (quiet-hours, Do_Not_Text, one-per-thread KV claim, audit) from `lib/auto-ack` / `auto-close`.
- **Done when:** you run the whole reply loop in `/queue` — read, edit, send — without Quo
  copy-paste or me. (Highest-judgment wire: it sends real messages to agents, so it ships with
  the same guards as the auto-responders.)

### Wire 3 — Eligibility auto-sync (un-stick fresh leads) ← do first
- **What:** the writable `Live_Status` / `Execution_Path` fields the send filter reads are
  supposed to mirror the computed `Execution_Path_Calc`, but the sync lives on the gated
  MAVERICK crons — so fresh leads land blank and need a manual nudge (exactly tonight's patch).
- **Touches:** the promote step (`lib/crawler/auto-promote.ts` + intake/promote route) or a
  small always-on sync that writes the writable fields straight from the math result.
- **Done when:** a lead that computes `Auto Proceed` is send-eligible automatically.
- **Note:** this is **Move 2** in the map and the **single highest-leverage** wire — it removes
  the most frequent reason I get pulled back in.

### Wire 4 — Trustworthy awareness (funnel + spend + one cockpit)
- **What:** confirm/wire `/funnel`, `/pipeline`, `/pulse` to live, accurate data; surface a
  **spend meter** (the `paid_api_spend` detector already exists in `lib/pulse/detectors`);
  un-gate or finish the `/today` cockpit so there's one "what needs me today" landing page.
- **Touches:** page data-fetching + the V2 flag (`/today` is currently dark behind it).
- **Done when:** you open one page and trust the counts + spend without asking me.

---

## Order

| Step | Do | Why this order |
|------|-----|----------------|
| **0** | **Ship the V1 sends** (≈1 merge away) → first revenue | Money first. Prove the loop earns before more building. |
| **1** | **Wire 3 — auto-sync** | Small; kills the most frequent "pull me back" reason immediately. |
| **2** | **Wire 1 — dashboard send** | The core morning action becomes self-serve. |
| **3** | **Wire 2 — approve-sends** | The throughout-day reply loop closes; ship with care (real agent messages). |
| **4** | **Wire 4 — funnel + spend + Today** | The trust layer — you stop asking me for status. |

---

## What stays outside the dashboard — always

- **Quo** — the texting relationship.
- **DocuSign** — signatures.
- **Bank** — money movement.
- **Me** — for *changes, bugs, and expansion*. Not for your daily operating loop.

---

## Honest sizing

Bounded, not open-ended: **a handful of focused sessions, each a standalone PR.** No hard date —
I've been wrong being over-confident before — but the scope is *nameable* (these 4 wires), which
is the whole point. The reason it has *felt* like building forever is the four hand-synced layers
the map describes; **Wire 3 alone removes most of why I keep getting pulled back in.** Close all
four and your daily money loop lives in the dashboard, and I'm a tool you reach for, not a
dependency you operate through.
