---
name: pricing-doctrine
description: Price a deal per AKB two-stage doctrine (operator ruling 2026-08-30) — first-contact cash openers are 62% × list, phrased soft (list_anchor_soft_v1); from the FIRST REPLY onward the value-anchored formula is the only producer, the two-lane MAO is the negotiation ceiling, and every guard HOLDs instead of improvising. Use whenever a price is about to be produced, written, or queued — "price this deal", "what's my offer", "derive the opener", "underwrite this", any re-pricing sweep, and before ANY pricing number reaches a record field, a draft, or a send queue. Fires with extra force on firming/revising a number in a live thread, on re-pricing after a doctrine change, and on any request to firm up a number without comp-level verification.
---

# Pricing Doctrine — AKB

Every pricing disaster this system has had was a constant wearing a formula's clothes: 0.65 × list texted $84.5k at a ~$40k house (Blackmoor, 2026-06-28), and a "defensive cap" silently substituted ~85%-of-list for the derived number on 43 records (capped_to_list, ruled 2026-07-06). The doctrine that survived both is short: valuation prices the asset; rails refuse; nothing improvises.

## 2026-08-30 operator amendment — two-stage doctrine (Spine rec8eZG5hH16FFyF2)

The operator split pricing into two stages. Everything below this section applies
at the NEGOTIATION and CONTRACT stages; first-contact openers moved to a simpler rule:

- **Opener stage (first contact only):** cash openers are **62% × list price**,
  phrased SOFT — a conversation-starter explicitly conditioned on scope
  ("depending on condition, somewhere around $X"), never a bare committed number.
  `pricing_mode: list_anchor_soft_v1` is a producing mode for openers ONLY, by
  operator ruling. This deliberately reverses the "no constant ratio" rule at the
  opener stage: the number's job is volume and response rate, and the soft
  phrasing is what keeps the sticky-offer rule survivable (the anchor that sticks
  is a conditional ballpark). Blackmoor-class protection at this stage is the
  soft phrasing plus the negotiation-stage verification below — not opener math.
