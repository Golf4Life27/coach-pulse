# System Facts — AKB Inevitable

**Status:** authoritative. **Owner:** Alex Balog (operator).
**Updated:** 2026-05-31.
**Spine:** paired build_event `recpLB1yC1SaDTqff` (A1 commit cycle, 2026-05-31).

This is the canonical record of the load-bearing facts about the AKB
Inevitable system. Every Claude session reads it first via
`maverick_load_state`. If anything in code, AGENTS.md, a comment, a
prior commit message, or a recalled Spine row contradicts a fact
here, **this file wins** — and the contradicting surface is the bug.

The file exists because the same handful of facts have been
re-derived (often incorrectly) across multiple sessions, costing
build time. The Vercel plan question alone has burned sessions
twice. A single authoritative record closes that loop.

Changes to this file are themselves a `build_event` on Spine. Append
the new fact, supersede the old line in place with a strikethrough
(don't delete history), and pair the commit per Rule 9.

---

## 1. Hosting + deployment

| Fact | Value |
|------|-------|
| Vercel plan | **Pro** |
| Vercel team | `team_zwFAlAQ8CyjGYcxyk7Sn6ww0` |
| Vercel project | `prj_X1pCuqzRml74iOKfNhTo4ZMG9K87` |
| Production target | `main` branch, server-side `target=production&state=READY` query |
| Default branch | `main` |

**Cron capacity:** Pro plan supports sub-daily crons. Earlier
`AGENTS.md` text describing "Hobby plan — once per day maximum" is
**stale and incorrect** (predates the upgrade). If sub-daily granularity
is genuinely needed, build it; do not architect around a Hobby cap
that does not exist. Update `AGENTS.md` to match in the next touch.

**Lambda ceilings (Pro):** `maxDuration` defaults 60s, ceiling 300s. Set
explicitly per route via `export const maxDuration = N;`.

## 2. Source of truth — repo

| Fact | Value |
|------|-------|
| Repo | `Golf4Life27/coach-pulse` |
| App subdir | `akb-dashboard/` |
| Default branch | `main` |
| Active feature branches | `claude/*` per session |

Maverick's git source (`lib/maverick/sources/git.ts`) defaults to
`main`; the dead `claude/build-akb-inevitable-week1-uG6xD` default has
been removed (2026-05-28, Spine `recwkHvBMTjeMLECp` — deploy-truth +
git-source-truth sibling fixes).

## 3. Continuity Layer (Maverick)

| Fact | Value |
|------|-------|
| Spec | Inevitable Continuity Layer v1.1 (amendment 6.4 for write attribution) |
| Load-state endpoint | `/api/maverick/load-state` (Vercel) |
| MCP server | `maverick_load_state`, `maverick_write_state`, `maverick_recall` |
| Briefing cache | 90s fresh / 5min stale-while-revalidate, in-process per warm lambda |
| Briefing budget | P95 ≤ 30s (parallel fetch ~3.5s floor + ≤ 30s synthesis ceiling) |
| Synthesis timeout | 30s (`DEFAULT_TIMEOUT_MS` in `lib/maverick/synthesize.ts`) |

**Discipline:** every commit that ships code is paired with a
`maverick_write_state` call (Phase 20.7 lesson). Spine write rate
dropping to zero is a regression, not a quiet day.

## 4. Airtable

| Surface | ID |
|---------|----|
| Base | `appp8inLAGTg4qpEZ` |
| Listings_V1 | `tbldMjKBgPiq45Jjs` |
| Spine_Decision_Log | `tblbp91DB5szxsJpT` |
| Property_Intel | `tbllf0GNjYepvnUuv` (INV-022 v1) |
| Buyers | `tbl4Rr07vq0mTftZB` |
| D3 Manual Fix Queue | `tblV6OkNPDzOo6ubp` |
| ZIP_Registry | created on this branch (D1) — see `docs/specs/AKB_MASTER_CHECKLIST.md` |

**Field-id rule:** when a brief and the codebase disagree on a field
ID, the codebase wins (proven 5/26 cleanup commit). Add a row to
this file recording the canonical mapping if it has ever drifted.

## 5. External services

| Service | Identity |
|---------|----------|
| Anthropic API key (production) | Vercel env, distinct from Make.com's key (rotated 2026-05-18) |
| Quo workspace number (Crier) | `+18155569965` (carrier registered) |
| Quo personal escalation (Maverick) | `+16302505865` (Alex's, A2P 10DLC) |
| RentCast | monthly cap 1,000 calls, resets 1st of month UTC |
| Firecrawl | Standard tier, 50 concurrent browsers, `FIRECRAWL_MAX_CONCURRENT=20` default |
| DocuSign | JWT path (Path A); MCP path is Claude-side, unreachable from Vercel |

**DocuSign provisioning status:** envelope routes exist (Phase 5
Scribe) but await JWT credentials in operator's DocuSign Admin
Console (Phase 12.7 — operator-external STOP).

## 6. Model + voice registry

| Fact | Value |
|------|-------|
| Voice registry | `lib/maverick/voice-registry.ts` (13 agents) |
| Briefing model | per registry entry — drift detected via Pulse `voice_drift` detector |
| Synthesizer entry point | `lib/maverick/synthesizer.ts` — every Anthropic call routes here |
| Prompt cache | `cache_control: ephemeral` on system prompts for repeated session-opens |

**Refusal discipline:** the synthesizer paraphrases the structured
briefing; it must never invent counts, addresses, SHAs, dates, dollar
amounts, principle IDs. The template fallback (`renderTemplate`) is
both the safety net (timeout / error) and the ground-truth input the
synthesizer paraphrases against. System Facts here are inputs to that
same ground truth.

## 7. Named-agent roster

The system speaks in named agents:

- **Sentinel** — intake
- **Appraiser** — valuation (ARV / rehab / buyer intelligence)
- **Forge** — drafting (offers, EMD)
- **Crier** — SMS dispatch + cadence
- **Sentry** — gate enforcement
- **Scribe** — contracts (DocuSign)
- **Scout** — buyer pipeline
- **Pulse** — system health + drift detection
- **Ledger** — economics
- **Maverick** — orchestrator (this layer)

## 8. Decision Preconstraints (Constitution Rule 3 — autonomy lanes)

- **Type 1** (autonomous): system computes, system writes, system
  surfaces. No operator click. Data hydration, math, federation,
  classification.
- **Type 2A** (queued for approval): drafted outbound messages,
  status flips that touch counterparties. Operator clicks Send.
- **Type 2B** (operator-only, forever): DocuSign signing, EMD wire,
  contract execution. Hardcoded operator-click — no autonomy ever.
- **Type 2C** (judgment): structural failures, material discrepancies,
  counter-offers, anything where refusal is the correct verb.

When in doubt, **refuse and surface** is the lane.

## 9. Mission constants

These do not change without a Bible amendment.

| Anchor | Value |
|--------|-------|
| Wholesale fee target | $10K/deal floor |
| MAO discipline | 65% ARV − rehab − wholesale fee (V2.1) |
| Buyer cap rates | TX 8% / TN 10% / MI 9% / Default 9% (env-overridable) |
| Cadence | door-opener at 65% of list; price-drop = re-engagement (not first contact) — INV-030 |
| Crawler 2.0 unlock | $40K/mo net × 3 consecutive months (Bible §1.2) |
| Dream Phase unlock | operator hours < 15h/wk |

## 10. What this file is not

- Not a `CLAUDE.md`. Sub-directory `CLAUDE.md` files give per-area
  instructions. This is system identity.
- Not a checklist. The master checklist tracks build state.
- Not a Spine row. Spine records decisions over time; this records
  the steady facts those decisions sit on.
- Not exhaustive. Add a row when a fact has been re-derived
  (correctly or incorrectly) in more than one session. Don't bloat
  with facts a session can trivially read off the codebase.
