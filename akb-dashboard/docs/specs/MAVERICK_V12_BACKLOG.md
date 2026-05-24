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

## From Gate 3 closure + first real-world usage (5/15 evening)

Four findings surfaced in the first OAuth-authenticated `maverick_load_state` invocation from a fresh Claude session in the Inevitable project. All caught by actual operation — exactly the Living Artifact loop in action.

### 6. `external_quo` false-negative on quiet windows

**Spec section affected:** §5 Step 1, external_quo source description.

**Symptom:** First post-Gate-3 briefing flagged "Quo is dark — Crier is mute" as a top infrastructure priority. Real state: Quo fired 8 outbound texts on 5/12 with 3 inbound replies the same afternoon; system has been operationally silent since 5/13 (no new sends initiated). Infrastructure is healthy — usage is just intentionally quiet.

**Root cause:** Source classifies `api_responsive: false` based on zero messages in the 24h window. That heuristic conflates two genuinely different states:
- API down (infrastructure failure, calls failing, deliverability broken)
- API quiet (infrastructure healthy, no operational activity in window)

These surface as the same signal to the synthesizer, which prioritizes "Quo is dark" as Tier 2 urgency. False alarm.

**Recommended fix:** Probe Quo's API directly with a lightweight GET to `/v1/messages?limit=1` (or equivalent health endpoint). 200 OK → `api_responsive: true` regardless of message count. Timeout/5xx/auth → `api_responsive: false` with actual HTTP status captured for debugging. Separates "is the API alive?" from "is anyone using it?"

**Severity:** Medium. False-positives in infrastructure prioritization desensitize Maverick to future real failures. Fix before Day 5 hardening locks priority logic.

### 7. `last_outreach_date` only tracks SMS, not email

**Spec section affected:** §5 Step 1, airtable_listings (Listings_V1 schema).

**Symptom:** Briefing flagged 23 Fields Ave (Candice Hardaway) as 27 days dark. Real state: deal is at contract stage — Candice sent DocuSign envelope yesterday at 7:07 PM CT with assignment-clause amendment + TAR RF401 PSA filled at $61,750 cash. The 5/14 email had already moved the deal forward; 5/15 closed the loop. Briefing misrepresented the highest-probability close in the pipeline as stale.

**Root cause:** `last_outreach_date` on Listings_V1 only updates when Crier fires SMS. Email-driven deals (Gmail-threaded negotiations) leave `last_outreach_date` stale at whatever the last SMS timestamp was. From the briefing's perspective the deal looks dark while it's actively closing.

**Recommended fix — Option A (preferred):** Add `last_email_outreach_date` field to Listings_V1. Update when Maverick (or any agent) sends or receives email correspondence on a deal. Synthesizer treats `max(last_outreach_date, last_email_outreach_date)` as the actual staleness signal. Schema change is cheap; synthesizer stays simple; email becomes first-class.

**Option B (less invasive):** Synthesizer cross-references recent Gmail threads matching agent emails on each deal before flagging staleness. More work per call; no schema change.

**Severity:** HIGH. This finding caused tonight's briefing to misrepresent the highest-probability close in the pipeline. If Maverick had acted on briefing alone, 23 Fields could have been written off as dead. Fix before Day 6-7 audit work locks dashboard data contract.

### 8. PDF exports of DocuSign envelopes don't show redline markup (Scribe future)

**Spec section affected:** §6 agent roster — Scribe (contract handling, not yet built).

**Symptom:** Reviewing Candice's PSA: static PDF export showed Section 16 (Non-Assignability) printed in full on page 8. Per her email, Section 16 was removed via strikethrough + adjacent initial field. Redline markup is visible in DocuSign's live UI but doesn't render in the PDF export.

**Implication:** Scribe (when built) cannot reliably read contract state from PDF exports during in-flight negotiations. Strikethroughs, replaced clauses, comment threads, and signature placeholders are DocuSign-native annotations that the PDF flattener loses.

**Recommended fix:** Scribe reads DocuSign's Envelopes API directly when contracts are in-flight. Fetches field-level markup (text fields, initial fields, strikethroughs), audit trail (who added what redline when), recipient signing status. PDF export is for archiving the executed document, not reviewing in-process markup.

**Severity:** Medium now (Scribe doesn't exist yet); HIGH when Scribe ships. Capture so Scribe build doesn't repeat tonight's pattern.

### 9. Active deals show `stored_offer_price: null` universally — V2.1 pricing discipline broken

**Spec section affected:** §5 Step 1 + agent roster (Appraiser/Forge write-responsibility).

**Symptom:** Every active deal in tonight's structured briefing had `stored_offer_price: null`. Maverick flagged this as a data hygiene issue: "Appraiser/Forge are not committing numbers back. V2.1 pricing discipline is failing silently."

**Root cause unclear from briefing alone.** Three failure modes possible:
- Appraiser's pricing logic computes the number but never writes back to Listings_V1
- Forge fires outreach with a price but doesn't update the stored field
- Field exists in schema but no agent has write-responsibility per the v2.1 spec

**Recommended fix:** Investigate during Day 5 hardening or Day 6 audit. Trace V2.1 pricing flow end-to-end: where does the offer number get computed, where should it be persisted, why isn't it landing? Could be a wiring bug (easy) or missing-agent-responsibility gap (spec work). Surface findings before patching.

**Severity:** HIGH. Without `stored_offer_price`, every deal in negotiation is flying blind on what number was actually proposed. Briefing can't compare "we offered X, they're at Y, spread is Z." V2.1 discipline technically broken in production.

---

## Living Artifact policy

Items in this doc are not committed work — they're inputs to the next spec revision. When the v1.3 spec is authored, each item here is either:

- **Adopted:** the v1.2 section gets an amendment in v1.3; item is removed from this backlog.
- **Reframed:** finding is resolved differently than originally noted; v1.3 reflects the new framing; item removed.
- **Dropped:** finding no longer relevant; item removed with a one-line rationale.

The doc itself stays in the repo as the staging area for spec churn between revisions. (v1.2 cycle absorbed amendments §6.8 OAuth + §6.9 model registry, both shipped 5/15.)
