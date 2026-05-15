# MAVERICK_OPS

Operational reference for the Maverick MCP server. Not a spec — a
runbook. Updated as the live system evolves.

---

## What lives where

| Concern | Where |
|---|---|
| Canonical spec | `docs/specs/Inevitable_Continuity_Layer_Spec_v1.1.md` |
| v1.2 amendment backlog | `docs/specs/MAVERICK_V12_BACKLOG.md` |
| State aggregator endpoint | `app/api/maverick/load-state/route.ts` |
| MCP server endpoint | `app/api/maverick/mcp/route.ts` |
| Aggregator orchestration | `lib/maverick/aggregator.ts` |
| Template renderer | `lib/maverick/template.ts` |
| Claude API synthesizer | `lib/maverick/synthesize.ts` |
| MCP protocol primitives | `lib/maverick/mcp/protocol.ts` |
| MCP tool catalog | `lib/maverick/mcp/tools.ts` |
| MCP method dispatch | `lib/maverick/mcp/handlers.ts` |
| 9 source fetchers | `lib/maverick/sources/*.ts` |
| RentCast burn-rate synthesis | `lib/maverick/rentcast-burn-rate.ts` |
| Prebuild test-count artifact | `scripts/gen-test-count.mjs` → `lib/maverick/data/test-counts.json` |

---

## Production URLs (current branch deploy)

Branch alias (auto-updates on each push to `claude/build-akb-inevitable-week1-uG6xD`):

```
Aggregator:  https://coach-pulse-git-claude-build-akb-i-8aa382-golf4life27s-projects.vercel.app/api/maverick/load-state
MCP server:  https://coach-pulse-git-claude-build-akb-i-8aa382-golf4life27s-projects.vercel.app/api/maverick/mcp
```

Production (when this work merges to `main`): replace the branch-alias
prefix with `coach-pulse-ten.vercel.app` or whichever production
domain is the canonical one.

---

## Environment variables

Required for full briefing fidelity. Missing vars cause graceful
degradation (sources return their "not configured" empty state).

| Var | Required? | Used by | Notes |
|---|---|---|---|
| `AIRTABLE_PAT` | yes | airtable-listings, airtable-spine, action-queue | Existing — already set in prod |
| `AIRTABLE_BASE_ID` | yes | (same) | Defaults to `appp8inLAGTg4qpEZ` if unset |
| `KV_REST_API_URL` | yes | vercel-kv-audit | Vercel KV connection |
| `KV_REST_API_TOKEN` | yes | vercel-kv-audit | Vercel KV auth |
| `ANTHROPIC_API_KEY` | yes | synthesize | Without it, briefings fall back to template-only narrative |
| `QUO_API_KEY` | yes | external-quo | Existing |
| `QUO_PHONE_ID` | optional | external-quo | Defaults to `PNLosBI6fh` |
| `GITHUB_PAT` | recommended | git, codebase-metadata | Read-only scope: `repo` + `checks:read`. Without it: `branch_resolved: false`, `latest_commit: null`, CI state unknown |
| `VERCEL_API_TOKEN` | recommended | external-vercel | Read-only deployments scope. Without it: deploy state UNKNOWN |
| `RENTCAST_API_KEY` | recommended | external-rentcast | Without it: `api_responsive: false`, `api_key_configured: false` |
| `RENTCAST_MONTHLY_CAP` | optional | external-rentcast | Defaults to 1000 |
| `MAVERICK_MCP_TOKEN` | recommended (prod) | MCP server route | Bearer token enforced when set; token-less mode is dev-only |
| `MAVERICK_ACTIVE_BRANCH` | optional | git, external-vercel | Overrides hardcoded branch name when Maverick-specific branches start (e.g., `claude/maverick-aggregator`) |

---

## Registering the MCP server with claude.ai

Per spec §5 Step 3, the canonical session opener is `maverick_load_state`. To get that wired:

1. **Generate the bearer token.** Pick a strong random string (32+ chars):

   ```bash
   openssl rand -hex 32
   ```

2. **Set `MAVERICK_MCP_TOKEN` in Vercel.** Project → Settings → Environment Variables → add `MAVERICK_MCP_TOKEN` scoped to Production + Preview. Paste the token from step 1. Save. Trigger a redeploy so the var loads into the lambda.

3. **Register the MCP server in claude.ai project.** Open the Inevitable project → Settings → Connectors → Add custom connector / MCP server:
   - **Name:** `Maverick`
   - **URL:** the `/api/maverick/mcp` endpoint from the table above
   - **Authentication:** Bearer token
   - **Token:** paste the token from step 1

4. **Verify the handshake.** Open a fresh chat in the Inevitable project. The MCP server should appear in the available connectors list. Type:

   > Call `maverick_load_state` to load the briefing.

   The session should receive the Owner's-Rep narrative within ~20s on cold cache, sub-second on warm.

