# MAVERICK_OPS

Operational reference for the Maverick MCP server. Not a spec — a
runbook. Updated as the live system evolves.

---

## What lives where

| Concern | Where |
|---|---|
| Canonical spec | `docs/specs/Inevitable_Continuity_Layer_Spec_v1.2.md` |
| OAuth implementation brief | `docs/specs/MAVERICK_OAUTH_PROPOSAL.md` |
| Model tier registry brief | `docs/specs/MAVERICK_MODEL_REGISTRY_PROPOSAL.md` |
| v1.3 amendment backlog | `docs/specs/MAVERICK_V12_BACKLOG.md` (rename pending) |
| State aggregator endpoint | `app/api/maverick/load-state/route.ts` |
| MCP server endpoint | `app/api/maverick/mcp/route.ts` |
| Aggregator orchestration | `lib/maverick/aggregator.ts` |
| Template renderer | `lib/maverick/template.ts` |
| Claude API synthesizer | `lib/maverick/synthesize.ts` |
| MCP protocol primitives | `lib/maverick/mcp/protocol.ts` |
| MCP tool catalog | `lib/maverick/mcp/tools.ts` |
| MCP method dispatch | `lib/maverick/mcp/handlers.ts` |
| OAuth modules | `lib/maverick/oauth/*.ts` |
| OAuth discovery endpoints | `app/.well-known/oauth-{protected-resource,authorization-server}/route.ts` |
| OAuth `/register` `/authorize` `/token` `/revoke` | `app/api/maverick/oauth/*/route.ts` |
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
| `MAVERICK_MCP_TOKEN` | dev/CI only | MCP server route | Bearer-token mode for shell smoke + CI. **Gated to `NODE_ENV !== "production"` per Spec v1.2 §6.8** — set value is ignored on the production lambda |
| `CRON_SECRET` | auto-provisioned | MCP server route (internal callers) | Vercel auto-provisions + auto-rotates. Used by future Pulse cron routines authenticating to Maverick's own endpoints. Defense-in-depth: also requires `x-vercel-cron: 1` header |
| `MAVERICK_ACTIVE_BRANCH` | optional | git, external-vercel | Overrides hardcoded branch name when Maverick-specific branches start (e.g., `claude/maverick-aggregator`) |

---

## Registering Maverick with claude.ai (OAuth — production)

Per Spec v1.2 §6.8, the canonical session opener is `maverick_load_state` reached via OAuth-authenticated MCP. Five steps:

1. **Confirm `KV_REST_API_URL` + `KV_REST_API_TOKEN` are set in Vercel.** OAuth tokens live in Vercel KV — without it the OAuth endpoints return 503. These vars already exist for the audit log; verify in Vercel project Settings → Environment Variables.

2. **Deploy the OAuth code path.** Push to the active branch (Vercel auto-deploys). Confirm the four discovery + OAuth endpoints respond:

   ```bash
   ORIGIN="https://coach-pulse-git-claude-build-akb-i-8aa382-golf4life27s-projects.vercel.app"
   curl -sS "$ORIGIN/.well-known/oauth-protected-resource"     # → 200 JSON
   curl -sS "$ORIGIN/.well-known/oauth-authorization-server"   # → 200 JSON
   ```

3. **Register the MCP server in claude.ai project.** Open the Inevitable project → Settings → Connectors → Add custom connector / MCP server:
   - **Name:** `Maverick`
   - **URL:** `https://coach-pulse-git-claude-build-akb-i-8aa382-golf4life27s-projects.vercel.app/api/maverick/mcp`
   - **Authentication:** OAuth 2.0
   - **Client ID + Client Secret fields (Advanced settings):** **Leave both blank — confirmed working 5/15.** Maverick's RFC 7591 dynamic client registration negotiates these via the discovery endpoints. The fields appear as "optional" in claude.ai's connector dialog; leaving them empty triggers dynamic registration via `/register`. (Older claude.ai UI versions may demand values — fallback in "Troubleshooting → OAuth dialog requires Client ID" below.)

