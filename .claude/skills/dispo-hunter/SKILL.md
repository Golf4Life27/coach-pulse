---
name: dispo-hunter
description: Hunt cash buyers for ONE contracted AKB property on Facebook groups using the operator's own logged-in browser, at a human pace, from the record's dispo package only. Use when the operator says "run dispo hunter on <address>", "find buyers for <deal>", "post <deal> in the groups", or hands you a /pipeline/<id>/package link. Never for seller-side outreach, never without a package, never on a deal whose contract is not executed.
---

# Dispo Hunter — AKB

One deal, one metro, one operator-approved package, your own browser. The job is to put the deal in front of real cash buyers in Facebook groups without getting the account restricted, without leaking a single private number, and without ever negotiating. Every lead lands in the Buyers table and on the operator's phone. You do not close anything.

## Inputs (all required before the first post)

1. The package page: `https://coach-pulse-ten.vercel.app/pipeline/<recordId>/package` (dashboard session; the operator is logged in on this machine). It carries the one-pager, the Facebook group post, the DM reply, the deal link, the photos, and the disclosure. **Copy from it. Do not write your own deal copy.**
2. The operator's explicit go for THIS deal, in this session or in the routine prompt. "Run dispo hunter on 513 Lamar" is the go. A package page existing is not the go.
3. Contract executed: the package page header shows the executed date. Blank date = stop and report; nothing is marketable before the contract is signed by both sides.
4. State check (below). Texas and Alabama have specific rules; Illinois matters because AKB is based there.

## Hard rules (doctrine, not suggestions)

- **Only the package numbers exist.** The one money figure you may ever type is the Price line from the package (the assignment price). Contract price, ARV, repairs, spread, fee, list price, what the seller wants, what the agent said: you do not know them, and if a buyer asks, the answer is "the deal page has everything I can share." This mirrors `lib/jarvis-system-prompt.ts` and the `/d/` allowlist; the package composer already strips them, so if you find yourself typing a number that is not on the package, stop.
- **Disclosure on every public post and every first DM.** The package's short disclosure line ("Assignment of contract. AKB Solutions LLC holds an equitable interest and is not the owner or a broker...") is the last line of every post, no exceptions, no shortening.
- **Never claim a track record.** AKB has closed zero deals. No "we've done this before", no "our buyers love", no "guaranteed", no fake urgency beyond the real close date.
- **No cold DMs, ever.** You message only people who commented on the post, reacted with a question, or messaged first. Unsolicited DMs are how accounts get restricted and how TCPA-adjacent trouble starts.
- **Tier C is untouchable.** No counteroffers, no "would you take", no price discussion beyond restating the package price, no promises of exclusivity, no assignment agreements, no earnest money talk, no showing scheduling. The reply to all of it is the DM reply from the package plus "Alex will follow up directly." Then you write it to the Buyers table and the operator's phone gets the alert through the normal lane.
- **Marketplace is OFF by default.** Facebook's real-estate Marketplace policy expects the lister to own or represent the property. Group posts only unless the operator has ruled Marketplace on for this deal in writing.
- **Seller and agent are invisible.** Never name the listing agent, the seller, the brokerage, or the MLS status. Never post the listing photos' MLS watermark if one exists; use the package photo URLs.

## State rules (read before posting; this is not legal advice)

| State | What we know | Action |
|---|---|---|
| Texas | Property Code 5.086 requires disclosing to a potential buyer that AKB holds an equitable interest. Occupations Code 1101.0045: an unlicensed party may market its contract interest, not the property. | Lead with "Assignment of contract" in the first line. Disclosure line mandatory. Never phrase it as "house for sale". |
| Alabama | Recent wholesaling disclosure legislation; specifics unverified in this skill. | Post only after the operator confirms the Alabama wording. Disclosure line mandatory regardless. |
| Illinois (AKB's home state) | Real Estate License Act: unlicensed wholesaling is capped at one deal per 12 months. | Do not market Illinois properties without the operator's explicit ruling. |
| Ohio, Michigan, Tennessee, Georgia | No specific rule loaded here. | Disclosure line mandatory. Verify with the operator on first use in each state. |

If the state is not Texas and the operator has not confirmed the wording for it, stop after group discovery and report the groups found. Do not post.

## Conduct (this is what keeps the account alive)

- Human pace. Between any two actions (open group, post, reply, DM): wait at least 4 minutes, and vary it. Read the group for a minute before posting.
- Caps per session: 5 group posts per hour, 12 per day, 1 post per group per deal per week, 3 group joins per day.
- Vary the first line across groups (the package gives one post; rotate its opening sentence order lightly, never the numbers, never the disclosure).
- Read each group's rules first. If the rules forbid deal posts, promotional posts, or require admin approval you do not have, skip the group and log why.
- Reply to a comment once. If they want more, send the DM reply from the package once. Then stop; the deal page and the operator take it from there.
- The moment Facebook shows a warning, a captcha, "you're temporarily blocked", "this post goes against our standards", or asks for identity verification: stop everything, close nothing, report immediately with a screenshot. Do not retry, do not switch accounts, do not create a new group.
- No emoji walls, no more than 3 hashtags, no ALL CAPS beyond "OFF-MARKET".

## Group discovery (per metro)

Search Facebook groups for: "<city> cash buyers", "<city> real estate investors", "<city> wholesale", "<city> fix and flip", "<city> landlords", "<state> real estate investing", "<metro> off market". Prefer groups with posts in the last 7 days and over 1,000 members. Record for each: name, URL, member count, last-post recency, rules verdict (ok / needs approval / forbidden), and whether you posted. That log goes in the report and the spine write.

## Lead capture (every raised hand, no exceptions)

For each person who comments "interested", asks a question, or DMs:
1. Send the package DM reply once (it carries the deal link, the proof-of-funds ask, and the short disclosure).
2. Write them to Airtable Buyers (base `appp8inLAGTg4qpEZ`, table `tbl4Rr07vq0mTftZB`): Name, Email and Phone if they gave one, Markets = the metro, Source = "Facebook", Notes = group name, post URL, profile URL, verbatim message, timestamp. Call `get_table_schema` first and write only fields that exist; unknown data goes in Notes. Never overwrite operator-entered contact fields.
3. If they submit the intake form on the deal page, the existing lane stamps the buyer and pages the operator on interest; you do not need to duplicate the alert.
4. If they name a number, a timeline, or say "I'll take it": that is Tier C. Reply with "Alex will follow up directly", write it to Notes, and flag it in the report as a yes/no with a default. Do not answer it yourself.

## Report and write-back (end of every run)

1. One spine write via `mcp__Maverick__maverick_write_state` (event_type `decision`, attribution `scout`, related_listing = the record id): groups searched / posted / skipped with reasons, leads captured (count and names), any Tier C items, any Facebook warnings. Write it even for a zero-post run.
2. One plain-language report to the operator: scoreboard first (posts, leads, Tier C items), then decisions as yes/no with a default. No screenshots of private groups in the report unless a warning fired.
3. Re-run cadence: not more than once per day per deal. The weekly limit of one post per group per deal holds across runs.

## Stop conditions

Operator says stop; any Facebook warning; contract executed date blank; option or inspection deadline on the package has passed with no operator ruling; the deal page returns 404 (the operator un-published it). In every case: report, do not post.
