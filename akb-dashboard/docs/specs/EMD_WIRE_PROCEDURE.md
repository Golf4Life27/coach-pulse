# EMD wire procedure

Phase 5.5 deliverable. Wire-fraud-warning discipline per Scribe Phase 5.

## Standing rule

EMD (Earnest Money Deposit) is wired to the title company within
3 business days of binding effective date. Wire instructions come
from the title company, not the seller's agent — **always confirm
wire details by voice with the title company before sending.**

## Standard playbook per deal

1. **DocuSign envelope signed by both sides** → Scribe surfaces the
   bound contract via `external_signals.docusign.envelopes` (Phase 5
   integration).

2. **Note the EMD amount + due-by date** in the Listing record's
   notes field, formatted: `EMD $<amount> to <title co> by <YYYY-MM-DD>`.

3. **Get wire instructions from the title company directly:**
   - Call the title company's office line (do NOT trust an emailed
     PDF without voice verification — wire fraud attacks fake-PDF
     instructions to a fraudulent account).
   - Confirm: routing number, account number, beneficiary name,
     beneficiary bank, the title company's reference number for this
     specific deal.
   - Capture in your bank's wire UI; double-check digits before
     submitting.

4. **Send the wire from operator-controlled bank account.** Capture
   the wire confirmation number.

5. **Notify the title company within 1 hour of send** with the
   confirmation number so they can match the inbound.

6. **Update the listing record:**
   - Add note: `EMD wired $<amount> to <title co> on <YYYY-MM-DD>,
     wire conf <number>`
   - Closing status remains as it was (Pending / Under Contract / etc.)
     until close.

## Red flags that block the wire

Pulse + Sentinel surface these via the wire_fraud_red_flag intent +
the red_flag categories on inbound triage:

- **request_wire_transfer** before signed contract → DO NOT WIRE.
- **deceptive_identity** — wire instructions from a "title company"
  that doesn't match the one on the DocuSign envelope → DO NOT WIRE.
- **off_platform_redirect** — request to "move communication" to
  WhatsApp/Telegram/Signal for wire details → DO NOT WIRE.
- **request_routing_number** disguised as a verification request →
  this is them trying to verify YOU before defrauding you. Do not
  share.
- **fake_urgency** — "wire today or seller walks" → real title
  companies don't pressure same-day. Slow down.

If any of these fire, **stop and confirm by voice with the title
company on the published office line** (not a number from the email).

## Historical fraud patterns (operator-reviewed)

This section is empty today. As fraud attempts surface, log them
here so future Sentinel + Pulse detectors can be tuned against the
real adversarial surface AKB encounters.
