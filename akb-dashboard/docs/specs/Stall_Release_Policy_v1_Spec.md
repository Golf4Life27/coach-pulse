# Stall-Release Policy v1 — DESIGN, not shipped

Status: **DESIGN** — pending operator review (Maverick) and the 48h watch outcome.
Spine: recfcAUA0cX202utp.
Author: ops (Claude Code).
Last revised: 2026-06-11.

> Ruling under review. No code lands until the operator signs off and the 48h h2-outreach watch completes. This doc records the design so Maverick can adjudicate the shape before the implementation PR.

## The problem the policy solves

The phone-deduped prior-contact rule (see `lib/h2-outreach.ts` — first-touch is normalized-phone-unique) silences **sibling listings** under the same agent thread. Today's data: ~20 of 27 stale records are siblings, waiting behind an active or rejected agent thread. The h2 selector returns them but the route classifies them `prior_contact_stall` and skips them tick after tick.

That rule is correct for **active** negotiation — we will not double-tap an agent currently mid-thread on listing A with a cold opener on listing B. But the rule is too coarse for **terminal** threads (rejection / Tier 0 auto-close / dead). When the agent relationship is closed on listing A, the sibling listing B is just frozen forever despite being a legitimate fresh opener.

## Proposed rule

```
For each (agent_phone, listing) pair:
  If the agent thread for the AGENT is TERMINAL on its primary listing
    (Outreach_Status ∈ {Dead, Walked, Terminated, No Response} OR
     Tier 0 auto-close fired OR
     agent declined verbally):
    Eligible to send the SIBLING opener after a 24h cooldown
    measured from the terminal-transition timestamp.
  Else (agent thread is ACTIVE on any listing —
    Outreach_Status ∈ {Texted, Response Received, Negotiating, Offer Accepted}):
    Stall the sibling. Today's behavior, unchanged.
```

### Second-listing-aware opener

The sibling send is **not** the standard first-touch opener. The agent already knows us. The opener acknowledges that:

> "Hey [Name] — we spoke about [Address A]. Also interested in [Address B] if that one's still open. Same buy box."

Concrete shape goes through `lib/h2-outreach.ts` planner as a new `route: "sibling_release"`. Same downstream rails as `first_touch` (Quo dispatch, positive-confirmation poll, idempotency claim) — only the planner output and the opener template differ.

### Cooldown rationale

24h after the agent's terminal transition. Not zero (avoid looking robotic — let the agent process the No on listing A before the ping on listing B). Not 7d (the listing gets stale; we lose the window). 24h is the same window the `outreach-status-reconcile` cron uses to catch up on adjacent state changes, so the cooldown timer aligns with an existing rhythm.

## Active negotiations: keep the stall

If the agent is mid-thread on listing A — any of {`Texted`, `Response Received`, `Negotiating`, `Offer Accepted`} — the sibling stall holds. Cold-tap on listing B during an active back-and-forth on listing A is exactly the noise the rule was built to prevent. No change.

## Data the policy needs

The planner needs three reads per sibling consideration:

1. **Agent's primary-listing terminal state.** Read `Outreach_Status` on the listing this agent first appeared on (or the most-recent listing with a non-empty status). Already in `lib/airtable.getListings()`.
2. **Terminal-transition timestamp.** When did the primary flip terminal? Read `Last_Inbound_At` / `Last_Outbound_At` on the primary as a proxy (good enough to within ~24h, no schema change). If we want exact, we add a `Status_Transition_At` field — out of scope for v1.
3. **Auto-close fingerprint.** If `sendAutoClose` fired on the primary, the Notes line carries the auto-close marker. `lib/auto-close.ts` already writes a stable marker; parser already exists for triage.

All three reads happen from data the h2 selector already has in hand — no new Airtable round trips.

## Invariants the policy will not break

- **No double-tap on an active thread.** Active stall holds verbatim.
- **No bypass of the lineage rules** (buyer-anchored only, 35% lowball floor — recjsLKqETfQ5r6zK). The sibling opener still flows through `openerMaoGuard` with the same lineage checks. A sibling release cannot circumvent the buyer-anchored gate.
- **No bypass of working-hours guard.** First-touch and sibling-release both honor the working-hours gate (TX/MI window).
- **No bypass of idempotency.** Each sibling release gets its own KV claim key keyed on the SIBLING listing's recordId, not the agent phone.
- **Per-agent per-day cap.** Even if an agent has three sibling listings going terminal at once, only ONE sibling release per agent per 24h. Prevents three-card-monte. Implementation: KV key `h2:sibling_release:<agent_phone_e164>:<YYYY-MM-DD>`.

## Backout

Single env flag: `H2_SIBLING_RELEASE_LIVE`. Off by default until the 48h watch closes. On flip, the planner branch unlocks; no schema migrations to roll back.

## Open questions for Maverick

1. **Tier 0 auto-close as a terminal trigger.** The Tier 0 rule (`triage.tier === "tier_0_auto_close"`) was built for the agent who rejected once. Do we count Tier 0 as terminal-on-the-primary for sibling release, or do we wait for a second rejection signal? Recommend: Tier 0 IS terminal — the rule fired because the seller's signal was unambiguous and we already closed the loop with the auto-close message.
2. **"Walked" interpretation.** Some `Walked` statuses are operator-set on records that never had a real terminal — they're operator dispositions, not agent rejections. Should `Walked` count? Recommend: yes — operator disposition is also a terminal signal, just a different source. The sibling opener is still legitimate.
3. **What if the sibling itself is in `Dead`?** Don't release a dead record. Apply the standard never-resurface check (`lib/never-resurface.isNeverResurfaceLoose`) before the sibling send.
4. **Opener template under operator review.** "We spoke about X, also interested in Y" — operator-approved phrasing required before code lands. Draft above is a placeholder for Maverick to amend.

## Sequencing

1. **48h watch ends** (anchor: tomorrow's 16:00 UTC tick + 24h after that = the morning of 2026-06-13).
2. Operator reviews the watch report → either widens the cap, holds at limit=10, or pulls back.
3. Maverick adjudicates this design doc (open questions above).
4. Implementation lands behind `H2_SIBLING_RELEASE_LIVE` off, tests + smoke on a single sibling pair, then flip.
5. Supply-floor signal (already shipped) will name `stalled_behind_agents` as the binding constraint until this lands — so the alert shape already points the operator at the right lever.

## What ships in support BEFORE this policy lands

Already shipped this session (commit pending merge): the **supply-floor signal** in `lib/h2-outreach/supply-floor.ts` emits an info-tier audit alert when the sendable queue depth falls below 10. When the binding constraint is `stalled_behind_agents`, the alert prose names this policy as the unlock — so the doctrine signal is in place even before the implementation lands.
