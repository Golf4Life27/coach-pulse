# GO-LIVE RUNBOOK — first live texts, safely

> **Date:** 2026-06-28. Plain-English ignition sequence to take the system from
> dark → first metered live send. Every flag verified against code this session.
> **Order matters** — this is safety-first: generate + validate real priced
> records with sends OFF, *then* send a tiny metered batch.
>
> **Who does what:** the operator sets env vars in Vercel + does the external
> compliance work; the code already enforces every safety rail below.

---

## The reassuring headline

The hard-disable block warns that re-enabling requires "fixing the phantom
safety gates (>85%-of-list block + outreach-safety-check reading null fields)."
**Those were fixed on 2026-06-05 (incident day) and are ENFORCED on the live
send path** — verified this session:
- `checkFirstOutreachHydration` — a first outreach is BLOCKED unless the record
  has real `ARV_Validated_At` AND `Rehab_Estimated_At` (the 6 bad sends were
  first-touch records with neither). `[h2-outreach/route.ts:609-625 — blocks]`
- `checkOfferOverList` — the send is BLOCKED if the offer in the message body
  exceeds **85% of List_Price**. `[h2-outreach/route.ts:627-640 — blocks]`

So going live is a **careful metered ignition**, not a leap in the dark. The
math is also now value-anchored-or-HOLD (PR #46).

---

## Prerequisites (ALL true before any live send)

1. **PR #46 merged + deployed** — correct math in production. *(operator)*
2. **Pre-send gates present** — ✅ verified in code this session (above).
3. **10DLC / TCPA compliance live** — registered campaign (you have an EIN ✅),
   a sending number, and a consent/multi-channel posture. **This is the real
   timeline gate** (carrier approval takes days–weeks). See business-plan §7a.
4. **API balances checked** — intake spends Firecrawl + RentCast per call.
   Confirm there's balance before turning intake up. *(today's balances unknown
   — AS_BUILT §7.)*

---

## The ignition sequence

### Phase A — math + safety live (NO sends)
1. **Merge PR #46 → deploy.** Math correct in prod; the hard-disable keeps sends
   off regardless.

### Phase B — generate fresh, priced records (still NO sends)
2. `MAVERICK_CRON_ENABLED = true` — let the crons run (else they 503).
3. `CRAWLER_INTAKE_LIVE = true` — intake writes real records to Airtable.
4. `CRAWLER_AUTOSEED_LIVE = true` — ZIPs get renovated $/sqft → openers compute.
5. **Leave `CRAWLER_AUTO_PROMOTE_LIVE` UNSET** — records land in **Review**, not
   auto-proceed. (Safe: nothing advances itself.)
   - *Sends are still hard-disabled this whole phase.* You're just filling the
     pipe with correctly-priced records.
6. **Run `/api/admin/opener-dry-run`** on the fresh cohort → read the
   **`hold_headline`** (the instrument we built): how much SENDs vs HOLDs, and
   the split (auto-seed / creative / you). **This is your real-data gut-check
   before a single text fires.** Confirm the openers look sane.

### Phase C — compliance (parallel; the real wait)
7. Stand up the **10DLC campaign + consent path**. Nothing below sends until
   this is real. Don't skip it — TCPA exposure is $500–1,500/text.

### Phase D — turn on reply capture (BEFORE sending)
8. **Inbound capture** per the watched-first protocol (AS_BUILT §8a): re-point
   Quo's webhook, then `INBOUND_CAPTURE_LIVE = true`. *Never send before you can
   catch the replies.*

### Phase E — first metered live send
9. **Set the send-cap TINY** (fail-closed — unset = 0 sends):
   - `H2_COVERED_ZIPS = 48205` ← **one** ZIP you validated in step 6
   - `H2_MAX_SENDS_PER_RUN = 5`
   - `H2_MAX_SENDS_PER_ZIP = 2`
10. `H2_OUTREACH_LIVE = true` — arms live (else dry even with `?dry_run=false`).
11. **Lift the kill:** `H2_OUTREACH_HARD_DISABLE = false` ← the literal string
    `false`. (Anything else = still disabled.)
    - → the next `h2-outreach` cron sends **up to 5 texts in that one ZIP**, each
      passing the hydration gate, the 85%-of-list gate, the never-over-list cap,
      and the send-cap.
12. **WATCH** the audit log + your phone. Work the replies by hand (this is your
    job — negotiate, decide). Measure how long a deal actually takes you.

### Phase F — dial up
13. As it proves out: add ZIPs to `H2_COVERED_ZIPS`, raise the caps, then turn on
    `FOLLOWUP_SEND_ENABLED = true` for follow-ups. Turn the dial; don't fling it.

---

## Safety rails that stay ON the whole time
- **Two pre-send hard gates** — hydration + 85%-of-list (block, not warn).
- **Send-cap** — fail-closed; empty `H2_COVERED_ZIPS` = zero sends.
- **Never-over-list cap** (90% of list) in the pricer; **Review** park for
  un-promoted records; positive-confirmation polling before stamping "Texted."

## Honest watch-outs
- **85% gate vs 90% cap:** the send gate (85% of list) is *stricter* than the
  opener cap (90%). A rare deep-discount deal (ARV ≫ list, opener near 90%) will
  be **blocked at send** and routed to review. That's safe (conservative), not a
  bug — just don't be surprised by a few `economics_block` entries.
- **API spend:** watch Firecrawl/RentCast burn once intake is live (AS_BUILT §7
  flags a KV-outage fail-open on the Firecrawl breaker — verify KV health).
- **The number that matters:** your real per-deal time, measured at step 12. It
  sets the whole revenue ceiling (business-plan §7b).
