# Maverick — v1.3+ backlog

Living list of enhancements + spec amendments queued for the next
Living-Artifact revision. Each item names the section of the current
spec (v1.2) it amends and the trigger that surfaced it.

> **Rename note (5/15):** This file was originally named the v1.2 backlog. v1.2 amendments (§6.8 OAuth, §6.9 model registry) shipped 5/15 in the Day 4.5 build. Items below carry forward to v1.3 unless explicitly closed. File rename + content cleanup deferred to next backlog-touch turn — keeping git history clean for the v1.2 cycle.

---

## From Day 1 review (5/15)

### 1. Git `files_changed_since` requires `/compare` call

**Spec section affected:** §5 Step 1, git source description.

**Finding:** GitHub `/repos/.../commits?since=ISO` returns commit metadata but does NOT include the `files` array per commit. To populate `files_changed_since[]` we'd need a separate `/compare/{base}...{head}` call.

**Decision (5/15):** Defer to v1.2. Briefing's value is at the summary level — *"3 commits since last session, here are the messages"* is sufficient signal. Doubling git source's API surface for one field likely pushes it past the 5s budget, and we don't need it for Gate 5.

**v1.2 implementation note:** If shipped, scope the call to `since_sha...head_sha` only (not all commit-pairs), keep it in the same 5s budget by running it parallel with the `/commits` call, and short-circuit when commits_since.length === 0.

### 2. Vercel `/v6/deployments?projectId=` doesn't filter by branch

**Spec section affected:** §5 Step 1, external_vercel source description.

**Finding:** Vercel's v6 deployments endpoint returns the project's most recent deploy regardless of which branch it came from. The fetcher returns that deploy verbatim; the aggregator filters client-side against `ACTIVE_BRANCH` env var.

**Decision (5/15):** Acknowledged, no change today. Add one line to v1.2 spec documenting the client-side filtering pattern.

**v1.2 implementation note:** Could add a `limit=20` + post-filter pattern to find the latest deploy on the active branch specifically. Bounded cost since deploys-per-day is small.

---

## From Day 2 review (5/15)

### 3. Trim active_deals payload sent to Claude synthesizer

**Spec section affected:** §5 Step 1, synthesis layer.

**Finding:** First Gate 2 smoke (5/15) showed Claude synthesis timing out at 12s when the structured payload contained 41 active_deals records (~10K input tokens, cold prompt cache). Bumped timeout to 20s as the immediate fix.

**v1.2 enhancement:** The aggregator can trim active_deals to top N (e.g., 15) before passing to the synthesizer. The template renderer continues to show all N entries (fast, deterministic). Only Claude sees the top slice. Reduces input tokens, cuts latency, lowers per-call API cost.

**Implementation note:** Add a `synthesisInputTrim()` helper in lib/maverick/aggregator.ts that clones the structured briefing and replaces `active_deals` with `active_deals.slice(0, 15)` before handing to synthesize. The template still receives the full briefing. ~10 lines.

### 4. Quo `/v1/messages` returning non-OK in production

**Spec section affected:** §5 Step 1, external_quo source description.

**Finding:** Production deploy shows `external_quo.api_responsive: false` despite `api_key_configured: true`. Quo's `/v1/messages?phoneNumberId=...&createdAfter=...&maxResults=50` returned non-2xx during Gate 2 smoke. Specific status code wasn't captured (fetcher swallows error and reports api_responsive:false per Day 1 graceful-degradation pattern).

**v1.2 enhancement:** Capture the actual HTTP status + first 200 chars of error body in the QuoState shape so the briefing can surface the specific failure mode. Either auth-side (401 = key scope issue), validation-side (400 = query param mismatch), or upstream (5xx = Quo outage). Without it the briefing just says "down" and Alex has to dig manually.

**Implementation note:** Add `api_last_status: number | null` and `api_last_error: string | null` to QuoState. Pure-summarizer change + one field-write update in the fetcher. ~5 lines.

### 5. Vercel API token + GitHub PAT not configured in production env

**Spec section affected:** §5 Step 1 + environment configuration.

**Finding:** Production deploy shows `external_vercel.api_token_configured: false` and `git.github_pat_configured: false`. Briefing's "deploy state" and "git latest commit" sections are empty as a result.

**v1.2 action item (env config, not code):** Alex provisions `VERCEL_API_TOKEN` and `GITHUB_PAT` in Vercel project env vars. Tokens scoped to: read-only deployments (Vercel), read-only repo + checks (GitHub). Once added, no code change required — the fetchers already handle the absence-vs-presence transition gracefully.

---

## Living Artifact policy

Items in this doc are not committed work — they're inputs to the next spec revision. When the v1.2 spec is authored, each item here is either:

- **Adopted:** the v1.1 section gets an amendment in v1.2; item is removed from this backlog.
- **Reframed:** finding is resolved differently than originally noted; v1.2 reflects the new framing; item removed.
- **Dropped:** finding no longer relevant; item removed with a one-line rationale.

The doc itself stays in the repo as the staging area for spec churn between revisions.
