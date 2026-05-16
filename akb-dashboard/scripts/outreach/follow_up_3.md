---
id: follow_up_3
status: DRAFT
approval_required: alex
purpose: Day 3 follow-up after initial outreach with no agent reply. Uses stored OfferPrice. A6 scaffolding placeholder — body copy needs Alex draft.
direction: outbound_sms
sender: openphone_quo
created: 2026-05-13
principles_applied:
  - 65_rule
  - offer_discipline
fires_at:
  days_since_send: 3
gates_at_send_time:
  - list_price_drift_check
---

# follow_up_3

## Variables

- `{first_name}` — Listing agent first name
- `{offer_amount}` — Stored OfferPrice from original outreach
- `{address}` — Property street address

## Body

```
[ALEX DRAFT PENDING — Day 3 follow-up referencing stored OfferPrice. Should imply movement without lowering the number.]
```

## Drift behavior

If List_Price has dropped >10% since outreach, this template is REPLACED by `follow_up_drift_down.md` at send time. If List_Price has risen >10%, send is held and the record routes to Manual Review with banner "PRICE DRIFT UP — seller got aggressive, review before sending."

## Notes

Placeholder — body copy is Alex's to draft. Engine logic and gating apply regardless.
