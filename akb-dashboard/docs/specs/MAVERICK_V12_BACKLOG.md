# Maverick — v1.2 backlog

Living list of enhancements + spec amendments queued for the next
Living-Artifact revision. Each item names the section of v1.1 it
amends and the trigger that surfaced it.

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

*(none yet — to be populated as Day 2 surfaces findings)*

---

## Living Artifact policy

Items in this doc are not committed work — they're inputs to the next spec revision. When the v1.2 spec is authored, each item here is either:

- **Adopted:** the v1.1 section gets an amendment in v1.2; item is removed from this backlog.
- **Reframed:** finding is resolved differently than originally noted; v1.2 reflects the new framing; item removed.
- **Dropped:** finding no longer relevant; item removed with a one-line rationale.

The doc itself stays in the repo as the staging area for spec churn between revisions.
