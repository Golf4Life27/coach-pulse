---
name: security-sweep-akb
description: Sweep the AKB Inevitable codebase (CONVEYOR / Jarvis / coach-pulse) for the holes automated attackers and hostile inputs actually exploit, and report them as ranked attack stories. Use whenever the operator says "security sweep", "sweep this before ship", "is this safe to ship", "could this get hacked", or "am I leaking anything" — and proactively before ANY deploy that touches money, seller PII, outbound sends, a new secret, or a new webhook. MANDATORY before the DocuSign JWT / Scribe envelope path goes live, and again whenever a new inbound text path (SMS, email, webhook) reaches a model that holds tools.
---

# Security Sweep — AKB

Systems like this one don't get breached by geniuses. They get breached by scripts probing the same handful of doors: a route that never checks who's asking, a webhook that trusts any caller, a secret that touched git history once. And this system has a door most apps don't: **hostile text from strangers (seller SMS) flows into models that hold tools.** The sweep exists to check every door on purpose, on a schedule, instead of after.

## The one rule

**A finding is an attack story with an address — or it isn't a finding.** One plain sentence of what an attacker actually does ("anyone who POSTs to this route can mark a deal's EMD as sent"), plus `file:line`. No "best practice" padding. And the reverse holds: **zero findings is a valid result** — say it plainly rather than inventing severity.

## When it triggers

- Before any deploy touching money, PII, sends, secrets, or webhooks.
- Pre-Scribe gate: before DocuSign JWT credentials are installed and any envelope route is reachable.
- On request, whole-codebase ("has this been safe all along?").

## The method

### 1. Map the AKB attack surface (list first, judge later)

- **Vercel routes + crons** (`app/api/**`, scheduled jobs): for each — is the caller verified *server-side*? Which routes spend money (Anthropic, RentCast, Firecrawl, Quo) and what stops an outsider from running the meter?
- **Secrets**: grep the code AND git history. Vercel env is the only legitimate home. Treat `NEXT_PUBLIC_*` and anything in client bundles as published. Confirm Make.com's key and the production key stay separate lanes.
- **Airtable boundary**: token scopes minimal for each caller? Any base/record access reachable from the client? Record IDs (`rec...`) exposed in URLs where swapping one reads someone else's row?
- **Quo inbound webhook** — the classifier's front door. Is the signature verified? An unauthenticated inbound route means anyone on the internet can inject "seller replies" and steer the pipeline.
- **Text-to-tool paths (prompt injection with stakes)**: trace every path where outside text (seller SMS, email bodies, scraped listing text) reaches a model that can write records, draft messages, or call tools. The lane rule must be enforced *server-side*: no model in a hostile-text path can send, sign, or wire — a prompt is not a permission system.
- **Rendered outside text**: seller replies and notes displayed in Jarvis BroCards — any path to raw HTML rendering is an XSS door opened by a text message.
- **PII handling**: seller names/phones/emails in logs, audit summaries, error messages, client bundles.
- **DocuSign JWT (when present)**: key location, scope, and which route can create/send an envelope. Envelope send must sit behind the operator gate — verify the gate is code, not convention.

### 2. Hunt the classic kills, explicitly, in order

1. Secrets reachable from the browser or alive in git history.
2. Routes that trust the client (auth in UI only; "the button is hidden").
3. ID-swap access (change a `rec...` or numeric id, read someone else's data).
4. Unverified webhooks (Quo, Make, any payment hook later).
5. Injection — string-built queries/formulas; outside text rendered as HTML; input inside shell/exec.
6. No rate limit on expensive doors (model calls, enrichment lookups, login-like endpoints).
7. Admin by obscurity (unguessable URL or client-side password as the only lock).
8. Prompt injection where the model can act (see surface map — check each path found).
9. Dependency advisories — flag only what's exploitable *in this app*.

### 3. Verify before reporting

Trace the exploit path end to end. If middleware or an upstream check already blocks it, it's not a finding. Severity = exploitability × blast radius: **Critical** (money moved, sends hijacked, PII bulk-read — outsider-exploitable today) / **High** (same damage, needs an account or luck) / **Medium** (real, contained) / **Low** (hardening).

### 4. Report, then fix on approval

Worst first, plain English, ranked table: severity · attack story · `file:line` · fix. Then offer to fix in order — one at a time, re-verifying each. **Fixes are proposed, never self-authorized**: all changes land per the Decision Preconstraints, and nothing in this skill ever touches outbound sends or Type 2B actions.

## The standards

- Every finding: severity + one-sentence attack story + `file:line` + concrete fix.
- No finding without a traced exploit path; no severity inflation — a report where everything is critical is as useless as one where nothing is.
- Hostile-text→tool paths and webhook verification checked on *every* sweep, not sampled.
- Post-fix: the attack that worked is re-run and shown failing.

## The output

The ranked table, a one-line verdict ("N critical doors open" or "common doors shut"), and the offer to fix worst-first. After fixes: the re-check results.

## The honest limits

- This is a careful read of the code, **not a penetration test**. It cannot see the Vercel dashboard, Airtable share/automation settings, Quo console, Make scenario configs, or DNS — list those for a manual check each sweep.
- A clean sweep means the common doors are shut, not that the system is unhackable. Before real money flows through Scribe, a professional review is cheaper than the alternative.
- Advisories and code change weekly; a sweep is a snapshot. Re-run before each meaningful release — and always before a new secret or send path ships.

---
*v1.0 · 2026-07-06 · AKB-native prose (format inspired by public sweep patterns; safe for internal use and future productization). Supersede only via a logged Spine build_event referencing this version — never a silent edit.*
