<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## ⭐ START HERE — read the system handoff first

**Before doing anything in this repo, read [`docs/handoffs/SYSTEM_HANDOFF.md`](docs/handoffs/SYSTEM_HANDOFF.md).**
It is the operator-authored source of truth: the business goal (find distressed →
verify → price → offer → negotiate → contract → dispo → repeat across markets), a
decoder ring for internal shorthand, what actually runs today vs. what's manual/unbuilt,
and a charter — **read first, plain English with the operator, no parallel builds, wire
existing screens to data that already exists.** The one-picture version is
[`docs/handoffs/system-map.png`](docs/handoffs/system-map.png).

This pointer exists because dreams/decisions kept vaporizing between sessions. Keep the
handoff current; it is how the next chat inherits context instead of rediscovering it.

## Vercel plan constraints

Project is on **Vercel Hobby plan** (5/14 build session — Path Y commit `2e0d054` failed deploy validation when a `0 */6 * * *` cron was added, blocking 4 subsequent commits until the cron was relaxed to daily).

Hard caps to respect when adding crons or async work:

- **Cron jobs: once per day maximum.** Anything more frequent (`*/N`, multiple slots per day, etc.) is rejected at deploy-time with `"Hobby accounts are limited to daily cron jobs"`. Stagger the daily slot to not collide with existing crons in `vercel.json`.
- **Lambda maxDuration:** 60s default, 300s ceiling. Set explicitly via `export const maxDuration = N;` per route.
- **Build concurrency:** 1 at a time.

If a feature genuinely needs sub-daily granularity, flag the Pro-plan-upgrade trade-off in chat — don't architect around the Hobby cap with workarounds (cascading single-fire crons, external schedulers, etc.).
