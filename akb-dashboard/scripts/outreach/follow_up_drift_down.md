---
id: follow_up_drift_down
status: DRAFT
approval_required: alex
purpose: Follow-up template fired when current List_Price has dropped >10% since the original outreach was sent, on a record that is otherwise in standard follow_up_3/7/14 cadence. References the stored OfferPrice — the seller's price drop is leverage for AKB's existing number, not justification to lower it.
direction: outbound_sms
sender: openphone_quo
created: 2026-05-13
principles_applied:
  - offer_discipline
drift_threshold_pct: 10
fires_in_place_of:
  - follow_up_3
  - follow_up_7
  - follow_up_14
---

# follow_up_drift_down

## Variables

- `{first_name}` — Listing agent first name (Agent_Name first token, falls back to "there")
- `{offer_amount}` — Stored OfferPrice from the original outreach (NEVER recomputed from current List_Price)
- `{address}` — Property street address

## Body

```
Hey {first_name}, my ${offer_amount} offer on {address} still stands. With the new price, is the seller ready to take it?
```

## When this fires

D3 cadence engine selects this template at send-time when:

1. Record is in standard follow_up_3/7/14 send window (days_since_send matches schedule)
2. Current List_Price has dropped > drift_threshold_pct (10%) vs the List_Price captured at outreach time
3. No negotiation reply has landed yet (else cadence stops and orchestrator Gate 3 picks up)

## Why the offer number doesn't move

Per the Offer Discipline principle (Spine recxxNF0U59MxYUqu): tracking the market downward is a wholesaler-tell that costs deals. The seller's price drop is signal that our number is closer to in-range, not signal that we should chase further. Stored OfferPrice is sticky by design.

## Notes

The template explicitly references "the new price" — calling the seller's price drop out without lowering the offer. The seller hears: AKB sees the price drop AND AKB's number hasn't moved.
