# Hunter Intake v1 — Spec

**Status: RULED (operator, 2026-09-18) — spec only. Nothing in this document is
built.** The operator answered "yes, spec the intake mapping" to the default in
the 2026-09-18 hunter assessment: pipe the external hunter agent's finds into
Listings_V1 as an intake source so the existing send path prices and sends the
soft opener, and hold land records unpriced until a land lane exists.

@agent: scout (intake), sentry (gates)

---

## 1. What the hunter is, and is not

The operator runs a second AI agent ("the hunter") that reads Houston MLS
listings and reports tired houses and stale vacant land: address, list price,
prior prices, days on market, relist history, lot size, HCAD assessed value,
listing agent and phone. It also produces a "MAO" per property and a text
draft addressed to the agent.

Assessment recorded 2026-09-18 against the spine:

- **Keep:** the scouting. Its distress filter (as-is, 60+ DOM, repeat cuts,
  estate, foundation) matches the intake filter's own distress sourcing. HCAD
  assessed value is a signal the crawler does not compute. Land does not need
  the RentCast comps that are exhausted until 2026-10-01.
- **Drop:** the numbers and the drafts. Its MAOs run 80–87% of list on land,
  the same constant-ratio shape the 2026-07-06 ruling (`capped_to_list`,
  43 records) retired. They are sent as hard committed first-contact numbers,
  which the two-stage doctrine (Spine rec8eZG5hH16FFyF2) forbids: openers are
  62% × list, phrased soft, and the ceiling is never the opener. Its drafts are
  the "cash $X, and/or assigns" commodity text agents told us this week they
  delete ten of a week. Its statute citation (§5.0205) matches nothing the
  codebase cites (Texas Occupations Code 1101.0045; equitable-interest
  disclosure is Property Code §5.086).
- **It does not know our history.** 8022 Talton St is already in Listings_V1
  twice and has been Dead since 2026-04-17. The hunter re-pitched it as new.

So the hunter is an **intake source**, on the same footing as RentCast or a
Firecrawl sweep: it supplies candidates and facts. Pricing, verification,
sending and recording stay inside the system.

## 2. The input contract

The hunter's output today is prose. Prose is not an intake feed: the address,
the price history and the agent phone have to be parsed out of sentences, and
a parse miss silently drops a lead or, worse, mis-keys a phone. The hunter
must emit one structured row per property. JSON array or CSV, same columns.

| Column | Type | Required | Notes |
|---|---|---|---|
| `address` | string | yes | Street line only. "0 Colt St" style unaddressed lots allowed. |
| `city` | string | yes | |
| `state` | string | yes | Two-letter. |
| `zip` | string | yes | Five digits. |
| `property_type` | `house` \| `land` | yes | Hunter's own classification. Anything else → row rejected. |
| `list_price` | number | yes | Current ask. |
| `prior_list_prices` | number[] | no | Oldest first. Drives Price_Drop_Count and Prev_List_Price. |
| `days_on_market` | number | no | Hunter's DOM claim. Stored as a claim, not as `Last_Verified`. |
| `relisted` | boolean | no | Expired/withdrawn and relisted. |
| `listing_url` | string | no | Portal URL. Enables Firecrawl verify at intake. Strongly preferred. |
| `mls_number` | string | no | |
| `beds`, `baths`, `sqft`, `year_built` | number | no | Houses only. |
| `lot_sqft` | number | no | |
| `assessed_value` | number | no | HCAD (or county) appraised value. |
| `assessed_source` | string | no | URL or "HCAD 2026". Required if `assessed_value` is set. |
| `agent_name` | string | yes | |
| `agent_phone` | string | yes | Any format; normalized to 10 digits on ingest. |
| `agent_email` | string | no | |
| `brokerage` | string | no | |
| `condition_notes` | string | no | Free text: "no HVAC", "no water/sewer", "estate", "no showings until offer". |
| `hoa_annual` | number | no | |
| `hunter_batch` | string | yes | Hunter-side batch id or date, for tracing a row back to a report. |