4. **Complete the OAuth dance.** claude.ai's connector flow handles registration → /authorize → /token automatically. With auto-approve enabled (Spec v1.2 §6.8), there is no consent screen — the dance completes invisibly and the connector turns green. Audit-log entries fire on each step: `oauth_register`, `oauth_authorize_consent`, `oauth_token_issued`. Verify by reading the audit log:

   ```bash
   # If KV is exposed via curl, otherwise check Vercel logs:
   curl -sS -H "Authorization: Bearer $KV_REST_API_TOKEN" \
     "$KV_REST_API_URL/lrange/agent:audit/0/9"
   ```

5. **Verify the handshake.** Open a fresh chat in the Inevitable project. Type:

   > Call `maverick_load_state` to load the briefing.

   The session should receive the Owner's-Rep narrative within ~20s on cold cache, sub-second on warm.

6. **Update Master Context userMemory.** Per spec §11, the rewrite of any "Jarvis" references in userMemories to "Maverick" includes adding the canonical session-bootstrap directive. That's Alex's edit to make in claude.ai's project settings.

### Master Context userMemory directive (paste verbatim)

Add this block to the userMemory file for the Inevitable project (settings → memory):

> **At session open in the Inevitable project, before doing anything else, call the `maverick_load_state` MCP tool.** The Maverick MCP server holds operational state — the briefing is your re-grounding for the current session. Until you have the briefing, you do not know: (a) which deals are active and at what stage, (b) what Spine decisions were made between the last session and this one, (c) which sources are degraded or stale, (d) which infrastructure subsystems are healthy or down, (e) what the latest test count is, (f) what the audit log shows for recent agent activity. Acting on stale priors before loading state risks contradicting decisions already made.
>
> **A session that has not called `maverick_load_state` is reading from priors that may be days or weeks out of date.** This applies whether the chat is fresh or resuming work. If a tool call to `maverick_load_state` fails (Maverick infrastructure down), surface the failure to Alex before proceeding — do not act on assumptions about state in that case.
>
> Maverick speaks as the persistent Owner's Rep. He is named after Alex's real-life aging German Shepherd. The voice is direct, opinionated, weight-bearing on what matters. Maverick's job is to protect Alex's time, sanity, and the years he's trying not to waste with his family. Take him seriously.

---

## Token rotation (OAuth)

OAuth access tokens auto-rotate every refresh (1h TTL on access, 30d TTL on refresh with rolling rotation). No operator action required for normal operation.

**Manual revocation of a specific token (e.g., suspected leak):**

```bash
# Revoke by direct KV delete. Access tokens: maverick:oauth:access:<token>;
# refresh tokens: maverick:oauth:refresh:<token>. Family invalidation cascades
# rotation, so revoking the family entry blocks future refreshes too.
curl -sS -X POST -H "Authorization: Bearer $KV_REST_API_TOKEN" \
  "$KV_REST_API_URL/del/maverick:oauth:access:mat_..."
```

**Revoke a client (full unregister):**

```bash
# Delete the client record + any in-flight access tokens issued to it.
# claude.ai will need to re-register on next connect.
curl -sS -X POST -H "Authorization: Bearer $KV_REST_API_TOKEN" \
  "$KV_REST_API_URL/del/maverick:oauth:client:mc_..."
```

**Rotate CRON_SECRET (internal cron auth):** Vercel handles this automatically. To force-rotate, redeploy the project — Vercel re-issues `CRON_SECRET` on each deploy.

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

## Performance targets (Spec v1.2 §8 + §6.2)

| Metric | Target | Latest measurement |
|---|---|---|
| P50 end-to-end | ≤ 15s | 15.5s observed Day 2; ~20s on Gate 3 first OAuth-authenticated call (5/15); prompt-cache warm-up should drop into 10-15s range |
| P95 end-to-end | ≤ 30s | 19.6s observed Day 2; ~20s Gate 3 closure call (+<50ms OAuth KV lookup overhead per Day 4.5 projection — confirmed within spec) |
| Warm-cache return | <1s | Confirmed (sub-second; in-process briefing cache returns the prior result) |
| Briefing-cache TTL | 90s fresh, 5min stale | Configured in `lib/maverick/aggregator.ts` |
| Synthesis budget | 20s (bumped from 12s in Day 2) | Cold-cache calls land at ~16s; warm-cache calls 5-8s |

