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
