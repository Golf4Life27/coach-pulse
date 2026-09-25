# AKB Execution Agenda (PLAN)

This is the one plan (agenda item P0-28). Built 2026-09-23 from 99 verified holes (28 critical; 3 disproved by skeptics and dropped) across 10 audit dimensions, 87 agents in all. Copied into the repo 2026-09-25 from the live page https://claude.ai/artifact/NV9VDr9JfGvTBXcmcyfRms, which stays the place Alex ticks items and answers decisions. The page's answers and tick marks are not mirrored here; read the page (or the spine) for current state. Spine: recvVGhBlurgtKHsT (agenda), recYbAYqkguZSOTeF (operator GO on P0).

Supersedes: Replaces AKB_MASTER_CHECKLIST.md, V1_Roadmap_to_100.md, the Gap Analysis and the business plan's next steps (item P0-28 stamps them).

## Scoreboard at time of writing (2026-09-23)

Fees to date: $0 (0 of 2 executed contracts ever closed). Live conversations: 214 records sit in reply statuses (121 Response Received, 82 Negotiating, 11 Counter Received). How many heard from the other side in the last 14 days is not measured yet; P0-10's dry run adds that count to this line. Sellers who named a number: 11 open counters dated 9/8 to 9/18 (the oldest already fall under the 14-day death rule), plus 1 acceptance today: 18644 Kelly Rd, Detroit, said "Accepted." to our $21,750 against a $35,000 list, 19:15Z. Fit our ceiling: 0 checked. 90 of 99 Negotiating/Counter records sit at NEEDS_DATA or HOLD. Fee if they close: $5,000 floor each. Kelly Rd's fee is unknown until P0-3; our $21,750 plus the $5K floor needs a ceiling of at least $26,750. Closest deal is Kelly Rd. Four things block it: no comp set, no funded Detroit buyer, the record still reads Negotiating/NEEDS_DATA, and Randi asked Alex for a call at 19:15Z; no call or contract request is on the record yet.

## Investor verdict

No, I would not buy this system today. It has never turned a lead into cash. Zero fees closed, and both contracts it ever executed died: Houston went cold, and Birmingham was signed with zero funded buyers in that city. It has no real buyer side: 1 of 125 buyers has proof of funds. The one real acceptance, Montrose, died because the answer waited on Alex for 20 days. The alarms meant to prevent that are broken: the escalation pager has no phone number and has skipped 32 money decisions every hour; the queue hides open decisions after 14 days; one Quo billing lapse silenced the seller line and two of three alert paths for about 70 hours, and only Pulse's email fallback got through. The repo is public, and several write routes that can kill a deal or overwrite the buyer list need no login. One more honest point: the first fee still depends on on-market listings, the lane this audit ranks weakest, because buyers can call the listing agent and cut us out. This plan bets on that lane for three more weeks and switches at the 10/14 kill date if it hasn't produced a signed, sold contract. What is real is the lead engine and the discipline: sourcing runs itself, the pricing code refuses to guess, and the decision log is unusually honest. So the machine is good at finding sellers and bad at turning a yes into a fee. That makes it a well-built prototype missing its back half, not a business.

**What it is worth.** Today, as a business: about $0. There is no revenue, no closed deals, no transferable buyer list, and every key account (claude.ai routines, Quo, Facebook, the laptop) is tied to Alex. As a pile of parts: low five figures at most, for the pricing guards, send-safety gates, dry-run harness and intake crawler. Even that is discounted because the code is public (anyone can copy it free) and it takes a skilled operator to stand it up. With a track record the picture changes. Say 6+ months at 2-3 closed fees a month at about $7K each: roughly $170-250K a year. An owner-operated wholesaling shop at that level usually trades around 1-2x owner earnings, so roughly $150-400K, more if it runs with Alex only deciding and signing and someone else can take it over. This is my rough advisor estimate, not a comp-based appraisal. What a buyer actually pays for: (1) funded buyers with proof of funds, by metro, who have bought from you; (2) a repeated closing record: contract, then assignment, then fee in the ledger; (3) deal flow that doesn't depend on beating listing agents to on-market houses; (4) proof it runs without Alex, such as a passed 30-day unattended test; (5) a private codebase another operator can stand up from docs. None of the five exist today.

## Decisions only Alex makes

| ID | Question | Recommended default | Blocks |
|---|---|---|---|
| D1 | A 'funded buyer' is a proof-of-funds letter on file, OR a deed showing a cash purchase in the last 12 months, OR a JV wholesaler with a named buyer's proof of funds? A 'yes' is a written email naming the price with proof of funds attached. | Yes | P0-5, P0-14, P2-3, P2-8, P3-1 |
| D2 | When free comp sources fail on an accepted deal or a live counter, may Code ask you to leave your laptop on for one 20-minute PropStream pull? | Yes, only for accepted deals and live counters, at most twice a week. If the card goes unanswered by its deadline, Code walks politely. | P0-4, P1-4 |
| D3 | Pay for one attorney hour (about $400) on the Michigan note and the assignment template? If the attorney can't review before Kelly's signing deadline, sign on the AI first pass? | Yes to both. The 10+ day inspection contingency lets us exit if the review finds a problem. | P0-8, P0-14, P3-4, P4-1 |
| D4 | If a title company won't close an assignment, use a double close instead (needs paid short-term funding)? | No. Find another title company; if none by 2 days before the inspection deadline, terminate in writing. | P0-9, P2-10 |
| D5 | Make the GitHub repo private, with an Actions spending limit set from P0-22's measured minutes? | Yes, with the limit at 1.5x the measured monthly cost | P0-23, P1-14, P5-9 |
| D6 | Turn on Quo auto-recharge with a $50 floor and a monthly cap of 2x last month's spend? | Yes | Nothing in code; it prevents a repeat blackout (P0-20 is the backup alarm) |
| D7 | Cap total spend (Claude plus vendors) at $3,000 a month until the first fee, with Claude build work at most $2,000 of it; pause new build sessions for the day when the meter shows more than $300 of Claude charges in a day? | Yes | P0-26, P0-27, kill criteria |
| D8 | You ruled on 9/21 that routines run on the execution tier, not the top tier. Some are still on the top tier, including the daily buyers build, which also fires into one long session that re-pays its whole history every run. Switch them to the execution tier, and move the buyers build to a fresh session each run? | Yes | P0-25 |
| D9 | Approve the Deal Envelope as a standing rule? Our price is at or below the comp-checked ceiling minus a $5,000 fee, EMD is $1,000 or less (total outstanding $3,000 or less), inspection is 10+ days, close is 21+ days, the contract says 'and/or assigns', and a funded buyer has said yes in writing at the price. | Yes, as written | P1-5, P1-7a, P1-10, P2-5 |
| D10 | Counter band: when a counter is within 10% over our ceiling, auto-send one counter at the ceiling; more than 10% over, a polite pass; no comps, condition questions only, never a number? | Yes | P1-7b, P1-7c, P1-10 |
| D11 | When a card's deadline passes, run its safe default (24h for live deals, 72h for housekeeping)? Signing, wiring, executing and terminating never auto-run. | Yes | P1-6c |
| D12 | Hard-block 'Mark contract executed' when there is no funded buyer or the comps fail, allowing a written override? | Yes | P3-1 |
| D13 | Buyer's non-refundable deposit to title when the assignment is signed? | $2,500 | P4-1, P4-2 |
| D14 | Allow JV fee splits with other wholesalers, up to 50/50 on the first deal? | Yes | P2-6 |
| D15 | Turn on the automatic buyer blast (DISPO_BLAST_LIVE) after you see one preview? | Yes | P2-7 |
| D16 | Renew the dead ATTOM key? | No for now. Detroit and Memphis have county, RentCast and PropStream coverage. Revisit only if the 9/30 comp kill criterion trips. | Comp coverage outside Detroit and Memphis |
| D17 | Let Code write Vercel environment variables (feature flags and any key Code obtained without you) directly? | Yes | P2-7, P5-9, P5-10 |
| D18 | Start the off-market pilot if there is no signed contract with a committed buyer by 10/14? It needs paid pieces: skip tracing to find owner contacts and a mail vendor. | Yes when 10/14 trips: one metro, one list, mail or email only, $500 cap. No before then. | P5-15, P5-16a, P5-16b, P5-16c timing |

