---
id: follow_up_7
status: DRAFT
approval_required: alex
purpose: Day 7 follow-up after initial outreach with no agent reply (and no follow_up_3 reply). Uses stored OfferPrice. A6 scaffolding placeholder.
direction: outbound_sms
sender: openphone_quo
created: 2026-05-13
principles_applied:
  - 65_rule
  - offer_discipline
fires_at:
  days_since_send: 7
gates_at_send_time:
  - list_price_drift_check
---

# follow_up_7

## Variables

- `{first_name}` — Listing agent first name
- `{offer_amount}` — Stored OfferPrice from original outreach
- `{address}` — Property street address

## Body

```
[ALEX DRAFT PENDING — Day 7 follow-up. Slightly more direct than Day 3; same offer amount; should hint at moving on.]
```

## Drift behavior

If List_Price has dropped >10% since outreach, this template is REPLACED by `follow_up_drift_down.md` at send time. If List_Price has risen >10%, send is held and the record routes to Manual Review.

## Notes

Placeholder — body copy is Alex's to draft.
