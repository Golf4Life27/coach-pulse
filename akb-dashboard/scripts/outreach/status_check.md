---
id: status_check
status: DRAFT
approval_required: alex
purpose: One-shot probe to confirm a listing is still available before re-engaging on a stale Texted record. Used by D3 cadence for records where Last_Verified is stale (>72hr) or Live_Status can't be confirmed Active from cached data.
direction: outbound_sms
sender: openphone_quo
created: 2026-05-13
principles_applied:
  - 65_rule
auto_dead_window_days: 3
---

# status_check

## Variables

- `{first_name}` — Listing agent first name (Agent_Name first token, falls back to "there" if missing)
- `{address}` — Property street address

## Body

```
Hi {first_name}, is your listing at {address} still available?
```

## Routing on reply

- Positive ("yes," "still active," "still on the market") → Action Queue with pre-drafted positive-reply follow-up (see `follow_up_positive_reply.md`)
- Negative ("sold," "off-market," "pending," "withdrawn") → Pipeline_Stage=dead + Live_Status=Off Market via standard scrub apply path
- Wrong number / different agent → D3_Manual_Fix_Queue (Issue_Category=wrong_number_per_status_check or agent_changed)
- No reply within `auto_dead_window_days` (3) → Pipeline_Stage=dead, Outreach_Status=Dead

## Notes

This is a SHORT probe — single sentence, no offer mentioned, no urgency framing. Purpose is purely to refresh availability state. The stored OfferPrice doesn't enter the wire here per the 65% rule + offer-discipline principles.
