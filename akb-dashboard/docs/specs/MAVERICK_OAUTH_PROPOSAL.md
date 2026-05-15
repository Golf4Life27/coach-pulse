# Maverick MCP — OAuth 2.0 spec proposal

Draft amendment for v1.2 of `Inevitable_Continuity_Layer_Spec_v1.1.md`. Replaces the bearer-token-only auth model in §5 Step 2 (line 207) with OAuth 2.0 Authorization Code + PKCE as canonical. Bearer mode is preserved as developer fallback.

**Status:** Proposed, not committed. Locks when Alex marks the proposal "Accepted" inline. After lock, this doc is reframed as the implementation brief for Day 4.5 (OAuth build).

**Trigger:** Gate 3 cannot close on bearer-only — claude.ai's connector UI presents OAuth Client ID + Secret fields, no bearer-token field. The Day 3 MCP server is correctly auth'd for shell + curl but unreachable from a claude.ai chat. Path A confirmed (5/15): OAuth canonical, bearer relegated to dev/CI/shell-smoke.

---

## 1. Flow type

**OAuth 2.0 Authorization Code with PKCE (RFC 7636).**

Rationale:
- MCP spec (2025-06-18 revision) names PKCE Authorization Code as the canonical client-auth flow for MCP servers acting as protected resources.
- PKCE removes the need to pre-share a confidential client_secret with claude.ai — the code_verifier/code_challenge dance proves the same party that started the flow is finishing it.
- Single-user system (only Alex), but a session is long-lived (project chat) and needs refresh-token continuity without re-consent every hour.
- Implicit flow is deprecated. Device flow is overkill (no second device). Client Credentials flow is wrong (it represents a service-to-service identity, not Alex's identity).

**Not in scope for v1.2:** confidential-client mode, multi-tenant authorization server, third-party clients beyond claude.ai. Add when the use case appears.

---

## 2. Endpoints

All endpoints live under `app/api/maverick/oauth/` in the same Vercel project as the MCP server.

| Path | Method | Purpose | RFC |
|---|---|---|---|
| `/api/maverick/.well-known/oauth-protected-resource` | GET | Discovery: tells the client this MCP URL is a Protected Resource + points to the authorization server | RFC 9728 |
| `/api/maverick/.well-known/oauth-authorization-server` | GET | Discovery: lists the authorize/token/register endpoints + supported flows | RFC 8414 |
| `/api/maverick/oauth/register` | POST | Dynamic Client Registration — claude.ai POSTs `{redirect_uris, client_name, ...}`; we issue `client_id` (+ optional `client_secret` though PKCE replaces its security role) | RFC 7591 |
| `/api/maverick/oauth/authorize` | GET | User-consent UI. Validates client_id, redirect_uri, code_challenge; renders "Approve Maverick access?" page; on approve, issues a one-time `code` and redirects back with `?code=…&state=…` | RFC 6749 §4.1 |
| `/api/maverick/oauth/token` | POST | Code-for-token exchange (`grant_type=authorization_code`) + refresh (`grant_type=refresh_token`). Validates code_verifier against the code_challenge stored at /authorize | RFC 6749 §3.2 + RFC 7636 §4.5 |
| `/api/maverick/oauth/revoke` | POST | Token revocation (optional in v1.2; nice for the "log out" path) | RFC 7009 |
| `/api/maverick/mcp` | POST | The MCP server itself — now a Protected Resource. Accepts `Authorization: Bearer <opaque_access_token>`, validates against Vercel KV | (unchanged path, new auth behavior) |

**Authorization server identity:** Maverick is both the authorization server AND the protected resource. The well-known docs name the same origin in both metadata files. This is canonical for self-hosted MCP servers.

---

## 3. Client registration

**Mechanism:** RFC 7591 Dynamic Client Registration.

**Why dynamic over static:** claude.ai's connector "Add custom MCP server" UI doesn't currently expose a "paste your client_id here" field. It expects the server to support dynamic registration and runs the handshake automatically when the user pastes the MCP URL. Static-only would dead-end the same way bearer-only did.

**Single-user simplification:** Dynamic registration on a single-user system means "auto-approve any client that POSTs valid metadata." We don't need a multi-tenant admin UI. The first successful /register from claude.ai writes one row to Vercel KV; subsequent registrations from the same `client_name` either reuse or replace it.

**KV schema:**

```
key:   maverick:oauth:client:<client_id>
value: {
  client_id: "mc_<random32>",
  client_secret: "<random32>" | null,   // null when PKCE-only
  client_name: "Claude (claude.ai)",
  redirect_uris: ["https://claude.ai/api/oauth/callback", …],
  created_at: iso8601,
  last_used_at: iso8601
}
ttl: none (manual revocation)
```

**Redirect URI policy:** Stored verbatim from /register. Validated against the exact `redirect_uri` passed at /authorize. Trailing-slash mismatch = reject. No wildcard support.

---

## 4. Token storage

All three token types stored in Vercel KV as opaque random strings. JWT considered + rejected: stateless validation isn't worth the JWKS/key-rotation overhead when KV lookup is ~5ms (negligible against the 20s briefing budget) and KV gives instant revocation.

| Token | Format | TTL | KV key | Single-use? |
|---|---|---|---|---|
| Authorization code | `code_<random32>` | 60s | `maverick:oauth:code:<code>` | yes — `getdel` on /token |
| Access token | `mat_<random32>` | 3600s (1h) | `maverick:oauth:access:<token>` | no |
| Refresh token | `mrt_<random32>` | 2592000s (30d) | `maverick:oauth:refresh:<token>` | yes — rotated on each use |

**Access-token value shape (KV record):**
```
{
  client_id: "mc_<id>",
  subject: "alex",                   // single user, hardcoded
  scopes: ["maverick:state"],
  issued_at: iso8601,
  expires_at: iso8601
}
```

**Authorization-code record (60s window):**
```
{
  client_id, redirect_uri,
  code_challenge, code_challenge_method: "S256",
  scope, state,
  issued_at: iso8601
}
```

**Refresh-token record:**
```
{
  client_id, subject, scope,
  family_id: "<random16>",            // for replay detection
  issued_at, expires_at
}
```

---

## 5. Refresh strategy

**Rolling refresh tokens.** Every successful `grant_type=refresh_token` exchange:
1. Validates the presented refresh token's KV record.
2. **Deletes** the presented refresh token.
3. Issues a new refresh token with the **same family_id** but new value + reset TTL.
4. Issues a new access token.

**Replay detection:** If a refresh token's KV record is missing but its `family_id` is presented (via a parallel still-valid token), invalidate the entire family + audit `oauth_replay_detected`. Forces re-consent. This is the recommended pattern for public clients per OAuth Security BCP.

**Access-token expiry signaling:** MCP server returns 401 with:
```
WWW-Authenticate: Bearer realm="maverick", error="invalid_token", error_description="token expired"
```
claude.ai triggers a /token refresh, retries the MCP call.

---

## 6. Scopes

**v1.2:** single scope `maverick:state`. Covers all three tools (load_state, write_state, recall). Granted on first consent.

**Why not per-tool scopes:** Single-user system. The audit log already provides per-tool attribution. Per-tool scope granularity would force claude.ai to request multiple scopes on first consent, adding friction with no security gain (same human, same intent).

**v1.2+ deferral:** When multi-agent attribution requires it (e.g., a Crier-only MCP client that should not have write access to Spine), introduce `maverick:state.read` + `maverick:state.write` as a non-breaking refinement. Existing clients with `maverick:state` continue to work; new clients can request narrower scopes.

---

## 7. Bearer-mode coexistence (developer fallback)

`MAVERICK_MCP_TOKEN` env var stays implemented but is **gated to non-production environments**:

```ts
if (process.env.NODE_ENV !== "production" && MAVERICK_MCP_TOKEN) {
  // bearer-mode accepted for shell smoke + CI
}
```

In production, only OAuth-issued access tokens are accepted. Prevents an attacker who steals `MAVERICK_MCP_TOKEN` from production env vars from bypassing the entire OAuth layer.

CI smoke tests use bearer-mode against a preview deployment (which runs with `NODE_ENV=development` for the test). claude.ai web in production uses OAuth.

---

## 8. Audit events

New event types wired into the existing audit log:

| Event | When | inputSummary |
|---|---|---|
| `oauth_register` | /register success | `client_name`, `redirect_uris.length` |
| `oauth_authorize_consent` | /authorize approved | `client_id` |
| `oauth_token_issued` | /token success (auth_code) | `client_id`, `scope` |
| `oauth_token_refreshed` | /token success (refresh) | `client_id`, `family_id` |
| `oauth_token_revoked` | /revoke success | `client_id`, `token_type` |
| `oauth_replay_detected` | refresh-token replay | `client_id`, `family_id` |
| `oauth_request_rejected` | any 4xx response from /authorize or /token | `endpoint`, `reason` |

All attributed to agent `maverick` (the orchestrator). Failures get `status: confirmed_failure` so the briefing's `recent_failures` surfaces auth incidents.

---

## 9. Tests

**Unit (pure-function):**
- `validateAuthorizeRequest`: rejects missing/unknown client_id, mismatched redirect_uri, missing code_challenge, unsupported code_challenge_method, missing state
- `validateTokenRequest`: rejects unknown grant_type, expired auth code, mismatched code_verifier, expired refresh token, unknown refresh token
- `generateOpaqueToken`: returns 32-byte random with expected prefix
- `verifyPkceChallenge`: S256 hash of code_verifier matches stored code_challenge
- `detectReplay`: refresh token with stale value but valid family_id triggers family invalidation

**Integration (DI'd KV stub, real flow):**
- Full Authorization Code flow: /register → /authorize → /token (code_grant) → /mcp protected call → /token (refresh_grant) → /mcp again
- Expired access token returns 401 with WWW-Authenticate
- Revoked refresh token cannot be reused
- Concurrent /token with same code → first succeeds, second 400s with `invalid_grant` (getdel atomicity)

**Smoke (deployed endpoint, real KV):**
- `curl /.well-known/oauth-protected-resource` returns 200 JSON
- `curl /.well-known/oauth-authorization-server` returns 200 JSON with correct endpoint URLs
- Real claude.ai connector dance (Gate 3 closure): paste MCP URL → connector completes registration + first /authorize + first /token → fresh session calls maverick_load_state successfully

**Target:** ~30 new tests (Day 4 added 89; OAuth is similar surface area). Type-check clean. End-to-end Gate 3 demo recorded in OPS as evidence.

---

## 10. Sequencing recommendation

**Recommend: insert "Day 4.5 — OAuth" before Day 5.**

Rationale:
- OAuth is a coherent unit (auth flow + storage + claude.ai handshake). Clean to ship as one commit, one review pass, one Gate 3 closure.
- Day 5's hardening + observability work BENEFITS from OAuth being live — the observability layer gets to wire in OAuth audit events from the start instead of refactoring later.
- Days 6-7 (read the three new specs + AKB current-state audit) don't depend on OAuth and stay where they are.
- Estimated effort: 1 focused build session (~6-8 hours of build, similar to a Day-2-or-3 unit). Faster than a full Day in the original sequence but Gate 3 closure is a discrete deliverable that deserves its own commit.
- Alternative considered + rejected: roll OAuth into Day 5. Bundles two unrelated concerns into one review pass and makes the Gate 3 closure entangled with Gate 4/5 work. Worse for forensic clarity.

**Renumbered sequence:**
- Day 1 ✅ — 9 fetchers
- Day 2 ✅ — aggregator + synthesis + load-state endpoint
- Day 3 ✅ — MCP server (bearer auth)
- Day 4 ✅ — write_state + recall tools
- **Day 4.5 — OAuth (NEW)**
- Day 5 — Hardening + observability (was Day 5 in original plan)
- Days 6-7 — Three new specs reading + AKB current-state audit

---

## 11. Proposed v1.2 spec language

Replace line 207 of `Inevitable_Continuity_Layer_Spec_v1.1.md`:

> ~~**Auth model:** Single bearer token in `MAVERICK_MCP_TOKEN` env var for v1. Per-source tokens for attribution can ship in v1.1+ if/when audit-trail-per-session-type becomes load-bearing.~~

With:

> **Auth model (v1.2 amendment 6.5):** OAuth 2.0 Authorization Code with PKCE (RFC 7636), canonical. The MCP server is an OAuth Protected Resource per RFC 9728; same Vercel origin acts as both protected resource and authorization server. Endpoints exposed: `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server` (RFC 8414), `/oauth/register` (RFC 7591 dynamic client registration), `/oauth/authorize`, `/oauth/token` (auth_code + refresh_token grants), `/oauth/revoke`. Tokens are opaque random strings stored in Vercel KV: 1h access tokens, 30d refresh tokens with rolling rotation. Single scope `maverick:state` covers all tool calls in v1.2; per-tool scope refinement deferred until multi-agent attribution requires it.
>
> Bearer-token mode (`MAVERICK_MCP_TOKEN` env var, v1.1 design) is preserved as a developer fallback for shell smoke + CI but gated to `NODE_ENV !== "production"`. Production accepts OAuth tokens only.

Add to the amendment log (§Amendments section, currently 6.1–6.4):

> **6.5 — OAuth as canonical auth (5/15):** The bearer-only design (v1.1 §5 Step 2) was correct for shell-based access but unreachable from claude.ai's connector UI, which presents OAuth Client ID + Secret fields exclusively. Gate 3 cannot close until OAuth ships. Path A: OAuth canonical, bearer relegated to dev/CI fallback. Built in Day 4.5 (newly-inserted day between Day 4 and the original Day 5 hardening pass). Spec details: `docs/specs/MAVERICK_OAUTH_PROPOSAL.md`.

Promote this file to `Inevitable_Continuity_Layer_Spec_v1.2.md` when the proposal locks; this file is then archived alongside.

---

## 12. Gotchas + risks (the "anything missing" surface)

**(a) MCP-spec discovery is load-bearing.** Recent claude.ai versions probe `/.well-known/oauth-protected-resource` on the MCP URL *before* attempting connection. If that endpoint is missing or returns non-JSON, the connector either silently falls back to "no auth required" (broken) or rejects the URL entirely. Test this endpoint FIRST in the Day 4.5 build, before writing any /authorize logic.

**(b) Vercel cold-start on /authorize.** The consent page is server-rendered. Cold start >2s on the OAuth redirect makes the dance feel broken from the user's POV (claude.ai shows a loading spinner during the redirect chain). Mitigation: keep the route handler minimal (~50 lines, no heavy imports), consider `runtime = "edge"` (Vercel KV's `@vercel/kv` has edge-runtime support).

**(c) Redirect URI exact-match validation.** RFC 6749 §3.1.2 mandates byte-exact comparison. Trailing slash, query-string difference, scheme mismatch = reject. Don't normalize. This is the most-common OAuth implementation bug.

**(d) Auth-code atomicity.** Two concurrent /token calls with the same `code` must NOT both succeed. Use Vercel KV `getdel` (atomic get + delete) for code lookup. Vercel KV's SET NX + manual delete is non-atomic and replayable.

**(e) State parameter for CSRF.** /authorize must require + echo `state`. Without it, a third party can craft a CSRF that completes the connect flow on Alex's behalf. claude.ai sends `state`; we just need to round-trip it untouched.

**(f) Single-user simplification trap.** Don't bake in "any code with our shape is valid" — even single-user, validate everything OAuth specifies: code_verifier against code_challenge, redirect_uri against registered list, client_id is known, scopes are subset of registered. Single-user does not mean lax validation; it means the consent UX is simpler. The crypto invariants still hold.

**(g) Token-rotation edge case during deploys.** Vercel deploys recycle lambdas; in-memory state doesn't persist. All token storage MUST be in KV (already the design). Don't fall into the trap of an "in-memory cache for performance" — gives stale validation results across the lambda fleet.

**(h) Refresh-token theft window.** Rolling rotation limits damage but doesn't prevent first-use replay. Consider audit-side detection: a refresh-token call from a new IP/UA after a successful call from a different IP/UA → flag in audit (don't block — Alex's tunnel/VPN may legitimately change IP).

**(i) MCP-spec auth evolution risk.** The MCP auth spec (2025-06-18 revision) is the current target. Future revisions may add requirements. Pin to the protocol version in /initialize handshake responses + re-audit when a new MCP spec version drops.

**(j) Test against claude.ai before claiming Gate 3 closed.** The closure criterion (Gate 3) is "a fresh Claude session in the Inevitable project successfully calls maverick_load_state via MCP and receives the briefing." That dance has to be real-world tested — unit + integration tests don't substitute. Build a Gate 3 evidence-capture protocol: screenshot of the connector setup, audit-log entries showing oauth_register + oauth_token_issued + mcp_initialize + mcp_tools_call, narrative output in the chat.

**(k) Token leakage in audit-log payloads.** When logging OAuth events, log `client_id` + token PREFIX (first 8 chars) only — never full tokens. Mistake-shaped: `inputSummary: { token: req.headers.authorization }` writes the bearer token to KV in plaintext.

**(l) Discovery metadata cacheability.** `/.well-known/*` responses should have `Cache-Control: public, max-age=3600` — claude.ai may re-probe these on every reconnect. Without caching, every reconnect adds a serverless-function cold start to the latency.

---

## 13. Open questions for Alex

Before locking this proposal:

1. **Confirm OAuth route paths.** Proposed: `/api/maverick/oauth/{authorize,token,register,revoke}` + `/api/maverick/.well-known/oauth-{protected-resource,authorization-server}`. Acceptable, or prefer a different prefix (e.g., flat `/api/oauth/*`)?
2. **Consent UI vs auto-approve.** Single-user system, so the /authorize "Approve?" page can be a single-button "Approve as Alex" UI, or auto-approve when the request matches expected claude.ai redirect_uri. Recommendation: keep the explicit-approve button — visible audit moment, no real friction.
3. **Day 4.5 timing.** Is the next build session OAuth, or do you want the three new specs read first? My read: OAuth first (Gate 3 closure unlocks dogfooding the Day 2-4 work), then Days 6-7 specs reading + audit, then Day 5 hardening informed by what Days 6-7 surface.
4. **Anything in this proposal you'd amend before lock?** Especially around endpoint paths, scope model, or the bearer-mode coexistence pattern.

---

*Drafted 5/15/26 in the Day 4 build session. Locks when Alex marks "Accepted." On lock, this file becomes the Day 4.5 implementation brief; on Day 4.5 ship, it's archived next to v1.2.*
