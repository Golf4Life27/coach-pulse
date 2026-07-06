---
name: pricing-doctrine
description: Price a deal and derive an opener exactly per AKB doctrine — the value-anchored formula is the ONLY producer of numbers, the two-lane MAO sits beneath it as the negotiation ceiling, and every guard HOLDs instead of improvising. Use whenever a price is about to be produced, written, or queued — "price this deal", "what's my offer", "derive the opener", "underwrite this", any re-pricing sweep, and before ANY pricing number reaches a record field, a draft, or a send queue. Fires with extra force on re-pricing after a doctrine change and on any request to "just cap it" or "use a percentage of list".
---

# Pricing Doctrine — AKB

Every pricing disaster this system has had was a constant wearing a formula's clothes: 0.65 × list texted $84.5k at a ~$40k house (Blackmoor, 2026-06-28), and a "defensive cap" silently substituted ~85%-of-list for the derived number on 43 records (capped_to_list, ruled 2026-07-06). The doctrine that survived both is short: valuation prices the asset; rails refuse; nothing improvises.

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

## The output

A priced record carries: the derived opener (or the HOLD reason), both MAO lanes with the binding one named, the pricing_mode, and the inputs it was derived from — so any session can recompute it cold. A HOLD carries the one-sentence reason and the surface route (operator review / Type 2C).

## The honest limits

- **This skill enforces doctrine; it cannot set it.** Changing pricing doctrine is an operator ruling recorded as a Spine `principle_amendment` superseding the prior rule — never an in-thread agreement, never a code comment.
- Constants drift; this file deliberately holds none. If SYSTEM_FACTS §9 and a cited module disagree, that conflict is a HOLD-and-surface, not a judgment call (SYSTEM_FACTS wins every conflict, but the disagreement itself must be reported).
- Unusual deals — land, off-market, seller-finance, multi-parcel — escalate to the operator. The formula prices standard residential wholesale; forcing it onto anything else produces confident nonsense.
- A formula cannot see a lying input (the Tiger Flowers 2× sqft lesson). Data armor lives upstream at intake; this skill's recompute standard catches drift, not deception.

---
*v1.0 · 2026-07-06 · Input 0: operator ruling recmy2Vwp1wMA1Vs8 (capped_to_list demoted to ceiling tripwire; formula is sole producer). Registry: recOu0ekD2PXkKedx. Supersede only via a logged Spine build_event referencing this version — never a silent edit.*