**Rejected columns.** `mao`, `offer`, `draft`, `script`, or any dollar figure
other than list, prior list and assessed value are dropped at parse time and
counted in the report as `hunter_pricing_dropped`. They are never written to
any field, note, or JSON receipt. A hunter number stored anywhere on the
record is a stored field that a future session could mistake for a price
(pricing-doctrine standard 1: fields are history, not authority).

## 3. The ingest path

`POST /api/admin/hunter-intake` — modelled on `app/api/admin/propstream-seed`
(body is the export, dry run by default, `?apply=1` writes). Same auth
waterfall (`lib/maverick/oauth/auth-waterfall`). `maxDuration = 300`.

Per row, in order:

1. **Parse and validate** against §2. Invalid row → `rejected_invalid` with the
   column named. Phone normalized to 10 digits; a phone that does not
   normalize → `rejected_bad_phone` (an unsendable record is worse than no
   record).
2. **Dedup** by `normalizeAddressKey` (`lib/crawler/intake-filter`) against the
   full Listings_V1 load, exactly as `listings-intake` does at its dedup step.
   - No match → continue.
   - Match, any status → **never create a second record.** Stamp `Last_Seen`
     (`lib/crawler/last-seen`), append one Verification_Notes line
     `[iso] HUNTER_RESUBMIT batch=<hunter_batch> list=$<list_price> dom=<dom>`,
     and count `dedup_existing`. If the existing record's `Outreach_Status` is
     Dead, count it separately as `dedup_dead` and surface the address in the
     report. A Dead record is revived only by an operator ruling, never by a
     resubmission (the Talton case).
3. **Split by `property_type`.**
   - `house` → build fields with `buildIntakeListingFields` through an adapter
     that maps a hunter row onto `IntakeCandidate` (§4). The standard intake
     filter (`evaluateIntakeCandidate`) runs with `requireDistress` on; the
     hunter's DOM and price cuts are the distress signals. A house the filter
     rejects is reported with the filter's reason, not written.
   - `land` → bypass `isSingleFamily` (which rejects land by design) and write
     a **held** record (§5). The intake filter is not consulted; there is no
     land filter yet.
