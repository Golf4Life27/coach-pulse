# Build events — milestone ↔ Spine pairing (enforced)

**Why this exists.** M5–M7 shipped as commits but no Spine `build_event` was
written, so Maverick's continuity layer never learned they existed — a later
session paid real time re-reading code to rediscover what shipped (the same cost
that earlier hit M4). Relying on the agent to remember to call
`maverick_write_state` was discipline, and discipline failed. This makes the
pairing a **pipeline gate** instead.

## The rule (CI-enforced)

Any commit whose **subject starts with `M<n>`** (e.g. `M9: …`, `M9 Part 1: …`)
is a *milestone commit* and MUST ship a paired record at:

```
docs/build-events/M<n>.json
```

`.github/workflows/milestone-build-event.yml` runs `scripts/check-build-events.mjs`
on every push and PR; if a milestone commit in the range has no matching record,
**CI fails red**. You cannot land a milestone without its build-event.

## Two homes, one content

- **`docs/build-events/M<n>.json`** — the durable, version-controlled record.
  It is the source of truth the CI enforces, and it **survives even if the Spine
  write is skipped or the MCP/Airtable is down** (the exact M5–M7 failure mode).
- **The Spine** (`maverick_write_state` `event_type:"build_event"`) — the same
  content pushed to `Spine_Decision_Log` so `maverick_load_state` surfaces it in
  future briefings. Write it **in the same cycle** as the commit, and record the
  returned row id in the JSON's `spine_build_event` field so the two are linked
  (and the JSON can be replayed to the Spine if it was ever missed).

## Record shape

```json
{
  "milestone": "M9",
  "title": "one-line summary",
  "date": "YYYY-MM-DD",
  "branch": "claude/…",
  "commits": ["<sha>", "…"],
  "merged_to_main": false,
  "summary": "what shipped + why it's safe",
  "spine_build_event": "rec… (the Spine row id, or null until written)",
  "verification": "N tests green, tsc clean"
}
```

## Local check

```
node scripts/check-build-events.mjs           # checks main..HEAD
BUILD_EVENTS_BASE=<sha> node scripts/check-build-events.mjs
```