5. **Update Master Context userMemory.** Per spec §11, the rewrite of any "Jarvis" references in userMemories to "Maverick" includes adding a directive: *"At session open in the Inevitable project, first call `maverick_load_state`. The MCP server holds operational state; the briefing is your re-grounding."* That's Alex's edit to make.

---

## JSON-RPC smoke commands (when shelling in with the token)

```bash
TOKEN="…paste MAVERICK_MCP_TOKEN…"
URL="https://coach-pulse-git-claude-build-akb-i-8aa382-golf4life27s-projects.vercel.app/api/maverick/mcp"

# Ping
curl -sS -X POST -H "content-type: application/json" -H "authorization: Bearer $TOKEN" \
  "$URL" -d '{"jsonrpc":"2.0","id":1,"method":"ping"}'

# Initialize handshake
curl -sS -X POST -H "content-type: application/json" -H "authorization: Bearer $TOKEN" \
  "$URL" -d '{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"smoke","version":"1.0.0"},"capabilities":{}}}'

# List tools
curl -sS -X POST -H "content-type: application/json" -H "authorization: Bearer $TOKEN" \
  "$URL" -d '{"jsonrpc":"2.0","id":3,"method":"tools/list"}'

# Call maverick_load_state
curl -sS -X POST -H "content-type: application/json" -H "authorization: Bearer $TOKEN" \
  "$URL" -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"maverick_load_state","arguments":{"format":"narrative"}}}'
```

The smoke takes 5-25s on cold cache (first call after deploy or a 5+ minute idle), sub-second on warm.

---

## Performance targets (Spec v1.1 §8)

| Metric | Target | Day 2 cold-path measurement |
|---|---|---|
| P50 end-to-end | ≤ 15s | 15.5s observed, 19.6s on the synthesis-fixed path; expected to drop into 10-15s range once prompt-cache is warm across calls |
| P95 end-to-end | ≤ 30s | 19.6s observed at the high end with all 9 sources healthy — under target |
| Warm-cache return | <1s | Confirmed (sub-second; in-process briefing cache returns the prior result) |
| Briefing-cache TTL | 90s fresh, 5min stale | Configured in `lib/maverick/aggregator.ts` |
| Synthesis budget | 20s (bumped from 12s in Day 2) | Cold-cache calls land at ~16s; warm-cache calls 5-8s |

---

## Sources of truth + per-source budgets

| Source | Budget | What it surfaces |
|---|---|---|
| git | 5s | Branch, latest commit, commits-since |
| airtable_listings | 15s | Active deals (Negotiating + Counter Received + Response Received + Offer Accepted), pipeline counts by status, Texted universe |
| airtable_spine | 8s | Recent Spine_Decision_Log entries |
| vercel_kv_audit | 2s | Audit events grouped by agent, recent failures |
| codebase_metadata | 3s | package.json, test_count from prebuild artifact, CI state from GitHub check-runs |
| action_queue | 8s | D3_Manual_Fix_Queue pending items, Cadence_Queue placeholder |
| external_rentcast | 3s | API responsiveness + monthly cap + UTC-anchored reset date |
| external_quo | 3s | API responsiveness + recent message activity |
| external_vercel | 3s | Latest deploy SHA + state + branch |

Parallel-fetch floor (worst-case): ~15s (airtable_listings bottleneck).
With synthesis at ~16-20s, end-to-end stays under the 30s P95 target.

---

## Troubleshooting

### Briefing comes back with `narrative_synthesized: false`

The Claude synthesis call exceeded the 20s budget. Briefing still returns successfully with the template-rendered fallback narrative. Common causes:
- Cold prompt cache (first call after 5+ min idle) — should self-correct on next call
- Anthropic API outage — check status.anthropic.com
- Large `active_deals` payload (41+ records) — Day 8+ refinement queued in v1.2 backlog to trim before synthesis

### Source shows `ok: false` + timeout error

Per-source timeout budgets are set in each fetcher's `DEFAULT_TIMEOUT_MS`. Bump in the fetcher if a source's latency grew. Don't bump the aggregator-wide budget — that risks Vercel's `maxDuration: 60` ceiling.

### MCP server returns 401

`MAVERICK_MCP_TOKEN` is set in production but the calling client isn't sending `authorization: Bearer <token>`. Verify claude.ai connector config or smoke-curl headers.

### MCP server returns 502 from Cloudflare proxy

Cloudflare's edge timeout (~60s) can fire before the lambda completes on slow cold-cache calls. The lambda usually completes successfully (briefing cache gets populated for the next call). Verify by retrying — second call should return the cached briefing in <1s.

### `test_count` shows null / source "unknown" in briefing

The `lib/maverick/data/test-counts.json` artifact wasn't generated. Check that `npm run prebuild` ran on the Vercel build. Logs should show `[gen-test-count] N tests across M files`.

### Briefing shows `latest_deploy_state: UNKNOWN`

`VERCEL_API_TOKEN` not set in env. Provision with read-only deployments scope.

### Briefing shows `branch_resolved: false`

`GITHUB_PAT` not set in env. Provision with read-only `repo` + `checks:read` scopes.
