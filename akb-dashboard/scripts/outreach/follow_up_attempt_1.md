---
id: follow_up_attempt_1
status: DRAFT
approval_required: alex
purpose: First parked-on-silence follow-up — fires ~30 days after initial Texted send when the agent has gone silent. Stored OfferPrice; movement-implying tone, NEVER a lower number (offer discipline). A6 scaffolding placeholder — body copy needs Alex draft.
direction: outbound_sms
sender: openphone_quo
created: 2026-06-14
maverick_ruling: rebuild_stale_deal_handling_2026-06-14
principles_applied:
  - 65_rule
  - offer_discipline
  - non_responses_must_be_free
fires_at:
  days_since_last_send: 30
gates_at_send_time:
  - firecrawl_liveness_check (single cheap probe right before this text; if listing not still active, dispose instead of send)
  - list_price_drift_check
  - quiet_hours_floor (8–20 property-local; non-disableable)
---

# follow_up_attempt_1

## Variables

- `{first_name}` — Listing agent first name
- `{offer_amount}` — Stored OfferPrice from original outreach
- `{address}` — Property street address

## Body

```
[ALEX DRAFT PENDING — first 30-day silence follow-up referencing stored OfferPrice. Movement-implying without lowering the number. ~1 sentence, conversational, ends with a single soft ask ("still on the table?").]
```

## Drift behavior

If List_Price has dropped >10% since outreach, this template is REPLACED by `follow_up_drift_down.md` at send time. If List_Price has risen >10%, send is held and the record routes to Manual Review with banner "PRICE DRIFT UP — seller got aggressive, review before sending."

## Status transitions

- On a successful send: Outreach_Status → Parked (explicit operator-visible state for the cold-loop cohort), Last_Outbound_At + Last_Outreach_Date stamped, follow_up_count incremented to 1.
- On a Firecrawl-inactive verdict (listing no longer live): no send fires; Pipeline_Stage → dead, Outreach_Status → Dead.

## Notes

Placeholder — body copy is Alex's to draft. Engine logic, liveness check, and gating apply regardless.
