<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Vercel plan constraints

Project is on **Vercel Hobby plan** (5/14 build session — Path Y commit `2e0d054` failed deploy validation when a `0 */6 * * *` cron was added, blocking 4 subsequent commits until the cron was relaxed to daily).

Hard caps to respect when adding crons or async work:

- **Cron jobs: once per day maximum.** Anything more frequent (`*/N`, multiple slots per day, etc.) is rejected at deploy-time with `"Hobby accounts are limited to daily cron jobs"`. Stagger the daily slot to not collide with existing crons in `vercel.json`.
- **Lambda maxDuration:** 60s default, 300s ceiling. Set explicitly via `export const maxDuration = N;` per route.
- **Build concurrency:** 1 at a time.

If a feature genuinely needs sub-daily granularity, flag the Pro-plan-upgrade trade-off in chat — don't architect around the Hobby cap with workarounds (cascading single-fire crons, external schedulers, etc.).
