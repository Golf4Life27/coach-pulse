# Creative Lane v1 — Spec for Operator Ruling (2C)

**Status: AWAITING RULING — nothing in this document is built, and nothing will be
built until the operator rules on the questions in §5.**

Drafted 2026-07-11 on the operator's greenlight ("get started") to *spec* the lane.
The instruction was explicit: this is a doctrine ruling before it is a build.

---

## 1. Why this lane exists (the evidence)

The pricer's hold classifier (`lib/pricing/hold-reason.ts`) already isolates a class
it names `cash_no_pencil` / owner `creative_lane`: **the value IS known and cash
simply does not work** — the ZIP's renovated value sits below the asking price, or
rehab eats the buy-box. These were never cash deals; the old 65%-of-list formula
over-offered on them. Today the class has a name and **no consumer**: the records
hold forever.

Production evidence (all from live reads, not memory):

- **817 Regal Ln SW, Atlanta 30331** — ask **$355,000**, seed renovated value
  **$319,090**. Trusted ARV below list → `cash_no_pencil`. This is the record the
  operator personally asked about ("how would this ever get an automated text?").
  Answer today: it never does. The lane in this spec is the only path that ever
  monetizes it.
- **30331 opener dry-run sample** — 3 of 4 holds classified `cash_no_pencil`. The
  same ZIP proves the cash lane works where cash pencils: 3798 King Henry Dr priced
  **$103,500** against a $165k ask (63% of list) and is sendable. The split is
  clean: the classifier is separating real cash deals from structurally-un-cash
  deals, not hiding a pricing bug.
- **Proposal queue census** — 15 `h2_opener_hold` proposals sitting in
  Agent_Proposals with no automated resolution path. The conveyor now renders them
  honestly ("Pricer HOLD — no autonomous text will fire") but "rule it manually,
  one by one" does not scale to 50 negotiations/month.

The revenue logic: sellers asking **above** renovated value are, almost by
definition, sellers whose equity position or expectations can't survive a cash
discount — which is exactly the population where seller financing, subject-to, and
novation structures do their work. The machine already finds them, values them, and
proves cash can't pencil. The only missing piece is a doctrine-compliant way to
open the conversation.

## 2. The hard constraint: no sourced number exists for a creative opener

Every cash opener is value-anchored: `anchor × (ARV × buybox − rehab − fee)`, every
input sourced. **A creative offer has no equivalent sourced anchor.** A subject-to
or seller-finance number is built from the seller's loan balance, rate, payment,
and arrears — none of which exist in Listings_V1, RentCast, or any feed we ingest.
They only exist in the seller's head and paperwork.

Consequence (this is the spine of the whole spec): **a creative opener can carry NO
dollar figure.** Any number in a first-touch creative message would be a fabricated
number — a direct INVARIANTS violation. The opener can only be an *interest probe*
("would you be open to a sale that gets you full price on terms?") whose job is to
surface the seller's numbers, which then become the sourced inputs for a real
structured offer.

This constraint is also the answer to "how would 817 Regal ever get an automated
text?" — it gets a *no-number* text, or it gets nothing.

## 3. Proposed shape (what would be built IF ruled in)

Phased so each phase is separately shippable and separately killable:

**Phase A — probe opener (small).** A `creative-lane` cron mirroring the H2 rail's
gates (send window, KV claims, quarantine, sticky stamps, one-opener-ever) that
sends a *no-number* interest probe to `cash_no_pencil` records meeting eligibility
gates (§5 Q3). Stamp format `[CL probe sent <iso>] Quo msg <id>: <body>`. Replies
land in the existing scan-comms → classify pipeline.

**Phase B — terms intake (medium).** Replies expressing interest get a structured
DD-volley (mirroring B2's design) that collects the seller's actual numbers: loan
balance, rate, payment, arrears, timeline. Every collected number is
delivery-stamped the moment it arrives — these become the ONLY permissible inputs
to a structured offer. All drafts through the 2A queue.

**Phase C — structured offer (large, far).** Compose an actual subject-to /
seller-finance proposal from stamped inputs. This is contract territory —
per standing rules it interrupts the operator (signatures, money, advanced
negotiations). Not spec'd further here; Phase B's output defines its inputs.

**Explicitly NOT proposed:** any autonomous dollar figure at any phase; any use of
pre-v2 records (THE FORWARD RULING applies — v2 pool only); any state in the
exclusion list; any bypass of the H2 master kill switch (`H2_OUTREACH_HARD_DISABLE`
would gate this lane too).

## 4. Cost/risk profile

- Phase A reuses the entire H2 rail; build size comparable to the bump lane. No new
  data spend (records are already priced and verified).
- Message risk: creative probes are a *different pitch* under the same brand
  identity/number. A confused or annoyed seller response costs the same as any
  cold-text response; opt-outs are honored by the existing STOP machinery.
- Legal risk concentrates in Phase C (subject-to has state-specific exposure), but
  Phase C is already behind the operator-interrupt wall by standing rules.

## 5. The 2C questions — what the operator must rule

1. **Does the lane exist at all?** Alternative is explicit: auto-archive
   `cash_no_pencil` holds as `creative_pass` and keep the desk clean. (Either
   ruling beats today's silent-forever-hold.)
2. **Which structures are in-bounds for the pitch?** Seller finance only /
   subject-to included / novation included. This shapes the probe wording and
   Phase B's question set.
3. **Eligibility gates for Phase A.** Proposed default: v2 pool, Active, actionable
   market, trusted-ARV-below-ask class only (not floor/rehab-eaten records), DOM ≥
   30 **or** a price cut on record (motivation signal), never a record with a live
   cash thread.
4. **Autonomy boundary.** Proposed default: Phase A probes send autonomously on the
   H2 rail (they contain no number, no commitment); everything from the first
   seller reply onward drafts through 2A. Alternative: even probes queue through 2A
   until the operator has watched a batch.
5. **The probe copy itself.** One sentence the operator is willing to own, e.g.:
   *"Hi <name> — following up on <street>. A cash number won't reach your asking
   price, but if getting full price mattered more than getting it all at closing,
   I have a couple of ways to structure that. Worth a call?"* Rule the framing
   (full-price-on-terms vs. flexible-close vs. open question).

**Recommendation** (for the ruling, not a build default): rule the lane IN at Phase
A only, seller-finance + subject-to in-bounds, autonomous probes with 2A on all
replies, gates as proposed in Q3. Rationale: highest-information/lowest-commitment
step, fully inside existing rails, and it converts a growing dead pile into
classified seller intent while B2 handles the cash side.

---

*Nothing ships from this spec until the ruling lands. When it does, the ruling gets
spine-written as a `principle_amendment` referencing this document, and only then
does Phase A enter the build queue.*