## P0 — This week: Kelly Rd fast lane, and stop the bleeding

**Window:** 2026-09-23 to 2026-10-03 (Kelly signing dates follow the PA's arrival)  
**Goal:** Kelly Rd gets a same-day answer and a dated path to a signature or a polite walk. Every overdue decision reaches Alex. Nothing public can kill a deal. Dead deals stay dead. Spend has a meter and a brake.  
**Exit:** Kelly Rd is either signed with all 6 checklist lines green and EMD wired, or walked politely with the reason on the record. A forced Quo 402 alert from each of the three SMS-only senders arrives in Alex's email. The escalation audit row shows sent>0. 0 open cards are hidden by age. Every previously open write route returns 401 without login. The repo is private with sends and CI verified, or Alex's recorded 'no' is on file. The death classifier runs daily. The scoreboard card shows month-to-date spend and the 14-day counterparty-contact count.

- **P0-1** (Code+Alex, S) Alex calls the Kelly Rd listing agent (number on record rec7dDjzRQUE4KU0V). She accepted $21,750 at 18:25Z on 9/23 and asked for a call about an hour after 19:15Z. On the call: confirm $21,750, and ask her to send the purchase agreement with buyer 'AKB Solutions LLC and/or assigns', a 10+ day inspection, and EMD of $1,000 or less held by title. If no call happens by 9/24 16:00Z, Code texts that same request behind a 4h veto card.  
  _Why:_ This is Montrose again unless someone answers today. Asking for the agreement commits us to nothing; signing waits for the P0-14 checklist.  
  _Done when:_ A call note or the texted request is on rec7dDjzRQUE4KU0V before 9/24 20:00Z, and the record reads Offer Accepted.  
  _Depends on:_ none
- **P0-2** (Code, S) Teach the reply classifier that a bare 'Accepted' / 'Accept' / 'We accept' / 'Deal' is an acceptance, with negative tests.  
  _Why:_ Today's acceptance was filed as 'unknown' and paged no one.  
  _Done when:_ Tests pass: 'Accepted.', 'Accept', 'We accept' and 'Deal' read as acceptance; 'Deal?', 'No deal', 'Not accepted' and 'Is that a deal?' do not. Re-running triage on rec7dDjzRQUE4KU0V returns acceptance.  
  _Depends on:_ none
- **P0-3** (Code, S) One Code session pulls Kelly Rd comps by calling the RentCast live lane and the Wayne County deed ledger directly, not through the auto-underwrite path that fails on Annott. It checks the ARV against its own comps and writes the ceiling to the record.  
  _Why:_ We sign only if the ceiling leaves at least a $5,000 fee above $21,750. The normal comp path is broken (P1-1), so Kelly can't wait for that fix.  
  _Done when:_ By 2026-09-25 12:00Z the record has 3+ sold comps from the last 12 months, an ARV inside its own comp band, and a stated ceiling. If not, P0-4's card fires.  
  _Depends on:_ none
- **P0-4** (Code+Alex, S) If P0-3 has no comp set by 2026-09-25 12:00Z, post one card that day: 'Leave your laptop on for a 20-minute PropStream pull on Kelly Rd?' On yes, Code runs the propstream-cma-pull skill in Cowork and ingests the PDF. If the card is unanswered by 9/26 18:00Z, Code walks politely (the decision default).  
  _Why:_ A dated fallback that lands before the Kelly walk date, not after it.  
  _Done when:_ Either P0-3 succeeded, or the card posted on 9/25 and the record shows a PropStream comp set by 9/26 23:59Z, or the polite walk went out.  
  _Depends on:_ P0-3
- **P0-5** (Code, S) Set the buyer 'yes' rule and the address gate. A yes is a written email naming the price, with proof of funds attached. The address goes out only after the buyer replies with one line: 'I won't contact the seller or listing agent, or buy this property, except through AKB.' Code books the walkthrough in AKB's name during the inspection window; the buyer never contacts the listing agent.  
  _Why:_ These are MLS listings. Without this step a buyer can find the house and buy around us, which is exactly what intake-1 showed.  
  _Done when:_ The Kelly teaser flow includes the step. A test buyer reply without the line does not get the address; a test reply with it does.  
  _Depends on:_ none
- **P0-6** (Code, S) Run a 72h Detroit buyer sprint for Kelly Rd. Send a teaser with neighborhood, condition class and price only (no exact beds/baths, square feet or photos) to every emailable Detroit buyer, highest buildBuyerShortlist score first. Ask for a written yes at the price plus a proof-of-funds letter.  
  _Why:_ A funded yes must exist before Alex signs.  
  _Done when:_ Within 72h of the send, at least 1 written yes with proof of funds, or a result card posts with sent / replied / yes counts.  
  _Depends on:_ P0-3, P0-5
- **P0-7** (Code+Alex, S) Draft a one-page AKB letter for listing agents: cash purchase, contract assignable, $1,000 EMD ready to wire to title on execution. Alex signs it once from a card. Code attaches it whenever an agent asks for proof of funds.  
  _Why:_ Agents often ask for proof of funds on cash offers. The Kelly agreement shouldn't stall on it.  
  _Done when:_ The signed PDF is stored, and a test agent request gets it attached automatically.  
  _Depends on:_ none
- **P0-8** (Code+Alex, S) Write a one-page Michigan wholesaling and assignment note in the OHIO_SB155.md format (AI first pass: licensing thresholds, required disclosures, assignment rules). Email it to a Michigan real-estate attorney for the one paid hour.  
  _Why:_ No state review exists outside Ohio, and Kelly is in Michigan.  
  _Done when:_ akb-dashboard/docs/compliance/MICHIGAN.md exists with a date by 9/26, and the attorney's reply or booking is on the record, or the card records signing on the AI pass per the decision default.  
  _Depends on:_ none
- **P0-9** (Code, S) Confirm the title company named in the Kelly agreement (or ask the agent to name one) closes assignments. Record its published wire-verification phone number on the record.  
  _Why:_ The close needs title, and the EMD wire needs a known number to call.  
  _Done when:_ The title company's written 'yes, we close assignments' is in Gmail, and its published phone number is on rec7dDjzRQUE4KU0V.  
  _Depends on:_ P0-1
- **P0-10** (Code, M) Put the death rule in code, with one Dead-write helper. The clock runs from the counterparty's last message, no matter who owes the reply: 14+ days of counterparty silence on an unsigned deal means Dead. An executed contract never goes Dead this way; it gets a termination card. Runs daily.  
  _Why:_ The 9/23 ruling shouldn't need making twice, and every later Dead write should go through one place.  
  _Done when:_ Tests pass: counterparty silent 15 days while we owe the reply means Dead; silent 13 days means not Dead; executed contract means a termination card, not Dead. A dry run lists every record it would kill. The scoreboard card shows 'counterparty contact in last 14 days: N'. The first live run marks the dry-run list Dead.  
  _Depends on:_ none
- **P0-11** (Code, S) Add EMD_Outcome (wired / refunded / lost / n-a) to Listings_V1 and show a live 'EMD outstanding' total on the queue header. (Was P3-2.)  
  _Why:_ The $3,000 cap is a sentence today, not a number anyone can see.  
  _Done when:_ The queue header shows the correct sum on a test record, and the field exists on Kelly Rd.  
  _Depends on:_ none
- **P0-12** (Code, M) Extend the P0-10 helper: refuse Dead on a record with Contract_Executed_At unless Termination_Sent_At and EMD_Outcome are set. Route the ~12 direct Dead writers through it. Fix option-tripwire so the T-2 alert no longer swallows T-1. (Was P3-3.)  
  _Why:_ A signed contract must never vanish while its clocks run. This must merge before Kelly is signed.  
  _Done when:_ grep finds no direct Dead write outside the helper. Tests cover the refusal and the T-2, then T-1, then lapsed sequence.  
  _Depends on:_ P0-10, P0-11
- **P0-13** (Code, S) Show any wire-fraud red flag from the deal's threads, plus the title company's published phone number, on the EMD card. (Was P3-6.)  
  _Why:_ The warning appears at the moment Alex would wire.  
  _Done when:_ A test red flag and the verification number both render on a test EMD card.  
  _Depends on:_ P0-11
- **P0-14** (Code, S) When the Kelly agreement arrives, a Code session reads it from Gmail and posts a pre-sign checklist card with 6 lines, each with evidence: (1) a funded buyer's written yes under the P0-5 rule; (2) comps and a ceiling of at least $26,750; (3) the Michigan note on file; (4) EMD of $1,000 or less; (5) buyer is 'AKB Solutions LLC and/or assigns'; (6) inspection of 10+ days. Any red line makes the card's default 'walk politely'.  
  _Why:_ A manual checklist replaces the P3-1 build for Kelly, so the agent isn't kept waiting 1-3 weeks on our side.  
  _Done when:_ The card posts within 1h of the agreement landing in Gmail, with an evidence link on every line.  
  _Depends on:_ P0-3, P0-6, P0-8, P0-9
- **P0-15** (Alex, S) Alex signs the Kelly purchase agreement, within 3 business days of it arriving. If the checklist isn't green by then, Code sends a polite walk.  
  _Why:_ Signing stays his forever. The 3-day target stops a repeat of the Montrose wait.  
  _Done when:_ Contract_Executed_At is set within 3 business days of the agreement arriving with all 6 lines green, or the polite walk is sent and on the record.  
  _Depends on:_ P0-14, P0-12, P0-11
- **P0-16** (Alex, S) Alex wires the Kelly EMD ($1,000 or less) after confirming the wire details by phone on the title company's published number (EMD_WIRE_PROCEDURE.md).  
  _Why:_ Cash control with a human gate.  
  _Done when:_ EMD_Outcome = wired, and the outstanding total updates.  
  _Depends on:_ P0-15, P0-13, P0-9
- **P0-17** (Code, S) Give decision-escalation the same phone lookup with fallback (resolveOperatorPhone) that operator-page uses.  
  _Why:_ It finds 32 overdue money decisions every hour and has never sent one text.  
  _Done when:_ The next hourly audit row shows phone_configured:true and sent>0.  
  _Depends on:_ none
- **P0-18** (Code, S) Stop hiding open cards after 14 days in operator-actions and decision-feed-server. Show them as OVERDUE at the top, and auto-close cards whose record is Dead.  
  _Why:_ Age has been silently counted as resolution, and 6 open decisions are hidden now.  
  _Done when:_ 0 open rows are missing from the home queue, the Montrose card reckiAxkVEj9ClDLA is closed, and a test proves a 15-day-old open card renders.  
  _Depends on:_ none
- **P0-19** (Code, S) Reuse Pulse's email fallback in operator-alert/maverick-alert, sms-escalation and contract-watch.  
  _Why:_ These three senders are SMS-only; during the Quo lapse only Pulse's email reached Alex.  
  _Done when:_ A test alert from each of the three, sent with Quo forced to 402, arrives in Alex's email.  
  _Depends on:_ none
- **P0-20** (Code, S) Page by email on the first Quo 402 with 'credits empty, add credits'. Make vendor-health label a 402 as billing, not a vendor wobble. Poll the Quo balance if their API exposes it.  
  _Why:_ Texting is the whole seller channel, and it went dark with no warning.  
  _Done when:_ A simulated 402 produces an email with the billing wording, and vendor-health shows 'billing' for it.  
  _Depends on:_ P0-19
- **P0-21** (Code, M) Put the existing auth waterfall on dispose-listing, seed-sweep, buyers/import-csv and the ~9 GET ?apply=1 routes. Make the migrate-dd-checklist secret check an exact, timing-safe compare. Add a CI check that fails unguarded write routes.  
  _Why:_ The repo is public and Vercel protection is off, so one anonymous request could kill Kelly Rd.  
  _Done when:_ A script calling each route without credentials gets 401 on all of them, the same calls with a dashboard session still work, and a test PR with an unguarded route fails CI.  
  _Depends on:_ none
- **P0-22** (Code, S) Measure the last 30 days of GitHub Actions minutes by workflow. Post one card: expected monthly cost if the repo goes private, and a recommended spending limit.  
  _Why:_ Private repos use metered minutes. If jarvis-send, maverick-alert or CI stop on a limit, that silently repeats the 70-hour blackout.  
  _Done when:_ The card shows minutes per workflow, the expected monthly cost, and a default limit.  
  _Depends on:_ none
- **P0-23** (Code+Alex, S) On Alex's yes, make the GitHub repo private through the API and set the spending limit he chose. Add a minutes-remaining line to the P0-26 meter with an alert at 80%.  
  _Why:_ The pricing formulas, rulings, Alex's cell number and base IDs are readable by anyone.  
  _Done when:_ An unauthenticated API call to Golf4Life27/coach-pulse returns 404. After the flip, a jarvis-send dispatch and a maverick-alert dispatch both succeed and CI runs green on the next push. The meter shows minutes remaining.  
  _Depends on:_ P0-22
- **P0-24** (Code, S) Write the Birmingham close-out onto the record (termination sent 9/22 18:01Z and acknowledged; EMD never wired, $0), close its cards, and delete the Birmingham check routine.  
  _Why:_ The record never captured the outcome, so sessions keep re-raising it.  
  _Done when:_ Verification_Notes cites the Gmail thread, and no Birmingham card or routine remains.  
  _Depends on:_ none
- **P0-25** (Code, S) Keep triage and engine-drive on their hourly schedule, but make step one a call to a new cheap state-hash route (new inbound, open cards, send-lane state, credit status, new Alex messages, 'send assignment' flags). If the hash is unchanged, the session exits after that one call. If any routine is bound to the top tier, post a one-tap card to switch it (the trigger tool needs Alex's own request to change a model).  
  _Why:_ Stops paid hourly re-narration of an unchanged state without slowing seller replies.  
  _Done when:_ A quiet day logs at most 1 full triage session. A test seller reply sent at a random hour is drafted within 1h. The routine list shows no top-tier bindings, or an open switch card.  
  _Depends on:_ none
- **P0-26** (Code, M) Build a minimal spend meter. Once a day, Code reads Anthropic and vendor receipts from Gmail plus GitHub Actions minutes, and posts a month-to-date total on the scoreboard card. The brake lives in the daily build-brief step: it checks the total first and refuses to start new worker sessions once the cap is passed, posting one card.  
  _Why:_ The spend kill criteria can't be enforced without a number. (A cut-down version of P5-4.)  
  _Done when:_ The scoreboard card shows month-to-date spend by vendor with its source. A test with the cap set to $1 refuses a brief and posts the card. If Anthropic bills only monthly, the Claude line is labeled 'estimate' with its method.  
  _Depends on:_ none
- **P0-27** (Code, S) Add a PreToolUse hook (a check that runs before a tool call) in user-level Claude settings. It refuses create_trigger, update_trigger or send_later when the target is a top-tier session, repeats more often than hourly, or is a send_later made by a routine-fired session (self re-arming).  
  _Why:_ The $7,296 session was another project, so a repo-only hook would not have caught it.  
  _Done when:_ A test trigger created from a session outside this repo is blocked. If cloud sessions don't share user settings, a card says so and the P0-26 brake is recorded as the backstop.  
  _Depends on:_ none
- **P0-28** (Code, S) Commit this plan as akb-dashboard/docs/PLAN.md. Stamp 'SUPERSEDED by akb-dashboard/docs/PLAN.md (2026-09-23)' on line 1 of akb-dashboard/docs/specs/AKB_MASTER_CHECKLIST.md, akb-dashboard/docs/specs/V1_Roadmap_to_100.md, akb-dashboard/docs/specs/AKB_RealEstateTech_Gap_Analysis_v1.md, and at the next-steps section of akb-dashboard/docs/business/AKB_V1_BUSINESS_PLAN.md. Add one line to akb-dashboard/docs/handoffs/OPERATING_MAP.md naming the home queue as the one place to decide, and point akb-dashboard/docs/handoffs/NEXT_SESSION_DIRECTIVE.md at PLAN.md.  
  _Why:_ One plan, not five, so sessions stop building from dead documents.  
  _Done when:_ PLAN.md exists, each old doc carries the stamp, OPERATING_MAP names the home queue, and NEXT_SESSION_DIRECTIVE points to PLAN.md.  
  _Depends on:_ none

## P1 — Every live counter gets a real number and an answer; decisions can't rot

**Window:** 2026-09-24 to 2026-10-07  
**Goal:** Every counter whose other side has spoken in the last 14 days is priced from real comps and answered. Alex rules once on standing limits. Every card has a deadline and a default. Critical alerts no longer depend on a routine session.  
**Exit:** Every counter whose last counterparty message is under 14 days old has 3+ sold comps and a reply dated after 9/23, or is Dead. The Deal Envelope ruling is on the spine. Every new card shows an 'auto-acts at' time, and none sits past its deadline without its default or a second-channel page. The accepted-silence canary has paged Alex by SMS and email. With every routine paused, a vendor 401, a Quo 402 and a send-lane trip each page Alex within 1h, and a dead paid vendor re-pages at 6h.

- **P1-1** (Code, M) Find and fix why engaged counters return 'no comp set' even though Detroit has free county data and RentCast is mostly unused (start with 19593 Annott).  
  _Why:_ This one bug blocks every live counter.  
  _Done when:_ Every live counter has 3+ stored sold comps from the last 12 months, or a named reason it can't.  
  _Depends on:_ none
- **P1-2** (Code, S) Send negotiation-stage comp pulls through the RentCast live lane first, and make Offer Accepted first in auto-underwrite, triggered on the status change.  
  _Why:_ The records closest to money are served last today.  
  _Done when:_ Flipping a test record to Offer Accepted starts an underwrite within 10 minutes.  
  _Depends on:_ none
- **P1-3** (Code, M) Make 'ARV disagrees with its own comps' a hard HOLD in decision-math and in the confidence label, and add the size-adjusted price-per-sqft guard.  
  _Why:_ Annott shows GO/HIGH on an ARV 2.2x its own comps. A wrong GO leads to a contract nobody will buy.  
  _Done when:_ Annott recomputes to HOLD, HIGH requires both enough comps and agreement, and a test with a 25% size gap holds.  
  _Depends on:_ none
- **P1-4** (Code+Alex, S) If P1-1 misses by 9/27, post one PropStream card (per the laptop decision) naming the live counters still without comps, and ingest the pulls.  
  _Why:_ A bounded last resort, not a standing chore.  
  _Done when:_ Either P1-1 succeeded, or the card posted and every named record shows a comp set, or the card's default (walk) ran.  
  _Depends on:_ P1-1
- **P1-5** (Alex, S) Alex rules the Deal Envelope once (see Decisions): price, EMD, inspection, close, assignability, funded-buyer rule and counter band.  
  _Why:_ Standing limits replace a separate judgment call on every deal.  
  _Done when:_ A spine ruling records the exact numbers.  
  _Depends on:_ none
- **P1-6a** (Code, S) Add options, a default and an 'auto-acts at' deadline to the card schema, and use it in the Operator_Action_Items producer.  
  _Why:_ A decision with no clock is how deals rot.  
  _Done when:_ New cards from that producer carry all three fields, and the type check refuses a card without them.  
  _Depends on:_ none
- **P1-6b** (Code, M) Move the other card producers (reply-alert, accepted-silence, contract-lifecycle HOLD cards, decision-queue, brief cards) onto the new schema.  
  _Why:_ Every card that reaches Alex needs the same three fields.  
  _Done when:_ For 48h, 100% of new cards across all producers carry options, a default and a deadline.  
  _Depends on:_ P1-6a
- **P1-6c** (Code, S) Add a timeout cron. When a deadline passes it runs the safe default (hold, ask a question, counter at the ceiling, walk from an unsigned deal) and logs default_executed. Signing, wiring, executing and terminating never auto-run; those re-page by SMS and email instead.  
  _Why:_ Being away for a few days can no longer stall a deal.  
  _Done when:_ Tests prove safe defaults run and unsafe ones only re-page. default_executed rows appear in the audit.  
  _Depends on:_ P1-6a
- **P1-7a** (Code, S) Acceptance autopilot: an acceptance inside the Envelope gets a same-day contract request behind a 4h veto card.  
  _Why:_ Turns Montrose's 20-day wait into a same-day reply.  
  _Done when:_ Replaying the Montrose and Kelly acceptances in a dry run sends the request within 4h, and each send passes validateReplyDraft.  
  _Depends on:_ P1-5, P1-6a
- **P1-7b** (Code, S) Counter band: a counter within 10% over the ceiling gets one counter at the ceiling after 24h; more than 10% over gets a polite pass and is parked.  
  _Why:_ Counters are the decision that reaches Alex most often.  
  _Done when:_ A dry run on 3 past counters produces the expected action, and every send passes validateReplyDraft.  
  _Depends on:_ P1-3, P1-5
- **P1-7c** (Code, S) No comps: the reply asks condition questions only (through the DD-volley), never a number.  
  _Why:_ We can't safely name a price without a ceiling.  
  _Done when:_ A test counter with no comps produces a question with no dollar figure, and a guard test fails any draft that contains one.  
  _Depends on:_ P1-5
- **P1-8** (Code, S) Make accepted-silence write an audit row every run, and add a permanent canary record that must page every 48h. A missed canary raises its own alert.  
  _Why:_ The watchdog built for Montrose has never proven it pages.  
  _Done when:_ The canary page arrives by SMS and email, and an accepted_silence_paged row exists.  
  _Depends on:_ P0-19
- **P1-9** (Code, S) Find why reply-alert never fires (suspect scan-comms' created>0 gate) and fix it.  
  _Why:_ Ordinary seller replies never become one-tap cards.  
  _Done when:_ A real qualifying reply produces a reply_alert_sent row within 10 minutes.  
  _Depends on:_ none
- **P1-10** (Code, S) Answer every open counter whose last counterparty message is under 14 days old, under the Envelope rules. In metros with zero funded buyers, send no card to Alex: hold the price, ask condition questions, check buyers for 72h, then walk politely.  
  _Why:_ Live counters are waiting on us, the same shape that killed Montrose. Older ones are already Dead under P0-10.  
  _Done when:_ Each such counter has an outbound reply dated after 9/23, or is Dead with a reason.  
  _Depends on:_ P1-1, P1-5, P1-7b, P1-7c, P0-10
- **P1-11** (Code, S) Stop marketing drips and other non-counterparty writes from flipping a Dead record back to live. Only a real counterparty reply can revive it.  
  _Why:_ A realty drip keeps resurrecting rec2hOsEpIyOoZD66.  
  _Done when:_ rec2hOsEpIyOoZD66 stays Dead through the next drip, and a test shows a genuine seller reply still revives a record.  
  _Depends on:_ P0-10
- **P1-12** (Code, M) Move vendor 401/402 and send-lane-tripped alerts onto native Vercel crons. Make jarvis-send respect the send-lane breaker, and make maverick-alert go straight to email while the breaker is tripped. (The send-lane and vendor part of old P5-5.)  
  _Why:_ The most important pages shouldn't depend on a routine session remembering to fire.  
  _Done when:_ With every routine paused, a simulated vendor 401, Quo 402 and send-lane trip each page Alex within 1h, and a test shows the breaker blocks jarvis-send.  
  _Depends on:_ P0-19
- **P1-13** (Code, S) Stop Pulse marking a vendor 'fixed' when its window merely goes quiet, and re-page an unresolved dead paid vendor every 6h by SMS and email. (Was P5-3.)  
  _Why:_ The ATTOM alert kept flapping, and nothing forced action.  
  _Done when:_ A test outage with a quiet 6h window stays open and re-pages at 6h on both channels.  
  _Depends on:_ P0-19
- **P1-14** (Code, S) Turn each spine 'finding that needs code' into a GitHub issue, re-check it against current main before carrying it, and close it when the code changes. (Was P5-7.)  
  _Why:_ Findings get re-typed for days, some already fixed and some never.  
  _Done when:_ The carried list in the latest spine entry equals the open finding issues, and the stale STOP-matcher and log-echo items are closed with the commits that fixed them.  
  _Depends on:_ P0-23

## P2 — Buyer before signature

**Window:** 2026-09-26 to 2026-10-10  
**Goal:** Funded buyers exist in Detroit and Memphis, and pre-selling runs by itself for any accepted deal, with the address protected.  
**Exit:** At least 3 buyers with proof of funds in focus metros, at least 1 with a recorded written yes at price on a live deal. The teaser and address gate have fired automatically on at least 1 acceptance. The blast flag is on. A title company is lined up for each metro with a live accepted deal.

- **P2-1** (Code, M) Ask for a proof-of-funds letter in drip steps 2 and 3. Add a POF upload to the buyer intake form that sets Proof_of_Funds_On_File. Capture POF from replies automatically, with a source note.  
  _Why:_ 1 of 125 buyers is verified, and that is what killed Birmingham.  
  _Done when:_ The new copy is live, and a test upload plus one real reply each flip the checkbox.  
  _Depends on:_ none
- **P2-2** (Code, S) Backfill buy-box fields (Max_Price, ZIPs) by re-running buy-box capture over existing buyer notes.  
  _Why:_ Buyers who already stated their box score as unscreened.  
  _Done when:_ Clarance and every drip replier with a stated box show filled fields.  
  _Depends on:_ none
- **P2-3** (Code, M) Check whether the Wayne County deed ledger records the buyer (grantee). If it does, add repeat cash buyers in 48224 and nearby ZIPs, with the deed as evidence.  
  _Why:_ A recent cash purchase is free proof of funds.  
  _Done when:_ 10 or more deed-evidenced Detroit buyers are added, or a spine note says there is no grantee field.  
  _Depends on:_ none
- **P2-4** (Code, S) Point the daily buyers-build routine at Detroit and Memphis only, using property managers and REIAs (local real-estate investor clubs), which yield email addresses.  
  _Why:_ Build buyers where we can close.  
  _Done when:_ 80% of the week's new rows are in focus metros and have an email.  
  _Depends on:_ none
- **P2-5** (Code, M) Fire the P0-5/P0-6 teaser and address gate automatically on any acceptance inside the Envelope. Recipients go in buildBuyerShortlist order.  
  _Why:_ Sell before we sign, without handing buyers the address or the listing agent.  
  _Done when:_ A test acceptance triggers the teaser with no human step, the send order matches the shortlist ranking, and the address stays gated.  
  _Depends on:_ P1-7a, P0-5
- **P2-6** (Code, M) Launch the JV lane (co-selling with other wholesalers): find 10 active wholesalers per focus metro from public sources, email a fee-split offer, and tag them Source=JV.  
  _Why:_ Other wholesalers' funded buyers are the fastest free buyer pool.  
  _Done when:_ 20+ JV contacts are logged, and replies are tracked on one card.  
  _Depends on:_ none
- **P2-7** (Code+Alex, S) Post one dry-run buyer-blast preview card. On Alex's yes, set DISPO_BLAST_LIVE=true. The blast uses the address gate and shortlist order.  
  _Why:_ The automatic buyer blast has never fired once.  
  _Done when:_ The flag is true, and the next executed contract logs dispo_blast_fired with the address withheld.  
  _Depends on:_ P0-5
- **P2-8** (Code, S) When a buyer's email says yes at a price with POF attached, write the buyer, price, date and POF link onto the deal record and post one card.  
  _Why:_ The signing checks need a recorded, checkable yes, not a memory of an email.  
  _Done when:_ A test email writes the fields, and the P0-14 checklist and P3-1 gate both read them.  
  _Depends on:_ P0-5
- **P2-9** (Code, S) Show each counter's funded-buyer count on its existing card ('can close' / 'no buyer').  
  _Why:_ The buyer rule is visible before anyone signs.  
  _Done when:_ Every live counter card shows the count.  
  _Depends on:_ none
- **P2-10** (Code, S) For each metro with a live accepted deal outside Detroit (Memphis first), line up a title company that closes assignments and record its published wire-verification number.  
  _Why:_ The next contract needs title, and the wire needs a known number.  
  _Done when:_ The title company has confirmed in writing, and its contact is on the record.  
  _Depends on:_ none

## P3 — Every contract after Kelly signs through a coded gate

**Window:** 2026-09-30 to 2026-10-14  
**Goal:** If Kelly dies, the next accepted deal signs through a coded gate instead of a hand checklist, with one EMD gate and every clock visible.  
**Exit:** The 'Mark contract executed' gate refuses a Birmingham-like record. No route reads the Deals table for EMD. The next executed contract (if Kelly didn't close) has a named funded buyer, EMD of $1,000 or less recorded, and a state note on file.

- **P3-1** (Code, M) Gate 'Mark contract executed': a recorded funded-buyer yes in the metro, comps no older than 14 days that pass the own-comps check, a state note on file (Ohio: signed SB155 disclosure), and total EMD outstanding of $3,000 or less. Override needs a written reason.  
  _Why:_ The one button that starts contract clocks checks nothing today.  
  _Done when:_ A Birmingham-like test record is refused with every reason listed, and an override reason is saved.  
  _Depends on:_ P1-3, P0-11, P2-8
- **P3-2** (Code, M) Retire request-emd, pre-emd-evaluate and pre-emd-state, which need a Deals row no live deal has. Port the DD-1..9 checks worth keeping into P3-1, reading Listings_V1; delete the rest.  
  _Why:_ A route that looks like the EMD gate but always returns 404 invites someone to bypass it by hand.  
  _Done when:_ No route or card reads the Deals table for EMD, and P3-1's tests cover every DD check that was kept.  
  _Depends on:_ P3-1
- **P3-3** (Code, M) Build the automatic contract review card: read the agent's purchase agreement from Gmail and post 6 lines (price, EMD, inspection days, close date, assignable yes/no, buyer entity) plus red flags.  
  _Why:_ Alex should spend 2 minutes reviewing, not 30. Kelly's was done by hand in P0-14.  
  _Done when:_ A test agreement produces the card within 1h of arriving.  
  _Depends on:_ none
- **P3-4** (Code+Alex, S) Write the state note for the next contract's state (Tennessee first, for Memphis) in the OHIO_SB155.md format: AI first pass, one attorney hour, Alex signs off on a card.  
  _Why:_ A state-law surprise can undo the deal.  
  _Done when:_ akb-dashboard/docs/compliance/TENNESSEE.md exists with a review date, and P3-1 reads it.  
  _Depends on:_ none
- **P3-5** (Alex, S) Alex signs the next purchase agreement (if Kelly didn't close).  
  _Why:_ Signing stays his, forever.  
  _Done when:_ Contract_Executed_At is set, and the P3-1 gate passed or an override is logged.  
  _Depends on:_ P3-1, P3-2, P3-3, P3-4, P2-8, P2-10, P0-11, P0-12
- **P3-6** (Alex, S) Alex wires EMD of $1,000 or less after confirming the wire details by phone on the title company's published number.  
  _Why:_ Cash control with a human gate.  
  _Done when:_ EMD_Outcome = wired, and the outstanding total updates.  
  _Depends on:_ P3-5, P0-13, P2-10

## P4 — Assign and collect the first fee

**Window:** From the first signing (about 2026-10-01) to 2026-11-07  
**Goal:** The funded buyer signs the assignment, title closes, and the fee shows up in the ledger by itself.  
**Exit:** Fee received, confirmed by Alex on one card, and visible in /api/agents/ledger/summary as 1 closed deal with the real fee.

- **P4-1** (Code+Alex, M) Build one Assignment of Contract template (assignor AKB, assignee, fee, property, buyer's non-refundable deposit to title), filled from the listing and buyer records, after one attorney review of the wording.  
  _Why:_ The step that earns the fee has no document at all.  
  _Done when:_ The template produces a correct PDF for a test record, and the approval is on the spine.  
  _Depends on:_ none
- **P4-2** (Code, M) Alex's 'pick winning buyer' tap writes a 'send assignment' flag. The P0-25 state-hash wakes a session that has the DocuSign connector; it sends the envelope with createEnvelope and the P4-1 PDF attached. The buyer deposit uses the amount Alex set (default $2,500).  
  _Why:_ A dashboard tap runs on Vercel and can't call the session-only DocuSign connector, so the tap hands off through a flag.  
  _Done when:_ A test tap produces a sent envelope within 2h, reaching a test inbox with signature tabs for Alex and the buyer.  
  _Depends on:_ P4-1, P0-25
- **P4-3** (Code, S) Point the ledger at Listings_V1 fee fields, delete the 3 stale Deals rows (including the phantom Closed row), and count a deal as closed only when its fee is above $0.  
  _Why:_ The first fee must show as revenue, not $0.  
  _Done when:_ The ledger shows 0 closed today, and a test fee on a Listings_V1 record appears in the summary.  
  _Depends on:_ P3-2
- **P4-4** (Code, M) Coordinate title by email: send the agreement and the assignment, track the close date, read the settlement-statement email, and write Wholesale_Fee, Closed_At and the closed stage. Cards go to Alex only for exceptions.  
  _Why:_ Alex doesn't chase paperwork, and revenue records itself.  
  _Done when:_ A fake settlement email in a dry run writes the fee, and title confirms a closing date in writing on the live deal.  
  _Depends on:_ P4-3
- **P4-5** (Alex, S) Alex signs the assignment.  
  _Why:_ Signing stays his.  
  _Done when:_ The envelope shows both signatures completed, and title confirms the buyer's deposit.  
  _Depends on:_ P4-2
- **P4-6** (Alex, S) Alex confirms on one card that the fee hit the bank.  
  _Why:_ Money in the bank is the milestone.  
  _Done when:_ A spine revenue row exists and matches the ledger.  
  _Depends on:_ P4-4, P4-5

## P5 — After the first fee: nothing single-threaded, then prove 30 days unattended

**Window:** Starts after the first fee (about 2026-11-07); 30-day test to about 2026-12-31  
**Goal:** Any one vendor, cron or absent person failing becomes one queue card within an hour. Then pass a 30-day test where Alex only taps and signs. The off-market pilot starts early only if the 10/14 kill criterion trips and Alex says yes.  
**Exit:** The game-day drill passes: Quo 402, ATTOM 401, a dead Pulse cron, 72h with no taps, and an Airtable 429 each handled automatically within 1h. Then 30 straight days with only taps and signatures from Alex, no card past its deadline without its default or a second-channel page, and at least 3 deals decided by rules alone.

- **P5-1** (Code, S) Add an outside dead-man switch: an uptime service that Pulse and the top 5 crons must check in with, which emails Alex if they go quiet.  
  _Why:_ Nothing watches the watcher today.  
  _Done when:_ Pausing Pulse in a test produces an email within 2h.  
  _Depends on:_ none
- **P5-2** (Code, S) Add retry with backoff on 429 and 5xx to the shared Airtable read and write path.  
  _Why:_ 79 crons share one base with a 5-requests-per-second limit.  
  _Done when:_ A simulated 429 retries and succeeds.  
  _Depends on:_ none
- **P5-3** (Code, S) Schedule the ARV backtest and ARV sanity audit weekly, as one summary card.  
  _Why:_ Price drift gets caught by a schedule, not by memory.  
  _Done when:_ The first weekly card appears.  
  _Depends on:_ none
- **P5-4** (Code, S) Extend the P0-26 meter into a weekly cost card by vendor (Anthropic, Quo, Vercel, Airtable, RentCast, ATTOM, Firecrawl, PropStream, DocuSign, GitHub Actions), using the existing RentCast/ATTOM dollar tracking.  
  _Why:_ Unit economics need a real monthly cost by vendor.  
  _Done when:_ The card shows a monthly total by vendor.  
  _Depends on:_ P0-26
- **P5-5** (Code, M) Add free county-deed comp sources for the next metros with deals (Shelby TN first, then Jefferson AL and Lucas OH).  
  _Why:_ One dead vendor key shouldn't stop pricing everywhere.  
  _Done when:_ Each county returns comps into the waterfall in a live test.  
  _Depends on:_ none
- **P5-6** (Code, S) Make the inbound SMS webhook accept its secret only in a header, record the dated 10DLC texting-registration status for both Quo numbers, and add a monthly re-check card.  
  _Why:_ Close the leak path, and don't let a lapsed registration silently block texts.  
  _Done when:_ A ?secret= request is refused, and SYSTEM_FACTS shows a dated status for both numbers.  
  _Depends on:_ none
- **P5-7** (Code, S) Auto-archive ZIPs after 3 straight runs that produced nothing, with a 60-day grace for new ZIPs.  
  _Why:_ Stop spending on dead ZIPs.  
  _Done when:_ The 42 proposals are archived, and a new ZIP inside its grace period is not.  
  _Depends on:_ none
- **P5-8** (Code, S) Backfill reply classification on the 364 unclassified threads.  
  _Why:_ See where threads die.  
  _Done when:_ Fewer than 10% of threads are unclassified.  
  _Depends on:_ none
- **P5-9** (Code, M) Scan the full git history with gitleaks and add it to CI. Code rotates every key it can through vendor APIs. For portal-only keys, the card asks only 'revoke key X: yes/no'; the default is revoke and don't replace, unless a live item needs that vendor. A replacement must reach Code without pasting (for example a vendor email Code reads from Gmail); if no such path exists, the card says so.  
  _Why:_ The repo was public for months and two keys have leaked before. Alex never handles a secret.  
  _Done when:_ The scan report is on the spine, every finding is rotated or carded, and CI fails on a planted fake secret.  
  _Depends on:_ P0-23
- **P5-10** (Code+Alex, S) Code checks 20 dry-run auto-answer drafts against validateReplyDraft and posts one yes/no card. On yes, turn on REPLY_AUTO_ANSWER_LIVE for seller-costs, offer-format and identity questions.  
  _Why:_ Takes routine questions out of Alex's queue without asking him to read drafts.  
  _Done when:_ The flag is live, and the first 20 live auto-answers pass the guard.  
  _Depends on:_ none
- **P5-11** (Code, S) Fix the dashboard last-seen ping, and alert if it goes more than 24h stale.  
  _Why:_ Escalation can't tell whether Alex is away.  
  _Done when:_ Opening the dashboard updates last-seen within 5 minutes.  
  _Depends on:_ none
- **P5-12** (Code, S) Add one scoreboard tile to the existing dashboard home: overdue cards, hours a line was dark, vendor incidents, manually started sessions, month's spend, fees to date.  
  _Why:_ One place to see whether the system ran without Alex.  
  _Done when:_ The tile renders on the home page with live numbers.  
  _Depends on:_ P0-26
- **P5-13** (Code, S) Run the game-day drill: Quo 402, ATTOM 401, dead Pulse cron, 72h with no taps, Airtable 429.  
  _Why:_ Proves each failure becomes one card within an hour.  
  _Done when:_ All 5 failures are handled within 1h, recorded on the spine.  
  _Depends on:_ P5-1, P5-2, P1-12, P1-13
- **P5-14** (Code, S) Run the 30-day unattended test.  
  _Why:_ Proves Alex only decides and signs.  
  _Done when:_ A 30-day window passes every check on the P5-12 tile.  
  _Depends on:_ P5-12, P5-13
- **P5-15** (Code, S) Write a TCPA/DNC one-pager for contacting owners directly. TCPA is the federal telemarketing law; DNC is the Do Not Call list.  
  _Why:_ Cold contact with homeowners carries far more legal risk than texting listing agents. Needed only if the off-market pilot is approved.  
  _Done when:_ The doc is in akb-dashboard/docs/compliance/ with a review date.  
  _Depends on:_ none
- **P5-16a** (Code, S) Off-market pilot, step 1 (only after Alex's yes on the pilot decision): get one tax-delinquent or absentee list for one focus metro and run it through the intake filter and pricer.  
  _Why:_ Buyers route around listed homes, and off-market fees run 3-5x higher.  
  _Done when:_ 200+ owner records are priced or held, with contact data attached where the approved source provides it.  
  _Depends on:_ P5-15
- **P5-16b** (Code, S) Off-market pilot, step 2: write first-touch copy for mail or email and send it within the approved budget.  
  _Why:_ Test whether owners reply at a better rate than agents.  
  _Done when:_ 200+ owners contacted, spend inside the cap.  
  _Depends on:_ P5-16a
- **P5-16c** (Code, S) Off-market pilot, step 3: track replies on the queue with the same classifier and counter rules.  
  _Why:_ The pilot is only useful if the replies get worked.  
  _Done when:_ Every reply shows as a card or an automatic answer, and a weekly reply-rate line is on the scoreboard.  
  _Depends on:_ P5-16b

## P6 — Make it sellable

**Window:** After the 30-day test passes (2027-01 onward)  
**Goal:** Another operator could stand it up from the docs, without Alex's accounts or identity.  
**Exit:** A fresh Vercel project, Airtable base and Claude account come up from the runbook in a dry run and run one triage cycle, with no Alex-specific fallbacks.

- **P6-1** (Code, S) Generate .env.example from the process.env variables the code actually reads, and add a CI drift check.  
  _Why:_ Only 11 of 171 variables are documented.  
  _Done when:_ CI fails when a new variable is undocumented.  
  _Depends on:_ none
- **P6-2** (Code, M) Remove the hard-coded fallbacks to Alex's email, phone and base ID, so a missing setting fails at startup.  
  _Why:_ A missing setting silently falls back to Alex today.  
  _Done when:_ grep finds 0 fallbacks, and an unset variable fails at boot.  
  _Depends on:_ P6-1
- **P6-3** (Code, M) Merge markets.json and expansion-metros.json into one registry, and seed buyer-side pricing data for metros with closed deals.  
  _Why:_ Two market lists disagree.  
  _Done when:_ The pricer and sourcing read one file.  
  _Depends on:_ none
- **P6-4** (Code, M) Tag every admin route and cron keep or delete by its last run date, delete the dead ones, and update the AS_BUILT cron and flag tables and the discovery-sweep header.  
  _Why:_ 203 routes and 79 crons with no map, and docs that contradict the live system.  
  _Done when:_ The inventory exists, deletions are merged, and the AS_BUILT numbers match vercel.json.  
  _Depends on:_ none
- **P6-5** (Code, S) Delete the dead match-to-deal route and its hard-coded 4-state filter.  
  _Why:_ Dead code with a bug that would give a false 'zero buyers' if anyone wired it up.  
  _Done when:_ The route is gone and nothing references it.  
  _Depends on:_ none
- **P6-6** (Code, M) Write the runbook for recreating the routines, bindings and vendor accounts from scratch.  
  _Why:_ The decision brain is tied to Alex's account and laptop.  
  _Done when:_ The runbook exists in akb-dashboard/docs/runbooks/ and lists every account, binding and setting in order.  
  _Depends on:_ P6-2
- **P6-7** (Code+Alex, M) Test the runbook once on a fresh Vercel project, Airtable base and a second Claude account (Alex approves creating the account on one card).  
  _Why:_ A runbook nobody has run is a guess.  
  _Done when:_ The second setup runs a full triage cycle.  
  _Depends on:_ P6-6
- **P6-8** (Code+Alex, S) Set up DocuSign server credentials. Code prepares everything; Alex clicks the consent link once. If the integration key can only be made in DocuSign's admin console, the card says so and asks whether to keep the session-connector path (default: keep).  
  _Why:_ Unattended envelope sends from a cron, not only from a session.  
  _Done when:_ docusignConfigured() returns true in production, or the card's 'keep session path' answer is recorded.  
  _Depends on:_ none
- **P6-9** (Code, M) Build contract auto-drafting (Forge) for the buyer side on top of the server credentials.  
  _Why:_ Removes the last hand-built document.  
  _Done when:_ A cron-sent test envelope lands in a test inbox.  
  _Depends on:_ P6-8
- **P6-10** (Code, S) Build the cross-record ratio detector (opener-to-list or opener-to-MAO drift across the last 3+ priced records) as a scheduled check.  
  _Why:_ No prose-only pricing rule.  
  _Done when:_ A test drift triggers a HOLD.  
  _Depends on:_ none
- **P6-11** (Code, S) Ship the funnel-snapshot route or remove the simulated Funnel tab, and label llm_costs as an estimate in the API response.  
  _Why:_ No fake numbers where an investor would look.  
  _Done when:_ No tab or field shows unlabeled or simulated data.  
  _Depends on:_ none

## Gaping holes

1. **It has never produced a dollar** Automating a process that has never worked once by hand has no value yet. Contract to close is 0 for 2.  
   _Evidence:_ Only 2 Listings_V1 records ever had Contract_Executed_At: Houston 3123 Sunbeam (dead since July) and Birmingham 1005 2nd St (terminated 9/22). No Pipeline_Stage=closed anywhere. Spine recnmCDflZ43MEsDp is the zero-revenue diagnosis. (product-3)
2. **Decisions rot on Alex's desk, and the alarms that should catch that are broken** A 'yes' dies if nobody answers it. Montrose died exactly this way.  
   _Evidence:_ Montrose: accepted $55,750 on 9/1. The agent asked 'will this work?' on 9/3, the ruling came 10 days later, and the revised terms sat unsent 9 more days (spine reclKuvb2ZlGTL09O). decision-escalation shows phone_configured:false, due 32, sent 0 every hour (operator-1). The queue hides open items older than 14 days, including the Montrose card reckiAxkVEj9ClDLA (operator-2). accepted-silence and reply-alert have zero audit rows (outreach-2, operator-5).
3. **No funded buyers** An assignment fee needs someone to buy the contract. With no funded buyer, every signature is a liability.  
   _Evidence:_ 1 of 125 Buyers rows has proof of funds (Ebony Ellis, Memphis). 104 of 125 have no price or ZIP box. Birmingham was terminated with '0 funded Birmingham buyers of 9 emailable' (dispo-4, product-4).
4. **Live counters are priced blind, and one shows a false GO** You can't accept, counter or walk safely without a real ceiling. A wrong GO means a contract nobody will buy.  
   _Evidence:_ 90 of 99 Negotiating/Counter records are NEEDS_DATA/HOLD_LOW_CONF. ATTOM has returned 401 for 46+ hours. RentCast is throttled by our own limit with about 94% of quota unused. 19593 Annott shows GO/HIGH on a $151,853 ARV; its own 74 comps have a median of $68.65/sqft and a max of $107.98/sqft (valuation-1, valuation-2).
5. **It only sources the weakest lane: on-market MLS listings** Buyers can call the listing agent directly and cut us out. Fees are thin, and the off-market lane is three empty stub files. The first fee still depends on this lane.  
   _Evidence:_ A buyer passed with 'It's listed so we aren't interested any more' (spine recKY2FfGkEq0cP0K). In off-market.ts every source returns is_credentialed:false and candidates:[]. The business plan puts on-market fees at about $3K vs $15-20K off-market (intake-1, intake-2).
6. **The paperwork that earns the fee doesn't exist** Even a perfect buyer match ends in Alex building documents by hand, and the revenue screen would still show $0 after a close.  
   _Evidence:_ No assignment-agreement code or template, and no envelope-create function in lib/docusign.ts (dispo-2, contracts-6). The ledger reads a Deals table with 3 stale rows that the contract code never writes to, including a phantom 'Closed' row with no fee (economics-1, economics-2). The EMD gate needs a Deals row that no live deal has (contracts-3).
7. **One vendor can take down the seller line and most of the alarms** When Quo credits ran out, outreach stopped, and so did two of the three ways the system pages Alex.  
   _Evidence:_ Quo 402 from 9/19 18:16Z to about 9/22 17:00Z, roughly 70 hours on both lines. operator-alert/maverick-alert, sms-escalation and contract-watch have no email fallback; Pulse's email fallback did get through. The 402 was reported as a 'vendor wobble'. There is no balance warning (reliability-1, operator-4, outreach-5, reliability-7).
8. **Public repo plus write routes with no login** Anyone who reads the public repo can find the routes that kill a deal, overwrite the buyer list or burn API budget.  
   _Evidence:_ The GitHub API returns private:false. dispose-listing, seed-sweep, buyers/import-csv and about 9 GET ?apply=1 routes have no auth. Vercel password, SSO and trusted-IP protection are all disabled (risk-1, risk-4, product-2).
9. **The button that signs a contract checks nothing, and Dead can hide a live contract** The highest-risk step, starting contract clocks, is one ungated click. Once a signed contract is marked Dead, its deadlines disappear from view.  
   _Evidence:_ contract-lifecycle/executed checks only auth, not-Dead and not-already-executed; there is no buyer or comp check (contracts-4, economics-3). About 12 Dead writers have no Contract_Executed_At guard. option-tripwire skips Dead records and swallowed the T-1 alert on Birmingham (reliability-3, contracts-7).
10. **Spend runs ahead of revenue, and nobody measures it** $13K of build spend against $0 revenue, with no running cost number and no control that stops a repeat.  
   _Evidence:_ $13,390 across 40 sessions; one session (a different project, Space Screens) spent $7,296 in 48h (SYSTEM_FACTS 6a). The tier rule is prose only. Quo, Vercel, Airtable, DocuSign and Firecrawl spend is untracked (economics-5, economics-9, reliability-8).

## What is genuinely good

- **Sourcing really does run itself.** About 14 crons find, filter, dedupe and file real listings with no Alex input, and they report why when they did nothing. listings-intake logs 'daily_crawl_budget_spent', and discovery-sweep writes live records every 2h.
- **Pricing refuses to guess.** mao-flip.ts has no list-price input, so the '$84.5k text on a $40k house' bug can't happen again. On the live book it chooses NEEDS_DATA/HOLD over inventing a number.
- **Replies and counters happen fast.** No-number probes got real counters back in 42-55 seconds (1100 Gulfport 'close to 80k', Annott '18,500'). Inbound volume is up about 4x since July.
- **Send safety is real engineering.** Quiet-hours gating, a 60-day recontact cooldown, sticky-number-only bumps, and a live thread re-check before every bump. Opt-outs are suppressed across every listing that shares the number (448 siblings found in one sweep).
- **The buyer drip is live and working.** 87 of 125 buyers carry an automated drip thread. Real buy-box replies (Florendo, Horn, Clarance, Lara) were captured and acknowledged automatically.
- **Honest self-reporting.** The spine and Pulse name dead vendor keys, their own blind spots and their own mistakes the same day. The business plan states its own downside case instead of guru math.
- **The compliance work that exists is careful.** The Ohio SB155 text is transcribed word for word from the statute. Excluded states are enforced in the intake filter's code. The Alabama intent-to-market notice was actually sent and logged with its Gmail id.
- **Much of the fix is already built.** The email fallback (Pulse), the phone fallback (operator-page), the ARV-vs-own-comps check, the buyer shortlist ranker, the blast engine and the PropStream seed route all exist. Much of this plan is wiring proven code into the right place, not new design.

## Stop doing

- Reviving any unsigned deal where the other side has been silent for 14+ days, even if we owed the last reply. Montrose, Birmingham and Houston are dead. No new spine entries about them.
- Adding ZIPs or metros. Pause frontier auto-staging; the current crawl and discovery sweep keep running as they are. More leads is not the constraint.
- Working the 2,911-record Review/Manual Review backlog before the first fee.
- Building the probate, tax and code-violation scrapers, the 12-metro landlord-lane configs, Buyer_Median_ZIP expansion or the Creative Lane doctrine before the first fee.
- DocuSign server credentials and Forge contract auto-drafting before the first fee. A session with the DocuSign connector sends the one assignment.
- Full narrative sessions when nothing changed. Routines check a state hash first and exit in one call. No routine or build on the top tier, and no session that re-arms itself.
- Re-typing the 'carried findings' list. Each finding becomes an issue, is re-checked against current code, and closes when the code changes.
- New dashboard pages, panels, alert surfaces or plan documents. The home queue is the only surface and akb-dashboard/docs/PLAN.md is the only plan.
- Sale-readiness work (env docs, route cleanup, identity fallbacks, merging market registries) before the 30-day unattended test.
- Sending Alex cards for counters in metros with zero funded buyers. Code handles those: hold price, ask about condition, check buyers for 72h, then walk politely.
- Signing any contract before a funded buyer has said yes in writing at the price.
- Giving a buyer a property address before they return the non-circumvention line.
- Treating 'RentCast is dead' as true. The limit is our own throttle.
- Relying on deleting Actions logs to protect seller data. Make the repo private instead.
- Calling or texting phone-only buyer rows before the first fee. Email and JV only.

## How it runs

ONE PLAN, ONE FILE: akb-dashboard/docs/PLAN.md (this plan, items P0-1 to P6-11). It supersedes akb-dashboard/docs/specs/AKB_MASTER_CHECKLIST.md, akb-dashboard/docs/specs/V1_Roadmap_to_100.md, akb-dashboard/docs/specs/AKB_RealEstateTech_Gap_Analysis_v1.md, and the next-steps section of akb-dashboard/docs/business/AKB_V1_BUSINESS_PLAN.md. Each gets a line-1 'SUPERSEDED' stamp (P0-28) and is never edited again. akb-dashboard/docs/handoffs/AS_BUILT.md stays as the record of what exists, not a plan. akb-dashboard/docs/handoffs/NEXT_SESSION_DIRECTIVE.md points to PLAN.md.

WHO DOES WHAT:
1. Worker sessions (execution tier) build every Code item. Each gets a written brief: item id, task line, done_when test, files involved, and 'do not touch' limits. One item per session. At most 3 run at once. Each ends in a PR that names the item id.
2. The top tier is used only for Alex's rulings (the decisions list, the Envelope wording) and a diff review on any PR that touches money, sends, pricing or auth.
3. Routines run on the execution tier or below. Triage and engine-drive keep their hourly schedule but exit after one state-hash call when nothing changed (P0-25). No session re-arms itself; the P0-27 hook and the P0-26 spend brake enforce this.
4. Alex only taps queue cards and signs. Every Alex or Code+Alex item is one card on the dashboard home queue, with a default and an 'auto-acts at' time. He never runs commands, reads logs or pastes secrets.

THE ORDER TODAY: the Kelly Rd fast lane (P0-1 to P0-16) goes first, on its own dates: contract request by 9/24 16:00Z, comps by 9/25 12:00Z, PropStream card the same day if needed, Alex's signature within 3 business days of the agreement arriving or a polite walk. The rest of P0 runs in parallel. After that, phases gate on their exit criteria, not dates.

THE HONEST BET: the first fee depends on the on-market lane, which this audit ranks weakest. The plan runs that lane with buyer-first rules and an address gate until 10/14. If it hasn't produced a signed contract with a committed funded buyer by then, the off-market pilot decision comes to Alex.

TRACKING: until the repo is private, P0 is tracked in PLAN.md checkboxes. After P0-23, every item becomes a GitHub issue labeled with its id and phase, and the issues are the source. A PR closes an issue only after a worker reruns done_when and pastes the evidence (an audit row, test output or record id). Once a day, the execution-tier routine regenerates PLAN.md checkboxes from issue state (nobody edits them by hand), runs the spend meter, and dispatches the next briefs if the brake allows. Twice a day the scoreboard card on the home queue refreshes: fees, live counters priced, counterparty contact in the last 14 days, funded buyers, overdue cards, month-to-date spend.

WEEKLY: each Monday, one top-tier session of about 30 minutes reads the scoreboard and rules only on the kill criteria below, writing one spine entry. No build work in that session. Nothing in P5 or P6 starts before the first fee, except the off-market pilot if 10/14 trips and Alex says yes.

## Kill criteria

9/26: if any data-changing route still answers without a login, all other build work except the Kelly fast lane stops until it's fixed.

Kelly Rd: if by 9/26 23:59Z there is no comp set from any source (P0-3 or PropStream), or the ceiling is under $26,750, walk politely that day. If the pre-sign checklist isn't all green within 3 business days of the agreement arriving, walk politely. After signing: if the buyer's written yes falls through with no replacement, Code drafts a written termination 2 days before the agreement's inspection deadline, Alex approves sending it, and EMD_Outcome is recorded.

Any unsigned deal: 14+ days with no message from the other side means Dead (P0-10). A signed contract is never killed by silence; it gets written termination inside its contingency window.

9/30: if fewer than 75% of live focus-metro counters (counterparty message under 14 days old) have a real comp set, the comp pipeline is broken and paid comps come to Alex as a decision.

10/7: if there are 2 or fewer funded buyers business-wide, JV becomes the default way to sell, and Code removes metros with zero funded buyers from the outreach cron's covered-ZIP list. Verified by the next outreach run's audit rows showing 0 sends in those metros.

10/14: if there is no signed contract with a committed funded buyer, the off-market pilot decision goes to Alex (default yes, $500 cap) and no new on-market metros are added.

10/23: if there is still no signed contract, freeze all build work except alarms and run an honest-advisor review of the model.

11/7: if no fee has been received, stop paid build sessions, run the machine in maintenance at $750/month or less, and Alex decides between pause and pivot.

12/31/2026: if no fee has ever closed, stop building. Alex chooses between running it by hand, selling the components, or shutting down.

Spend, before the first fee (measured by the P0-26 meter): if month-to-date Claude plus vendor spend passes $3,000, the daily build-brief step refuses new worker sessions and posts one card until Alex rules. If the meter shows more than $300 of Claude charges in one day (from receipts, or a labeled estimate), new briefs pause for that day and one card posts.

After the first fee: if the 30-day unattended test fails twice, 99% automation isn't reachable on this setup. Switch to an assisted model (a part-time VA works the queue) instead of more building.

