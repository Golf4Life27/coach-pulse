# Dispo Runbook — from signed contract to collected fee

**Status:** operative. **Owner:** Alex Balog. **Installed:** 2026-08-28 (build queue item ①, Option 3 ruling).
One page. Follow it by hand today; the automated version gets built only after
this has closed a deal manually. A contract that skips step 0 does not exist.

---

## Step 0 — The gate (BEFORE any contract is signed)

No purchase agreement is drafted, sent, or signed unless all four boxes pass
on **current** data (`lib/offer-readiness.ts` — the operator's four-point
checklist), or Alex overrides in writing naming the failing items:

1. **Comps / ARV** — a real resale value from verified comps (comp-level
   scrutiny per pricing-doctrine standard 5 — stored fields are inputs, not
   verification).
2. **Rehab estimate** — vision read ≥ 60 confidence, walkthrough, or
   operator-inspected scope. Exterior-only guesses don't pass.
3. **CMA** — Alex's own market read, captured in the Deal File.
4. **Buyer ceiling** — what cash buyers in that area actually pay
   (InvestorBase median in disclosure states; ARV × sourced buy-box discount
   in non-disclosure states; HOLD when no sourced number exists).

The contract price must sit **under** the buyer ceiling with room for the
assignment fee. If it doesn't, the deal is renegotiated or walked — never
papered "to lock it up." (The four 2026 spring contracts that died at
assignment all violated exactly this line.)

## Step 1 — Pick the buyers (same day the contract is signed)

From the Buyers table (`tbl4Rr07vq0mTftZB`) + InvestorBase for the deal's
ZIPs: filter to buyers matching **ZIP (or adjacent), price band, property
type, rehab tolerance**. Target 10–25 names. Fewer than 5 matches = the
dispo risk is real; say so out loud before the inspection window burns.

## Step 2 — One-page deal sheet

One page, made in under an hour: address · beds/baths/sqft · photos or
listing link · **ARV with its comp basis named** · rehab estimate with source
· **assignment price** (contract + fee) · EMD terms · inspection window
· access instructions. No hype adjectives — buyers who see real comps come
back for the next deal.

## Step 3 — The blast

Text (Quo, from the outreach line) + email (Gmail) to the matched buyers.
Three sentences: what it is, the number, the deadline. Every send logged on
the deal record. Replies collected into one list on the Deal record —
highest verified offer wins, backup named second.

## Step 4 — Assignment paperwork

Assignment-of-contract through **DocuSign** (Path A / JWT once provisioned;
manual DocuSign until then): assignor AKB Solutions LLC, assignee = winning
buyer, fee stated plainly, buyer's EMD (non-refundable to AKB on their
inspection lapse) replaces ours. Title company gets the assignment + both
contracts the same day. Alex signs everything personally (Type 2B — forever).

## Step 5 — Close and record

Track title's checklist to the wire. The day the fee lands: record the
revenue on the Spine (deal, fee, buyer, days from contract to close), and
write down which step of this runbook was slowest — that's the next build.

---

**Failure rules:** No matched buyers by 48h before inspection expires →
renegotiate price down or terminate inside the window; never let EMD go
hard on a deal with no buyer. A buyer retrade after acceptance → move to
the named backup, no re-blast. Nothing in this runbook overrides the
approval gates: every outbound message still goes out operator-approved.
