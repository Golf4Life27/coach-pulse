<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Vercel plan constraints

Project is on **Vercel Pro** (upgraded 5/27, D1 / PR #13 — confirmed by the `*/15` `zip-approval-reply-scan` cron deploying cleanly; the Hobby daily-cron cap would have rejected it at build validation).

> **History:** the project was on **Hobby** through 5/14–5/26. The Hobby daily-cron cap bit once — Path Y commit `2e0d054` failed deploy validation when a `0 */6 * * *` cron was added (`"Hobby accounts are limited to daily cron jobs"`), blocking 4 commits until `41a2e99` relaxed it to daily. Pro lifts that cap; sub-daily and multiple-slot crons are now allowed.

Caps to respect when adding crons or async work:

- **Cron frequency: sub-daily allowed (Pro).** `*/N` and multiple slots per day deploy fine. Still **stagger** slots so they don't collide with existing crons in `vercel.json` (see the daily cluster at `0 8`–`0 16` UTC); avoid piling heavy routes on the same minute.
- **Lambda maxDuration:** 300s ceiling — set explicitly via `export const maxDuration = N;` per route. Routes here run at 60–300s.
- **Build concurrency:** 1 at a time.

## Outbound SMS volume ceiling (10DLC)

H2 first-touch outreach (`/api/cron/h2-outreach`, Crier) sends from a single Quo 10DLC number. The hard ceiling on daily/burst volume is the **Quo/10DLC campaign's provisioned throughput** (TCR-registered daily message cap + messages-per-minute), NOT a code constant. **This number is not exposed in the codebase or via the messaging API — read it from the Quo / TCR console and record it here.**

> **Provisioned ceiling: TBD — confirm in Quo/TCR console.** Daily cap: `?`. Per-minute (MPS) cap: `?`. The H2 ramp (below) must stay at or under both.

- **Per-run cap is env-driven (Brief 4a):** `H2_DAILY_LIMIT_PER_RUN` (default **12**). The cron fires 4×/day (`30 15`, `0 18`, `0 21`, `30 23` UTC), so daily volume = cap × 4. Ramp: week 1 = 12 (~50/day) → week 2 = 25 (~100/day) **gated on** failed-send <2%, opt-out <3%, no Quo throughput warnings. Flip the env in Vercel to ramp — no route redeploy.
- **Pacing, not just volume:** `send_delay_ms=10000` spaces sends within a run; staggering the 4 runs across the day avoids burst-pattern spam flags. Burst-shape and total-volume are independent carrier-safety axes — manage both.
- **Latent throttle:** `lib/quo-throttle.ts` encodes a 15-sends/hour cap but is **not currently wired into the send path**. Decide: wire it as a real backstop (it would cap any single run at 15, so it must be raised in lockstep with the ramp past 15/run) or retire it.
