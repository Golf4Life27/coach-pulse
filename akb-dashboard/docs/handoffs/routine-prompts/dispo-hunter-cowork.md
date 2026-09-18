# MAVERICK 4 - Dispo hunter (Cowork scheduled task, runs on the operator's computer)

Why this one lives in Cowork and not in the cloud: Facebook group posting has to come from the operator's own logged-in browser, at a human pace, or the account gets restricted. The cloud routines have no browser session. So this is a Cowork **scheduled task** on the operator's computer (Claude Desktop, Code tab, Routines, New routine, choose **Local**), daily, at an hour that computer is normally on, awake, and signed in with Chrome open. Mac or Windows both work (Claude Desktop 1.1.5368 or newer). Created once by the operator; after that it runs without him.

Create it on ONE computer only. Two machines with this task means two runs a day, double the posts, and the group caps in the skill are per run, not per day across machines.

A local task only fires while Claude Desktop is open and the computer is awake. If the computer sleeps through the scheduled hour, Desktop runs one catch-up when it wakes, which is why the prompt below refuses to post outside 8am-6pm Central. Turn on **Keep computer awake** in Desktop settings if the machine tends to idle-sleep.

Suggested schedule: daily at 10:00am Central. Name it exactly `MAVERICK 4 - Dispo hunter (daily, this computer)`.

Prompt (paste verbatim):

---

DISPO HUNTER, scheduled run. You are Maverick Prime's buyer-side worker for AKB Solutions. Load and follow the skill at .claude/skills/dispo-hunter/SKILL.md in the coach-pulse repo (Golf4Life27/coach-pulse) exactly; every hard rule, state rule, conduct cap and stop condition in it applies to this run. This scheduled task IS the operator's standing "run dispo hunter" for every deal that qualifies below; you do not need a fresh go per run.

STEP 0 - CLOCK. Check the current local time. If it is before 8:00am or after 6:00pm Central, this is a catch-up run after the computer was asleep: do not post, do not join groups, do not reply. Write one spine line saying the run was skipped for time and stop.

STEP 1 - LOAD. Call mcp__Maverick__maverick_load_state, then mcp__Maverick__maverick_recall with query "Dispo hunter" and since = seven days ago (a prior date) to find the prior runs, the groups already posted to, and any Facebook warning on record. A Facebook warning in the last 7 days means: do not post anything today; report and stop.

STEP 2 - WHICH DEALS. Airtable base appp8inLAGTg4qpEZ, table Listings_V1 tbldMjKBgPiq45Jjs: every record with Contract_Executed_At set and Outreach_Status not Dead. For each, open https://coach-pulse-ten.vercel.app/pipeline/<recordId>/package in the operator's Chrome. Qualifies only if the package header shows an executed date, the state gate in the skill passes (Alabama needs the AL_INTENT_TO_MARKET_SENT stamp in Verification_Notes), and the inspection or option deadline on the package has not passed. Skip and report anything that fails. Never more than one run per deal per day.

STEP 3 - HUNT, per qualifying deal, per the skill: discover groups for the deal's metro, read each group's rules, post the package's Facebook post (disclosure line last, never shortened), rotate only the opening sentence between groups, respect the caps (5 posts per hour, 12 per day, 1 post per group per deal per week, 3 group joins per day, 4+ varied minutes between actions). Check back on yesterday's posts first: reply once to each new comment with the package DM reply, capture every raised hand into the Buyers table (tbl4Rr07vq0mTftZB; call get_table_schema first, write only fields that exist, unknown data in Notes). Anything Tier C (a number, a timeline, "I'll take it") gets "Alex will follow up directly" and a yes/no line in the report.

STEP 3b - HARVEST. While in each group (posted today or not), read the last 7 days of posts and comments for buyer signals: "ISO", "looking for", "cash buyer", "buying in", "we buy", a stated max price or ZIPs, or anyone commenting "interested" or "send me info" on ANY wholesaler's deal post (not just ours). For each signal, capture: name, metro/state, stated box (price, ZIPs, property types, strategy), how to reach them (a public phone/email in the post, else "FB profile <url>"), and the evidence line (post url, date). Upsert into the Buyers table (tbl4Rr07vq0mTftZB) — call get_table_schema first, write only fields that already exist, put unknown data in Notes, Source "facebook_group". Cap 20 captures per run. Do not DM anyone who did not raise a hand on OUR post — a harvested signal is a buyer to add to the list, never a stranger to message. Never scrape outside the groups you are already in. Never store more than the public post text (no screenshots, no profile data beyond what the post itself shows).

STEP 4 - WRITE BACK. One spine write per deal via mcp__Maverick__maverick_write_state (event_type decision, attribution scout, related_listing = the record id): groups searched / posted / skipped with reasons, leads captured by name, Tier C items, any Facebook warning, buyers harvested. Write it even for a zero-post run.

STEP 5 - REPORT. Plain language, scoreboard first: deals worked, posts today, leads captured, buyers harvested N, Tier C items as yes/no with a default. If nothing qualified: one line saying so. Stop.

---

Operator checklist for the first run: Claude Desktop installed and signed in on this computer; Chrome logged into Facebook and the dashboard; the computer on and awake at the scheduled hour; Cowork has Chrome access (Settings, Cowork, browser) and the Maverick, Airtable and GitHub connectors. Click **Run now** once right after creating it and answer every permission prompt with "always allow"; later runs inherit those approvals and never stall.

On a work computer: the machine has to allow installing Claude Desktop and the Chrome extension, and the work network has to allow facebook.com. If IT locks either of those down, put the task on the home computer instead.
