# AKB — System Handoff (read this before touching anything)

**For:** the next agent.
**From:** Alex (operator) + the work to date.
**Rule #1:** Read this whole file and study what exists **before** you build, rename, or
relabel anything. Do not invent new code words. Do not start parallel versions of
things that already exist. Wire the screens we have to the data we have.

---

## The goal — one sentence

**Find distressed properties → verify they're really for sale and really distressed →
send a cash offer → negotiate against math that respects rehab, comps, and buyer data →
get it under contract → sell it to a cash buyer → then do it again, moving market to
market across wholesale-friendly parts of the country.**

That's the whole business. Everything else is plumbing in service of that loop.

---

## The loop, in plain English (and who owns each step)

| # | Step | Owner (agent) | Honest status today |
|---|------|---------------|---------------------|
| 1 | **Find** distressed listings | Sentinel (intake) | **Runs by itself** — daily scan by ZIP. Detroit just turned on (30 ZIPs). |
| 2 | **Verify** it's available + distressed | Sentry + Appraiser (photo read) | **Partial** — confirms for-sale + reads photos for rehab; misses some. |
| 3 | **Price** it (the math) | Appraiser | **Math works, data is thin** — ARV from comps, rehab from photos, a worst-case max offer. Missing CMA + buyer ceiling on most deals. |
| 4 | **Offer** | Crier (texts the agent via Quo) | **Partial** — sends the cash-offer text. Should NOT send until step 3's data is complete. |
| 5 | **Negotiate** vs the math | You, by hand | **Manual** — counters are saved to a list, but no screen shows them yet. |
| 6 | **Contract** | Scribe + DocuSign | **Not built** — groundwork only; e-signing not wired. |
| 7 | **Dispo** (sell to a buyer) | Scout + Forge | **Partial** — buyer list + warm-ups exist; matching a deal to a buyer and blasting it is not automated. |
| ↺ | **Repeat** in the next market | ZIP_Registry drives this | Markets configured: Detroit, Memphis, San Antonio, Houston, Dallas. |

**The blunt truth:** steps 1–4 mostly run on their own. Step 5 is you. Steps 6–7 are
half-there. The backend data is actually *ahead* of the dashboard screens — which is
why it can feel broken even though a lot works. The fix from here is **wiring, not
rebuilding.**

---

## Decoder ring (the "code words" — never use these with Alex without explaining)

- **"Dossier" / "Deal File" / "Dossier #002"** = a one-page underwrite for a single
  property: its ARV, its rehab estimate, the most-conservative max we should offer, and
  a verdict (good deal vs hold). "#002" just means it was the second one built. **It is
  not a feature, it's a document for one house.**
- **"12724" and "15875"** = two *different* houses on the same street (12724 Strathmoor
  and 15875 Strathmoor, Detroit). They got confused for each other and caused a lot of
  the churn. They are not the same deal.
- **"Pessimistic MAO" / "the bound bug"** = the maximum we should offer, figured with
  worst-case assumptions (high rehab, low resale). The bug used best-case by mistake and
  made a weak deal look strong. It's fixed and test-locked now.
- **"Gate"** = an automated checkpoint a deal must pass to move forward.
- **"Quo"** = the texting system (OpenPhone) we use to message listing agents.
- **"The spine"** = the backend data plumbing built over the last few days.
- **"CMA"** = the comparative market analysis you provide. **"InvestorBase / buyer
  ceiling"** = what cash buyers will actually pay — the top of our resale range.

---

## What Alex has dreamed of (the target — build toward this, not away from it)

1. **The whole workflow lives inside the Dashboard.** No bouncing between chat, Airtable,
   and texts. One cockpit.
2. **Maverick shows the action items** — a short list of "here's what needs you" — each
   with a **recommendation and the reasoning why or why not** to do it.
3. **Every deal page carries ALL the data needed to decide**, before any offer goes out:
   - comps / ARV ✓
   - rehab estimate ✓
   - **CMA (operator-provided or sourced)** ✓
   - **InvestorBase / cash-buyer ceiling** ✓
   These four are a **hard checklist** — an offer should not fire until they're present.
   (This is a direct operator requirement, not a nice-to-have.)
4. **Autonomy** across the loop, nation-wide: find → ... → dispo → repeat, with Alex
   approving the few moments that genuinely need a human.

---

## What's actually right about this system (so we stop feeling like it's all failure)

- The **dashboard skeleton is real and end-to-end** — six operator screens (Command
  Center, Pipeline, Deal page, Queue, Deals, Buyers), all backed by live Airtable data,
  **no stubs or fake data**.
- **Intake runs daily and is market-driven** — add a ZIP, it gets worked.
- The **pricing math is sound and now test-locked** (worst-case max offer, the
  input-integrity rule that stops prose from becoming fake numbers).
- The **comp engine produces real recorded sales** and a renovated-cluster ARV.
- The **agent factory-floor view exists** on the home page (Sentinel → Sentry →
  Appraiser → Crier rooms).
