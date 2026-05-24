---
id: follow_up_positive_reply
status: DRAFT
approval_required: alex
purpose: Pre-drafted reply to surface in the Action Queue when a status_check probe gets an affirmative ("yes, still available") response. Re-introduces the stored OfferPrice as the next move, leaning on quick-close language.
direction: outbound_sms
sender: openphone_quo
created: 2026-05-13
principles_applied:
  - 65_rule
  - offer_discipline
fires_after:
  - status_check (positive reply)
---

# follow_up_positive_reply

## Variables

- `{offer_amount}` — Stored OfferPrice from the original outreach (NEVER recomputed)

## Body

```
Great. Cash offer at ${offer_amount} with quick close. Open to that range?
```

## When this drafts

The D3 cadence engine drafts this into the Action Queue when an inbound reply to a status_check probe is classified as positive (affirmative confirmation that the listing is still available). The draft is Alex-approval-gated; the engine does not auto-fire it.

## Why this is the next move

Status_check confirmed availability without surfacing AKB's number. Now that the door is open, the offer goes in front of the seller's agent at the same number it would have at intake (the stored OfferPrice). "Cash offer with quick close" frames the value proposition independent of the dollar amount.

## Notes

This is a re-introduction, not a first-touch. Records reaching this state were already Texted at some prior point — the assumption is the agent doesn't remember the first message or the first offer didn't get formally placed. Stored OfferPrice keeps the number consistent if/when the agent looks back.