4. **Firecrawl verify** (INV-028: only after dedup, never for a known address)
   when `listing_url` is present: same call as intake, stamps
   `Verification_URL`, `Last_Verified`, `Live_Status`, and runs the renovated
   and distress language detectors and the inactive/sold detector (PR #251).
   No URL → no stamp; the record waits for `freshness-reverify` to find it on
   the `Verification_URL=''` pass. **Hunter intake never stamps
   `Last_Verified` itself.** The hunter's "as of" is a claim; the 48-hour
   freshness gate (`lib/outreach-freshness`) must see a system verify.
5. **Write** with `typecast: true`. `Verification_Source = "hunter_intake"`
   (new single-select choice; typecast creates it on first write).
6. **Audit** one `hunter_intake` event per run with the counts in §7, and one
   `hunter_intake_created` per record.

`promote` is **always false** in v1: every hunter house lands in
`Outreach_Status = "Review"`. Auto-promotion to Auto Proceed stays a separate
operator switch, same as `CRAWLER_AUTOSEED_LIVE` for the crawler, and is
turned on only after the first batch has been read back against the spine.
Reason: the hunter has no sold/pending detector of its own, and the 2026-09-18
rollback (27 listings falsely marked Off Market, 3 of 4 checked were live)
shows status detection is the fragile step. Promotion by hand first, then by
switch.

## 4. Field mapping (house rows)

| Hunter column | `IntakeCandidate` prop | Listings_V1 field | Rule |
|---|---|---|---|
| `address`, `city`, `state`, `zip` | same | Address, City, State, Zip | verbatim after trim |
| `property_type = house` | `propertyType` | Property_Type | written as `"Single Family"` |
| `list_price` | `listPrice` | List_Price | |
| `prior_list_prices` | `priceReduced` | Price_Drop_Count, Prev_List_Price | count = number of strictly-lower steps; Prev_List_Price = last prior price. Extends the boolean-only RentCast convention; `buildIntakeListingFields` needs a `priceDropCount` opt. |
| `days_on_market` | `daysOnMarket` | — (claim only) | consumed by the distress filter; **not** written to DOM_Calc_V2, which is derived from MLS_Date_Raw. If the hunter later supplies a list date, that maps to MLS_Date_Raw. |
| `relisted` | — | Verification_Notes line `RELISTED` | distress note; no field |
| `listing_url` | `url` | Verification_URL (via verify) | |
| `mls_number` | — | Verification_Notes line | no confirmed field |
| `beds`, `baths`, `sqft`, `year_built` | `beds`, `bathrooms`, `squareFootage`, `yearBuilt` | Bedrooms, Bathrooms, Building_SqFt, Year_Built | |
| `lot_sqft` | — | Verification_Notes line | no confirmed field in v1 |
| `assessed_value` + `assessed_source` | — | Verification_Notes line `ASSESSED $<v> (<source>)` | **note only.** Assessed value is not an ARV basis and must not reach any pricing field. Revisit when a land lane needs it as an input. |
| `agent_name`, `agent_phone`, `agent_email` | same | Agent_Name, Agent_Phone, Agent_Email | phone normalized |
| `brokerage` | `brokerageName` | — | carried, not written (matches intake) |
| `condition_notes` | — | Verification_Notes line `HUNTER_CONDITION: …` | feeds nothing automatically; the negotiation stage reads it |
| `hoa_annual` | — | Verification_Notes line | |
| `hunter_batch` | `sourceId` | Verification_Notes header | `[iso] Hunter intake (batch <id>) — queued for Review.` |
| — | — | Source_Version | `v2` (SOURCE_VERSION_V2), required by the H2 eligibility check |
| — | — | Verification_Source | `hunter_intake` |
| — | — | Outreach_Status | `Review` |
| — | — | Execution_Path | unset (not Auto Proceed) |
| — | — | Do_Not_Text | false |

**Two-map rule.** Any NEW Listings_V1 field this spec introduces goes in both
`LISTING_FIELDS` and `LISTING_NAME_MAP` in `lib/airtable.ts` and in the
parity test. v1 introduces none; everything lands on existing fields or in
Verification_Notes.

## 5. Land rows: held, unpriced

Land is written so it exists, is deduped against, and is visible, and so that
no lane can price or text it until a land lane is ruled and built:

| Field | Value |
|---|---|
| Property_Type | `Land` |
| Outreach_Status | `Review` |
| Execution_Path | unset |
| Do_Not_Text | `true` |
| Rough_Opener_Amount, Underwritten_MAO | never written |
| Opener_Basis | `hold_land_no_lane` |
| Verification_Notes | `[iso] Hunter intake (batch <id>) — LAND_HOLD: no land pricing lane; doctrine escalates land to the operator. lot=<lot_sqft> assessed=$<v> (<source>) utilities=<condition_notes>` |

`Do_Not_Text = true` is the belt on top of the Execution_Path braces: the H2
eligibility check refuses on either, and a future operator promote-by-hand of
a land record still cannot send until the flag is deliberately cleared.

The land lane itself is a separate spec and a separate ruling. What it needs,
recorded so the next session does not rediscover it: a lot-value basis
(county lot $/sqft comps or builder buy-box), a builder/developer buyer list
(the Buyers table is house buyers; builders have agents, which is the 1005 2nd
St lesson), and the "materially higher" land fee floor SYSTEM_FACTS §9
promises but does not quantify.

## 6. Pricing and sending: unchanged, and that is the point

- **No number is produced at hunter intake.** Houses receive their opener on
  the H2 send path in `list_anchor_soft_v1` mode (62% × list, soft phrasing)
  at send time, after the freshness gate and the renovated veto, exactly like
  every other record. `opener` is passed to `buildIntakeListingFields` as
  `null`.
- **Negotiation stage** is unchanged: first reply triggers comp-level
  verification and the two-lane MAO ceiling before any number is firmed. The
  hunter's condition notes are an input to the DD scope there.
- **Ratio detector** (standard 2) is unaffected: hunter records carry no
  firmed number until the negotiation stage produces one.
- **Templates only.** No hunter draft text is ever sent. The Texas disclosure
  line comes from the Crier template that cites Occupations Code 1101.0045,
  not from the hunter's row.

## 7. Report shape (dry run and apply)

```
rows_in, rejected_invalid[], rejected_bad_phone[], hunter_pricing_dropped,
dedup_existing[], dedup_dead[], filter_rejected[{address, reasons}],
houses_created[], land_held[], verified (firecrawl), unverified_no_url,
firecrawl_credits_used
```

Every array carries addresses so the operator can read the run in one screen.
The dry run is the default so the hunter's first structured export can be
checked against this spec before anything is written.

## 8. What the hunter must change

1. Emit §2 rows, not prose. One row per property, one batch per report.
2. Stop producing MAOs and drafts. Spend that effort on `listing_url`,
   `mls_number`, `prior_list_prices` and `assessed_source`.
3. Keep the filter it already has (as-is, 60+ DOM, repeat cuts, estate,
   foundation, relist after expire). That is the part that is working.
4. Include the ZIP on every row. The send set is ZIP-gated (`METRO_ZIPS` ∪
   ZIP_Registry); Houston coverage arrived via ZIP_Registry on 2026-09-16 and
   must be confirmed per ZIP before a hunter house is promoted.

## 9. Tests

- `lib/crawler/hunter-intake.test.ts`: adapter maps every §2 column to the
  §4 target; `mao`/`offer`/`draft` columns are dropped and counted; a hunter
  number never appears in any produced field or note; land rows produce the
  §5 held shape with `Do_Not_Text = true`; bad phones reject; prior-price
  steps count only strictly-lower moves.
- Dedup: an address already in Listings_V1 (any status) creates nothing; a
  Dead match is reported under `dedup_dead`.
- `lib/airtable-map-parity.test.ts`: untouched in v1 (no new fields); the
  test is the tripwire if a later revision adds one.

## 10. Build order and size

1. `lib/crawler/hunter-intake.ts` — pure parser, validator, adapter, land
   shape. Half a session with tests.
2. `app/api/admin/hunter-intake/route.ts` — dry-run/apply route reusing the
   intake cron's dedup load, Firecrawl verify and create call. Half a session.
3. Hand the hunter the §2 contract and run its next report through the dry
   run. Read the report back against the spine before `?apply=1`.
4. Spine `build_event` paired with the merge (SYSTEM_FACTS §3 discipline).

Not in v1: a land pricing lane, a builder buyer list, a land fee constant,
auto-promotion of hunter houses, any new Listings_V1 field.

## 11. Decisions for the operator

Both default **yes**; the build proceeds on the defaults unless overruled.

1. `hunter_intake` becomes a new `Verification_Source` choice, created by the
   first typecast write. (Alternative: reuse `Manual`, which loses the
   ability to filter hunter records later.)
2. Hunter houses land in Review, promoted by hand for the first batch, with a
   `HUNTER_AUTOPROMOTE_LIVE` switch added only after that batch has been read
   back.

---
*v1 · 2026-09-18 · Ruling: operator "yes, spec the intake mapping" in the
hunter assessment session. Companion spine entries: the 2026-09-18 hunter
assessment decision written from the same session. Supersede via a logged
Spine `build_event`, never a silent edit.*
