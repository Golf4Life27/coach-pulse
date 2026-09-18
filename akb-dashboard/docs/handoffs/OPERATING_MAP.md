# Operating map (one page)

Updated 2026-09-17. This is the whole picture of who runs what. If it is not on this page, Alex does not need to remember it.

## 1. Where Alex talks

One place: the session titled **MAVERICK HQ - talk here (build, decisions, status)**.

Everything else is a routine or a background session that Alex never opens. Routines write to the spine and to Airtable, and when a decision needs Alex they text his cell from the Maverick line (+1 630 250 5865). Alex answers in HQ or by tapping the decision card.

## 2. The routines (claude.ai Routines list)

| Name in the Routines list | When (Central) | What it does | What reaches Alex |
|---|---|---|---|
| MAVERICK 1 - Hourly seller-reply triage | every hour 8am-7pm | Reads new seller and agent replies, sends Tier B replies through the gated workflow, queues Tier C decisions | One text per hour at most, only when a decision is waiting: "Maverick / NEEDS YOU: ..." |
| MAVERICK 2 - Engine drive | 7:30am, 1:30pm, 7:30pm | Full pass over the pipeline: leads in, openers out, replies, accepted deals, dispo, findings for the build | A text only for deals or blockers that need him; otherwise nothing |
| MAVERICK 4 - Dispo hunter (Cowork scheduled task on one of his computers) | daily 10am | Posts every executed contract's package to Facebook buyer groups from the operator's own browser, captures raised hands into Buyers | A text only for Tier C (a buyer names a number or a date) |
| MAVERICK 5 - Weekly buyers list | Sunday 7am | Mines deed evidence into the Buyers table, leads with coverage gaps for metros under contract | One email |
| OFF - Nightly pipeline audit | (off) | Was a fresh-session routine with no connector tools, so it never actually ran | nothing |
| Whitetail CMA, TikTok content pack, TikTok ops | daily | Other businesses, untouched by this map | Their own emails |

Anything whose name starts with **OFF** or **DISABLED** is history and does not fire. The app's own crons (outreach, follow-up bumps, freshness, discovery sweep) run on Vercel and are not routines.

MAVERICK 1 and 2 fire into their own persistent sessions (titled "MAVERICK 1 - ... (routine runs here, do not type here)" and "MAVERICK 2 - ..."). Alex does not type in those. If one dies or fills up, HQ recreates it and re-binds the routine; nothing changes for Alex.

Routine prompts live in `akb-dashboard/docs/handoffs/routine-prompts/` and are the source of truth for what each routine is told to do. MAVERICK 4 is the one routine that runs on one of the operator's own computers, Mac or Windows (Claude Desktop, Routines, Local) because Facebook posting must come from his logged-in browser; its prompt is `routine-prompts/dispo-hunter-cowork.md`. The email half of dispo (blast to the Buyers table on contract execution) is app code behind `DISPO_BLAST_LIVE`, an operator flag in Vercel.

## 3. What only Alex does

- Signs contracts and addenda, and moves money (EMD).
- Says "go" on any new number, counter, acceptance, or revived deal (Tier C).
- Sends buyer emails and buyer texts drafted for him (buyer contact is operator-sent).
- One-time account chores nothing else can do: rotate keys, flip the repo private, cancel a vendor.

Everything else is Code's job. If a message asks Alex to run a command, paste a secret, or check a console, the message is wrong.

## 4. When a session hits its limit

- HQ and the routine sessions compact their own context automatically. Nobody has to open a new one.
- If a routine's session is genuinely dead (routine shows a failed last run), HQ creates a fresh session, binds the routine to it with the prompt from `routine-prompts/`, and renames the old one "OLD - ...". Alex is told in one line.
- Proven 2026-09-17: a fresh-session-per-run routine created from inside a session runs WITHOUT connectors (no Airtable, Gmail, Quo, spine); a test routine fired, ran nine seconds, wrote nothing. A child session created with create_session DOES inherit connectors. Only routines created from the claude.ai Routines UI carry connectors on their own. So the recipe is: create_session (repo attached, Opus, auto) + create_trigger with persistent_session_id and the prompt from `routine-prompts/`. Prompt edits on a bound routine are refused by the API; to change a prompt, create a new routine bound to the same session and turn the old one OFF.

## 5. Naming rules

- Routines: `MAVERICK <n> - <what it does> (<when, Central>)`.
- Sessions: `MAVERICK HQ - talk here` for the one Alex uses; `MAVERICK <n> - <routine name> (routine runs here, do not type here)` for routine sessions.
- Retired anything: prefix `OFF - ` and leave it disabled; delete once a week from HQ.

## 6. Model tiers (operator ruling 2026-09-17)

Premium model for intelligence; lower models for execution under its direction; premium credits are spent on judgment only.

| Layer | Model | Job |
|---|---|---|
| MAVERICK HQ | Fable (premium) | Thinking, decisions, design, review, operator conversation |
| MAVERICK 1 and 2 routines | Opus | Executing the sweeps and drives from HQ-written prompts |
| Build subagents | Sonnet | Writing code to a spec HQ wrote; HQ reviews and merges |
| Production app calls | per `lib/maverick/voice-registry.ts` | Cheapest model per agent that passes; Pulse flags drift |

HQ never runs a loop, sweep, or build that a lower model can execute from a written spec. Changing a routine's model is an operator call, by name.
