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