- **Negotiation stage (any reply onward):** unchanged and now load-bearing. The
  moment a thread goes live, standard 5 applies in full — comp-level
  verification, independently recomputed ceiling, rehab scope via DD — BEFORE any
  number is firmed, revised, or reaffirmed. The opener's 62% is walked DOWN here
  when evidence demands it (the 2026-08-28 backtest says that's ~6 of 10).
- **Contract stage:** unchanged — the 4-point offer-readiness gate
  (`lib/offer-readiness.ts`) or written operator override; contract price under
  the buyer ceiling with fee room.
- **Standard 2 (ratio detector) is rescoped** to negotiation- and contract-stage
  numbers: openers in `list_anchor_soft_v1` are a constant ratio by design and
  do not trip it. A constant ratio appearing in a FIRMED number still trips it.
- **A/B escalation:** sellers anchored to a fantasy number get the value-anchored
  derivation (the method below) as the counter-path.
- **Creative/terms lane:** backup only, after a cash decline; terms price must
  exceed recorded debt; never first touch. (Roselawn, recncTnM2UzSz1luw.)

## The one rule

**No number leaves the building that isn't derived from the property. A constant ratio of any input is a violation, not a price.** The moment a price stops tracing back through the formula to the property's own facts (sqft, comps, rent, rehab), it stops being a price — refuse and surface, never send.

## When it triggers

- Any opener derivation — autonomous send lane, manual ask, or re-pricing sweep.
- Any write of a pricing number to a record field, reply draft, or send queue.
- Any proposal to clamp, cap, floor, or "adjust" a derived number — that is a tripwire event, not a pricing step.

## The method

1. **Derive value from the property.** ARV = ZIP renovated $/sqft × subject sqft (comps-anchored; `lib/pricing/mao-flip.ts` has structurally NO list-price input). No trusted ARV basis → **HOLD** (`hold_no_value_basis`) — never back-fill from list.
2. **Run the two-lane MAO beneath it — the negotiation ceiling.** Flip lane (the 70% rule) and landlord lane (cap-rate on rent minus taxes), both → `Your_MAO_V21`. Every constant in both lanes — fee floors by deal type, cap rates by state, rule and closing percentages — is READ from SYSTEM_FACTS §9 and the cited modules at run time. This file deliberately contains none of them.
3. **Derive the opener:** value-anchored — ARV $/sqft × sqft × buy-box − rehab − fee — or **HOLD for review**. Rehab uses the pessimistic band (INVARIANTS §2); heavy scope caps the ARV tier.
4. **Ceiling tripwire (ruling recmy2Vwp1wMA1Vs8, Option B):** if the derived opener exceeds the ceiling figure, the record **HOLDs and surfaces as Type 2C**. The ceiling never produces, clamps, or modifies a number — silent clamp-and-send was the bug, and an above-ceiling event means either a genuinely underpriced deal or broken inputs; both belong to the operator. (If the pending code trace shows the stored comparison figure is MAO rather than list, the ceiling is implemented as a spread-guard — same tripwire semantics, unchanged rule.)
5. **Missing or low-confidence inputs → HOLD.** If no confidence threshold is recorded in SYSTEM_FACTS for an input class, that absence is itself a HOLD-and-surface — this skill never mints a threshold to keep moving.
6. **Pricing states:** a price-drop on a known record is a **re-engagement**, never a first contact (INV-030). First-contact openers and re-engagement drafts inherit only delivery-stamped sent numbers — never a stored field that hasn't been recomputed (standard 1).

## The standards

1. **Recompute before queueing.** Before any opener is queued: recompute from the formula and match the Airtable field within tolerance — mismatch → HOLD and surface. Fields are history, not authority.
2. **Ratio detector.** If opener ÷ list OR opener ÷ MAO sits within ±1% of a constant across the last 3+ priced records, **HOLD ALL pricing** and surface as Type 2C. This is exactly how capped_to_list was caught — the catch is now doctrine.
3. **Mode taxonomy.** Every priced record carries a `pricing_mode` from the post-ruling taxonomy; producing modes are value-anchored only; an unknown mode is itself a HOLD. `capped_to_list` is retired as a producer — it survives only as tripwire history.
4. **Refuse and surface.** Violations are never silently auto-corrected. A wrong number is evidence; correcting it quietly destroys the evidence and re-arms the gun.
5. **Comp-level verification before every send (operator ruling 2026-08-26, Spine recZy1WuARMOq4MzJ).** Before ANY message that states, revises, reaffirms, or is premised on a price reaches a seller or agent, the sending session must — in that same session — open the record's comp array (or pull fresh comps), scrutinize the comps themselves (recency, distance, size, cluster split, bulk/portfolio smell), independently recompute the ceiling from them, and record which comps carry the number. A stored ARV/MAO field is an input to verify, never verification. Comps that don't support the stored number → HOLD and surface. This extends standard 1 (recompute-before-queue) down to the evidence layer and applies to every send, not just opener queueing — the 12717 Indiana $16,500 reaffirmation (2026-08-26) is the incident that made it a rule.

## The output

A priced record carries: the derived opener (or the HOLD reason), both MAO lanes with the binding one named, the pricing_mode, and the inputs it was derived from — so any session can recompute it cold. A HOLD carries the one-sentence reason and the surface route (operator review / Type 2C).

## The honest limits

- **This skill enforces doctrine; it cannot set it.** Changing pricing doctrine is an operator ruling recorded as a Spine `principle_amendment` superseding the prior rule — never an in-thread agreement, never a code comment.
- Constants drift; this file deliberately holds none. If SYSTEM_FACTS §9 and a cited module disagree, that conflict is a HOLD-and-surface, not a judgment call (SYSTEM_FACTS wins every conflict, but the disagreement itself must be reported).
- Unusual deals — land, off-market, seller-finance, multi-parcel — escalate to the operator. The formula prices standard residential wholesale; forcing it onto anything else produces confident nonsense.
- A formula cannot see a lying input (the Tiger Flowers 2× sqft lesson). Data armor lives upstream at intake; this skill's recompute standard catches drift, not deception.

---
*v1.1 · 2026-08-30 · Input 0: operator ruling recmy2Vwp1wMA1Vs8 (capped_to_list demoted to ceiling tripwire; formula is sole producer at negotiation/contract stages). Amended by operator ruling rec8eZG5hH16FFyF2 (two-stage doctrine: list_anchor_soft_v1 openers, verification concentrated at negotiation/contract). Registry: recOu0ekD2PXkKedx. Supersede only via a logged Spine build_event referencing this version — never a silent edit.*
