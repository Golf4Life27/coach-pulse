# Operating map (one page)

Updated 2026-09-26 (systems audit cleanup, spine recFcxoIL4N6iB7b7; charter reckv6LMYmHW758LZ; TT charter rec7FX2DCxIid3aJf). This is the whole picture of who runs what. If it is not on this page, Alex does not need to remember it. The plan is `akb-dashboard/docs/PLAN.md`; the home queue is the one place Alex decides.

## 1. Where Alex talks

One lead session per system. Wholesale's is **WS · Lead · MAVERICK HQ**.

| System | Lead session | Where |
|---|---|---|
| Wholesale (WS) | WS · Lead · MAVERICK HQ (session_01T7aEYJN2B4ribY7ouP7fYT, fresh 2026-09-26; the 676K-token HQ is archived) | Code, this repo |
| Permit Leads (PL) | PL · Lead | Code, Golf4Life27/Fable5 |
| Space Screens (SS) | SS · Lead (to be created from a brief; the old sessions are too heavy to lead) | Code, Golf4Life27/Roman |
| TikTok Shop (TT) | TT · Lead (session_01Aa2fkMCEUon2iuUoNeJA3D, created 2026-09-26; charter in Drive "TT · TikTok Shop Charter v1") | Cloud Code session, no repo; plus one local browser task on the Chrome computer for browser-only chores |
| Golf (GOLF) | GOLF · Lead, if Alex wants one | Code, Golf4Life27/DomeParties |

Everything else is a routine host or a dated build session that Alex never opens. Routines write to the spine and to Airtable, and when a decision needs Alex they text his cell from the Maverick line (+1 630 250 5865). Alex answers in the lead session or by tapping the decision card.

**Rule A: nothing is ever bound to a lead.** No routine and no `send_later` check-in fires into a lead session. PR babysitting, dry-run reads and smoke tests go to an execution-tier routine host or a worker. (Between 2026-09-21 and 2026-09-24, 23 check-ins fired into HQ against this rule.)

## 2. The routines (claude.ai Routines list)

| Name in the Routines list | When (CDT) | Host session | What it does | What reaches Alex |
|---|---|---|---|---|
| WS · MAVERICK 1 · Seller replies · hourly 8a-7p CDT (v5) | hourly 8am-7pm | WS · Routines · MAVERICK 1 · Seller replies | Reads new seller and agent replies, sends Tier B replies through the gated workflow, queues Tier C decisions. 60 tool calls per firing, no subagents | One text per hour at most, only when a decision is waiting |
| WS · MAVERICK 2 · Engine drive · 9:05a, 2:05p, 8:05p CDT (v5) | 9:05am, 2:05pm, 8:05pm | WS · Routines · MAVERICK 2 · Engine drive | Full pass over the pipeline: lane heartbeat, funnel push, degraded mode, operator items | The morning scoreboard text; otherwise only blockers |
| WS · MAVERICK 6 · Buyers build · daily 7a CDT | 7am | WS · Routines · MAVERICK 6 · Ops check-ins | Grows the Buyers table from free sources, 25 rows a day max; coverage card when a metro under contract is short | A card when coverage is short; one email on Sundays |
| WS · MAVERICK 6 · Outreach volume read · daily 8:35a CDT | 8:35am | WS · Routines · MAVERICK 6 · Ops check-ins | Three-line read of what went out, what came back, what cap binds | A card only when something needs him |
| MAVERICK 4 · Dispo hunter (Cowork local task on one of his computers) | daily 10am | his computer | Posts executed contracts' packages to Facebook buyer groups from his own browser | A text only for Tier C. Not seen in the Cowork scheduled list on 2026-09-24; confirm which computer runs it |
| Buy-box drip (app cron, 10:30am) | daily | Vercel | Emails every buyer with no price box: three touches over ten days, then stops | Nothing |
| TT · Shop ops check (browser-based) | (off since 2026-09-26) | fresh session per run (Cowork) | Never reached Seller Center in 17 days | Replaced by an inbox-based check the TT lead builds on an execution-tier host |
| TT · Content pack · daily 7a CDT | (off since 2026-09-25) | fresh session per run (Cowork) | Makes one post a day for the queue | Off until the TT lead decides who posts |
| GOLF · CMA market check · daily 7a CDT | 7am | GOLF · Routines · CMA market check | Recommend-only golf market read | Its own session |

Anything whose name starts with **OFF** is history and does not fire. The app's own crons (outreach, follow-up bumps, freshness, discovery sweep) run on Vercel and are not routines.

Routine prompts live in `akb-dashboard/docs/handoffs/routine-prompts/` and are the source of truth for what each routine is told to do (current: `triage-hourly.v5.md`, `engine-driver.v5.md`, `buyers-build.v3.md`, `outreach-read.v1.md`, `dispo-hunter-cowork.md`; retired prompts in `routine-prompts/retired/`).

## 3. What only Alex does

- Signs contracts and addenda, and moves money (EMD).
- Says "go" on any new number, counter, acceptance, or revived deal (Tier C).
- Sends buyer texts drafted for him (buyer texting is operator-sent). Buyer email is automated.
- Sets each system's vision in its lead session.
- One-time account chores nothing else can do: rotate keys, billing, flip the repo private, cancel a vendor.

Everything else is Code's job. If a message asks Alex to run a command, paste a secret, or check a console, the message is wrong.

## 4. When a session hits its limit

- Sessions compact their own context automatically (MAVERICK 1 went from 654K to 167K tokens on 2026-09-24). Nobody has to open a new one for size alone.
- What drives cost is what wakes a session, not its size: every firing re-pays the host's context. Keep hosts light and keep check-ins off leads.
- If a routine's session is genuinely dead, create a fresh session with create_session (repo attached, execution tier, auto), bind a new routine to it with `create_trigger` + `persistent_session_id` and the prompt from `routine-prompts/`, and title the old one `WS · OLD · ...`.
- **Prompt edits on a bound routine are refused from any session other than the one it fires into** (re-confirmed 2026-09-25). To change a prompt: create a new routine on the same session with the new prompt, then disable the old one. Renaming, rescheduling and pausing work from anywhere.
- A fresh-session-per-run routine created from a Code session gets no connectors. The ones that carry connectors (the TikTok routines) were created in Cowork.

## 5. Naming rules (adopted 2026-09-25)

`SYSTEM · Role · detail`. System codes: WS, TT, SS, PL, GOLF, PARKED, and ALL for cross-system work.

- **Lead:** `WS · Lead · MAVERICK HQ`, `PL · Lead`. One per system.
- **Routine hosts:** `WS · Routines · MAVERICK <n> · <job>`. Wholesale keeps its MAVERICK numbers because prompts and spine rows cite them.
- **Routines:** `WS · MAVERICK <n> · <job> · <when, CDT> (v<prompt version>)`.
- **Build sessions:** `<SYSTEM> · Build · <topic> · <Mon DD>`. Archive the day the work is done.
- **Retired routines:** prefix `OFF <date> - ` with the replacing trigger id; delete only on Alex's yes.

## 6. Model tiers

See `akb-dashboard/docs/system/SYSTEM_FACTS.md` §6a (operator ruling 2026-09-21): judgment tier for leads and rulings only; execution tier for every routine host; worker tier for builds from a brief. MAVERICK 1 and 2 hosts run Opus 5 and MAVERICK 6 runs Sonnet 5; which one the execution tier should be is an open operator decision.
