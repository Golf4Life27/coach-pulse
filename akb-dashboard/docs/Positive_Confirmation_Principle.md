# Design Principle: Positive Confirmation, Not Absence of Error

**For Claude Code — apply this everywhere in the AKB INEVITABLE system.**

## The Principle

**Never interpret "no immediate error" as "success."** Any operation that hands work to an external system (Quo, Gmail, DocuSign, Airtable, Make, RentCast, InvestorBase, anything else) must distinguish between three states:

1. **Confirmed success** — positive proof the operation completed (message delivered, email sent, record written, response received)
2. **Confirmed failure** — explicit error, failed status, rejection
3. **Uncertain** — accepted/queued/202/timeout/no response — **NOT success**

The UI, audit log, and downstream agents must treat #1 and #3 differently. Uncertain ≠ Success.

## Why This Matters

The system has burned us repeatedly on this pattern:

- **H2 Incident (weeks ago):** Make scenarios had `stopOnHttpError: false`. Quo API returned 402 (no credits). Scenario continued, marked records "Texted" in Airtable. 5 records flagged as outreached that never received a message. **Root cause:** absence of error treated as success.

- **BroCard Silent Failure (today, 5/12):** Dashboard sent message to Michelle Batts via BroCard. Likely got 202 from OpenPhone. UI cleared the card. Message never appeared in Quo. **Root cause:** 202 (queued) treated as success.

- **Blueprint API pushes (multiple sessions):** Make blueprints pushed via API set `isActive: false` silently. No error. System "worked" but scenarios were off. **Root cause:** silent state change not surfaced.

- **Scenario B false positives:** Off-market listings still showed as Active because the body-text check ran but failed silently when the page structure changed. **Root cause:** check returned no error, so the previous value was preserved as truth.

Every one of these cost real money or relationship damage. The pattern is identical: **the system assumed silence meant success**.

## The Rules

### Rule 1: Polling Over Trusting

When an external system returns "accepted/queued/in-progress," poll for actual status. Examples:

- **Quo SMS:** After 202, poll `GET /v1/messages/{id}` until status is `sent`/`delivered` or timeout. Auto-clear UI only on positive transitions.
- **Gmail send:** After API returns, verify via `messages.get` that the message ID actually exists in Sent folder.
- **DocuSign:** After send, poll envelope status. "Created" is not "sent."
- **Airtable writes:** After write, read back the record. Confirm the field actually has the expected value (especially for select fields with typecast).

### Rule 2: Persist Uncertainty in UI

When the system is uncertain, the UI persists the state:

- BroCard send button: card stays visible with status until confirmed delivered. Dismiss button is the user's escape hatch.
- Approval queue items: don't disappear after "approve" — only after the resulting action confirms success.
- Loading states must have timeouts that resolve to "still uncertain" not "done."

### Rule 3: Log Three States Distinctly

Audit log in Vercel KV records every action with status: `confirmed_success`, `confirmed_failure`, `uncertain`. Never collapse uncertain into success. Orchestrator's morning brief should surface lingering uncertain states from overnight.

### Rule 4: Agents Don't Advance on Uncertainty

Critical for agent logic:

- Acquisition Agent: don't mark `Outreach_Status = Sent` until Quo confirms delivery. Use intermediate state `Sent_Pending_Confirmation`.
- Negotiation Agent: don't update deal state based on an outbound message until that message is confirmed delivered AND a reply pattern is detected.
- Dispo Agent: don't mark a buyer as "contacted" until the message lands.

Every state transition must be backed by positive confirmation from the system that completed the work.

### Rule 5: Errors Must Surface, Not Swallow

This was the H2 lesson. Equivalent to Make's `stopOnHttpError: true`:

- Every external API call wraps in try/catch
- Catch logs the error to audit log with full context
- Catch surfaces to UI or queue for Alex to see
- Never silently retry without logging
- Never "fail gracefully" by hiding the failure from the human in the loop

## Where To Apply

Implement this principle in (non-exhaustive):

| System | Operation | Confirmation Method |
|---|---|---|
| Quo SMS | Send | Poll `GET /v1/messages/{id}` for `sent`/`delivered` |
| Gmail | Send | Verify message ID via `messages.get` after send |
| Airtable | Write | Read-back the record to confirm field values stuck |
| Airtable | Update select field | Confirm by ID, not name (typecast can silently downgrade) |
| DocuSign | Send envelope | Poll envelope status until `sent`+ |
| RentCast | Comps lookup | Validate response shape; `comps: []` is a flag, not success |
| InvestorBase | Buyer data | Same — empty results need investigation, not silent acceptance |
| Make | Scenario trigger | Webhook should return execution_id; verify execution completed |
| Vercel KV | Write | Read-back critical state writes |
| Anthropic API | Tool calls | Verify tool result structure before passing to next step |

## UI Pattern (Generalizable)

For any action button in the dashboard:

```
state: idle
  → user clicks
state: sending
  → API call returns 2xx
state: confirming (polling for delivery confirmation)
  → polling resolves to success
state: confirmed (auto-clear UI element after 2s)
  → polling resolves to failure
state: failed (keep UI element, show error, manual dismiss)
  → polling times out
state: uncertain (keep UI element, show "Verify in [system]", manual dismiss)
```

Never go from `sending` directly to `idle`. Always pass through `confirmed`, `failed`, or `uncertain`.

## Test Cases

Code should add tests that simulate:
- 2xx response but downstream system never received the work
- Slow downstream system (test timeout handling)
- Explicit failure response
- Network error mid-poll
- Polling endpoint returning 4xx (auth issue)

Each test confirms the UI/agent/audit log responds correctly to that state.

## One-Sentence Summary

**Treat all external systems as untrustworthy until they prove they did what we asked.**

Build that into every send, every write, every fire-and-check call. Surface uncertainty. The bug you're catching today is the same bug we've caught three other times — make this pattern impossible going forward.

— Alex (via Claude)
