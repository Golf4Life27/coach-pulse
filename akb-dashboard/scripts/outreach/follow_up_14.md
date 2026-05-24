---
id: follow_up_14
status: DRAFT
approval_required: alex
purpose: Day 14 follow-up — final attempt before auto-dead. Uses stored OfferPrice. A6 scaffolding placeholder.
direction: outbound_sms
sender: openphone_quo
created: 2026-05-13
principles_applied:
  - 65_rule
  - offer_discipline
fires_at:
  days_since_send: 14
gates_at_send_time:
  - list_price_drift_check
auto_dead_if_no_reply_after_days: 14
---

# follow_up_14

## Variables

- `{first_name}` — Listing agent first name
- `{offer_amount}` — Stored OfferPrice from original outreach
- `{address}` — Property street address

## Body

```
[ALEX DRAFT PENDING — Day 14 final attempt. Soft close framing; offer still on the table; this is the last touch from automation.]
```

## Drift behavior

If List_Price has dropped >10% since outreach, this template is REPLACED by `follow_up_drift_down.md` at send time. If List_Price has risen >10%, send is held and the record routes to Manual Review.

## After this fires

If no reply lands within 14 days after this template sends, record is auto-marked Pipeline_Stage=dead, Outreach_Status=Dead. Record exits D3 cadence and won't re-enter without manual intervention.

## Notes

Placeholder — body copy is Alex's to draft.
