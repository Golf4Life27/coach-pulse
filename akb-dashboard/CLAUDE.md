@AGENTS.md

# Load the spine first — every session, before acting

These are the as-built truth and the hard rules. Read them before touching anything:

1. **`docs/INVARIANTS.md`** — the hard rules (geographic exclusions IL/MO/SC/NC/OK/ND, sticky offers, pessimistic rehab bounds, operator gates, the Firecrawl spend brake). Never break one; if a change appears to require it, stop and escalate to the operator.
2. **`docs/handoffs/AS_BUILT.md`** — entry points (routes/crons), data flow, where state lives (Airtable / Vercel KV), what is gated dark (`H2_OUTREACH_HARD_DISABLE` et al.), and the honest known-broken/unverified list.
3. **`docs/handoffs/SYSTEM_HANDOFF.md`** — the operator narrative + charter.

To eyeball the gate + pricing spine without secrets: `npm run dry-run-trace`.

> Note: `AGENTS.md` (imported above) says **Hobby / daily-cron cap** — that is **STALE**. Production is Vercel **Pro** (sub-daily crons are live in `vercel.json`; see AS_BUILT §0). Don't architect around a daily-cron limit that no longer applies.