- The **texting + reply capture** works and is now reliability-hardened (no message is
  marked "sent" until it's read back; duplicate sends are blocked).

This is a working machine with three screens unplugged — not a failure.

---

## The 3 wires to connect first (this is the gap between the spine and the glass)

Every one of these keeps an **existing screen** and points it at **data that already
exists**. No parallel builds.

1. **Show the Deal File on each deal page.** `Deal_Dossiers` is written today but
   **nothing displays it.** Add a panel on `/pipeline/[id]` that reads the latest dossier
   for that property (verdict, max offer, the conservative math).
2. **Show negotiations / action-items in the Queue.** `Operator_Action_Items` (the cold
   negotiations, e.g. a seller who countered) is written today but **nothing displays
   it.** Point the Queue at it.
3. **Fix the message history.** The deal page reads the *old, lossy* text feed and can
   hide real replies. Point it at the *reliable* feed that the background sync already
   uses.

After those three, add the **offer-readiness checklist** (comps/ARV, rehab, CMA, buyer
ceiling) as a visible gate on the deal page so step 4 can't fire half-blind.

---

## Charter for the next agent (how not to "spin up dust")

- **Read first.** This file, then walk the six screens and the seven loop steps. Confirm
  what runs before proposing anything.
- **Plain English with Alex.** If you must use a code word, define it in the same breath.
- **No parallel builds.** If a thing exists, the existing surface wins and gets rewired —
  you do not start a second version next to it.
- **Wire the spine to the screens.** The data is ahead of the glass. Close that gap
  before adding anything new.
- **The four-data checklist is a hard gate** before an offer: comps/ARV, rehab, CMA,
  buyer ceiling. No full data, no auto-offer.
- **Measure against the goal**, not against internal cleverness: does this move a deal
  faster from *find* to *dispo*, and does it help us *repeat* in the next market? If not,
  it's dust.

---

*Companion artifact: `docs/handoffs/system-map.png` — the one-picture view of this same loop,
color-coded green (runs itself) / yellow (runs but needs data) / red (manual or not
built).*

---

## Rehab method (operator-authored 2026-06-13, spine recZ6tBZRmfFOLwqo)

This is doctrine. Read it before touching any rehab number or any offer-readiness gate.

### The problem the method solves

InvestorBase, PropStream, ATTOM, Zillow, Redfin: **none of them contain a rehab cost.**
A rehab number lives in the contractor's head after he walks the property. No dataset
has it. So pretending we can compute one to the dollar from listing photos alone is a
lie, and that lie has produced the system's loudest failures — $25,769 on a renovated
turnkey rental, fabricated single numbers on records nobody walked. Stop pretending.

### The method, in three stages

1. **Photos NARROW it.** Listing photos + Street View tell us the *band* — light /
   medium / heavy. They cannot tell us $25,769; reporting that precision is dishonest.
   Honest rehab output at this stage is a **band**, e.g. "Light: $15-30k."
2. **DD answers PIN it.** The DD volley already asks the right questions in text #2:
   *"Rough ages on roof, HVAC, water heater, electrical, and plumbing? Any known
   foundation issues, active leaks, or sewer problems?"* The agent's answers collapse
   the band — original 1929 electrical pulls the band up, post-1980 updates pull it
   down. **The structured content of the answer must persist and adjust the rehab
   number** — not just "DD item: answered: yes."
3. **Walkthrough RESOLVES it.** If band is still wide after DD, schedule a walkthrough
   before contract. Contract-grade precision belongs at the bottom of the funnel, on
   the handful of records where it pays — not at the cold top on 2,500.

### Two gates this method puts on offer-readiness

- **No autonomous send on a record with zero DD answers parsed.** The first agent text
  is the door-opener — a conversational opener that is **VALUE-anchored** (ARV `$/sqft`
  × sqft × buy-box − rehab − fee) **or it HOLDS** for review; it is **never** a fraction
  of the seller's list price (the 65%-of-list rule was retired 2026-06-28 after the
  Blackmoor $84.5k over-offer — see INVARIANTS §2). A *committed* offer requires the
  DD-rehab loop has been at least begun — text 2 sent, an answer parsed.
- **No contract-stage offer (above the door-opener) without a rehab band narrowed by
  DD or a walkthrough.** The vision number alone does not authorize a contract price.

### Operator-facing rehab display

Bands, not phantom precision. "Light $18-28k" beats "$25,769" every time. The deal page
should render the band + the source (photos / photos+DD / walkthrough), so the
operator instantly sees how much the number is worth.

### The four-data checklist (carrying the existing doctrine)

The hard gate before any autonomous offer is unchanged: **comps/ARV, rehab, CMA, buyer
ceiling.** Rehab in that list now means *rehab band whose width is acceptable for the
stage* — not a single fabricated number. A band wider than ±25% at contract stage is
the same as no rehab data and must HOLD.

