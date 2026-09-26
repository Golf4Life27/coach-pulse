# Handoff to the fresh Wholesale lead (2026-09-26)

**From:** the systems-audit session (ALL · Build · systems audit + cleanup · Sep 24), on Alex's yes.
**To:** the new `WS · Lead · MAVERICK HQ` session. The old HQ (session_01AwUjsEyHmNAf2gze8oRTck, 676K tokens) is retired; do not message it.
**Read first:** `docs/system/SYSTEM_FACTS.md` §0 (the charter). Then `docs/PLAN.md`, then `docs/handoffs/OPERATING_MAP.md`, then this file.

## Scoreboard (2026-09-26 01Z, from the spine)

Fees to date: $0. One written acceptance: 18644 Kelly Rd, Detroit, $21,750 against a $35,000 list, accepted 2026-09-23 19:15Z. As of 01Z on 9/26 it has had a day and a half of silence from our side after that acceptance. Five decisions are open and none was ruled all day on 9/25:

1. Kelly Rd: LLC name (charter answer: AKB Solutions LLC and/or assigns), signer (Alex Balog), signer email, proof of funds, inspection days, plus the agent's requested call.
2. 8087 Continental Ave, Warren MI: confirm closing-cost coverage.
3. 820 August Dr, Birmingham AL: Scott's $140,000 counter (he has chased three times); hold at $136,500 or underwrite.
4. Four offers waiting to be priced.
5. The buy-box lever (buyer drip).

This is the Montrose pattern (accepted 9/1, died after 20 days waiting on an answer). The charter's priority order puts Kelly Rd first.

## Open with Alex (each becomes a dashboard card with a default and a deadline; see charter "operator surface")

| Item | Default if silent | Since |
|---|---|---|
| The five decisions above | Kelly Rd: send the agent the P0-1 request (LLC, signer, 10+ day inspection, EMD $1,000 or less at title) and offer one call window a day. Others: hold. | 2026-09-24 |
| Turn the 14-day dead-deal rule on (P0-10 dry run: 276 deals, 0 signed contracts affected) | Yes, after reading the first dry run | 2026-09-24 |
| Merge PR #275 (docs only: charter, v5 prompts, operating map, PLAN.md; CI green) | Yes | 2026-09-25 |
| Delete the 8 disabled routines + the 2 disabled v4 triggers (prompts saved in `routine-prompts/`) | Needs Alex's typed yes; irreversible | 2026-09-25 |
| Rotate the GitHub token Maverick uses (401 since 9/17; load_state is blind to commits) | Rotate now, ~5 minutes | 2026-09-17 |
| Reconnect Quo in claude.ai connectors (Unauthorized in routine hosts since 9/22) | Reconnect | 2026-09-22 |
| 17 of 18 Execution Agenda decisions unanswered (only D8) | Tap the recommended defaults, D1-D7 first | 2026-09-23 |
| MAVERICK 4 (Facebook dispo hunter): not on the Windows machine's scheduled list on 9/24 | Alex checks the other computer, or it is treated as not set up | 2026-09-18 |

## Findings for the build lane (do not investigate from the lead; brief a worker)

- The acceptance classifier is wrong in both directions; that is why accepted-silence never paged on Kelly Rd (engine drive 2026-09-26 01Z). PR #273 handled the bare "Accepted." case; the 9/26 finding says it is still wrong.
- 265 ZIPs overdue; two governors found (discovery 50/day, backfill 5/day); listings-intake crawling zero ZIPs (engine drive 2026-09-25 14Z).
- After a successful jarvis-send, the Quo message id is not reliably written back to Verification_Notes, so the send gate later refuses (triage 2026-09-24 13Z).
- Ingest duplication and a message drop were flagged by triage on 9/24; not root-caused.
- Permit Leads and Space Screens findings are NOT yours; they belong to PL · Lead and SS · Lead.

## What runs, and where (as of 2026-09-25)

| Routine | Trigger | Host session |
|---|---|---|
| WS · MAVERICK 1 · Seller replies · hourly 8a-7p CDT (v5) | trig_01D3qn7Sg7M8cbBG9rPkHh9s | session_01W7qfjWpYA15WHcyPZLiuq4 |
| WS · MAVERICK 2 · Engine drive · 9:05a, 2:05p, 8:05p CDT (v5) | trig_01Ain3ECKm4jnQUUeofiqLnJ | session_0155BfumYTQRJHWtdoHBHrzE |
| WS · MAVERICK 6 · Buyers build · daily 7a CDT | trig_018FFRGADnhbULrzhbPp8nsk | session_01QXxez1aH8is8n5t6rwJot6 |
| WS · MAVERICK 6 · Outreach volume read · daily 8:35a CDT | trig_01Udd5hHsCeK34fKSUzVe1YD | session_01QXxez1aH8is8n5t6rwJot6 |

The v4 triggers (trig_01Q2cXNFaG2SZt1DzStnfULy, trig_017GtYMptn3pMfZZNi4j3AK2) are disabled, not deleted. First v5 firings on 9/25 ran clean: engine drive ~$5, triage ~$13 across the day (vs a $237 single firing on 9/24).

## Rules that bind the lead

1. **Nothing is ever bound to you.** No routine, no `send_later`, no self-re-arm. Check-ins go to the MAVERICK 6 host with a standalone prompt.
2. **You do not build.** You write a brief, a worker-tier session builds in an isolated branch, you read the diff, Alex (or his typed go) merges. PR merges have always been on Alex's go.
3. **Scope gate.** Before any build or change, name the charter line it moves. If you cannot, it goes on the Not-Now list in `docs/PLAN.md`.
4. **Operator surface.** Alex works in the dashboard. Every ask for him is a card with a default and a deadline; chat is for direction. Do not park a decision in this session's scrollback.
5. **Send discipline** per `akb-dashboard/CLAUDE.md`: the live thread outranks record notes; sends go only through the gated workflows; Tier C never moves without Alex's word.
6. **Report** per `.claude/skills/plain-language-reporting/SKILL.md`: scoreboard first, plain language, decisions as yes/no with a default, one to two phone screens.

## Your first jobs, in order

1. Confirm the charter loaded (your first turn, see the seed prompt), then stop.
2. Get the five open decisions in front of Alex in the dashboard: confirm each has an Operator_Action_Items row (tblZRunAe5OaMTRCM) with a default and a deadline, and that the home queue shows them. Kelly Rd first. One operator text if the rules allow.
3. Write the closer brief for Alex's approval: what a closer paid per deal does, the written limits (price ceiling, EMD, inspection, close terms), how they get paid, and how the system briefs them. Charter line: "Not Alex's: calls."
4. Propose the focus metros (3-5) from where funded buyers and live counters actually are, for Alex to approve. Charter line: "a few focus metros."
5. Keep `docs/PLAN.md`'s Not-Now list current.