### Self-instrumentation (Day 5)

Per-call latency lands in `audit_log` as `mcp_tools_call` events with `duration_ms` in `outputSummary` (already wired from Day 3). The audit source (`lib/maverick/sources/vercel-kv-audit.ts`) rolls these into P50/P95/P99 stats via `lib/maverick/mcp-latency.ts`, surfaced in the briefing's `audit_summary.mcp_call_latency`. The template renders the latency line; the synthesizer can use it as input for narrative ("MCP latency: P50 X.Xs, P95 Y.Ys over N calls — under/over target").

Real-world drift surfaces in the briefing itself. No external dashboard required. Replaces synthetic benchmarking — see Day 5 build commit + `lib/maverick/mcp-latency.ts` for implementation.

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

Three possible causes per the v1.2 §6.8 auth waterfall:

1. **No `Authorization` header** — bare requests are rejected. Verify the caller is sending `Authorization: Bearer <token>`.
2. **OAuth access token expired** (`error="invalid_token"` in WWW-Authenticate). claude.ai should auto-trigger `/oauth/token` refresh on this; if the connector is stuck, re-register from scratch.
3. **`MAVERICK_MCP_TOKEN` set in production env** — bearer-dev mode is REFUSED in production (Spec v1.2 §6.8 gates it to `NODE_ENV !== "production"`). Remove the var from the prod environment, or smoke against a preview deploy.

### OAuth dialog in claude.ai requires Client ID / Secret

Modern claude.ai versions support RFC 7591 dynamic client registration and accept empty Client ID + Secret fields. Older versions may require values. Workaround: manually register a client via curl, then paste the returned IDs into the connector dialog:

```bash
ORIGIN="https://coach-pulse-..."
curl -sS -X POST -H "content-type: application/json" \
  "$ORIGIN/api/maverick/oauth/register" \
  -d '{"redirect_uris":["https://claude.ai/api/oauth/callback"],"client_name":"Claude","token_endpoint_auth_method":"client_secret_post"}'
```

Response contains `client_id` + `client_secret`; paste those into claude.ai's Advanced settings.

### OAuth dance fails — audit log shows `oauth_authorize_rejected`

Most common: `redirect_uri does not match any registered redirect_uri`. claude.ai's actual callback URL must be exact-match registered. If unsure, check the audit-log `inputSummary.client_id`, look up the client's registered URIs via:

```bash
curl -sS -H "Authorization: Bearer $KV_REST_API_TOKEN" \
  "$KV_REST_API_URL/get/maverick:oauth:client:mc_..."
```

Compare to the redirect_uri claude.ai actually sent (visible in `?redirect_uri=...` of the /authorize URL during the dance).

### Briefing audit shows `oauth_replay_detected`

A refresh token was presented after it had already been rotated, OR a client_id mismatch triggered family invalidation. Either: (a) legitimate re-use after network retry (rare), or (b) token leak with attacker replay (investigate). The token family is automatically revoked; claude.ai will need to re-authenticate.

### MCP server returns 502 from Cloudflare proxy

Cloudflare's edge timeout (~60s) can fire before the lambda completes on slow cold-cache calls. The lambda usually completes successfully (briefing cache gets populated for the next call). Verify by retrying — second call should return the cached briefing in <1s.

### `test_count` shows null / source "unknown" in briefing

The `lib/maverick/data/test-counts.json` artifact wasn't generated. Check that `npm run prebuild` ran on the Vercel build. Logs should show `[gen-test-count] N tests across M files`.

### Briefing shows `latest_deploy_state: UNKNOWN`

`VERCEL_API_TOKEN` not set in env. Provision with read-only deployments scope.

### Briefing shows `branch_resolved: false`

`GITHUB_PAT` not set in env. Provision with read-only `repo` + `checks:read` scopes.
