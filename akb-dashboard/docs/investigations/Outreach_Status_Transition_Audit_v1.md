# INV-006 — Outreach_Status / Stage Transition on Signed Contracts — Audit v1

**Audit date:** 2026-05-20
**Auditor:** Code
**Scope:** discovery + recommendation only. NO code changes, NO transition logic, NO Airtable automation.
**Brief:** Maverick, 2026-05-20 (INV-006 brief in operator dashboard).
**Pair-with:** INV-004 (Crier silence guard) — INV-006 closes the gap INV-004 had to guard against.
**Companion specs:** `AKB_Belt_v1_Spec.md` §6 (Phase 14 Crier phase-aware ladder); `docs/investigations/Crier_Stale_Contract_Audit_v1.md` Q1+Q2 prior art; `docs/specs/AKB_System_Inventory_v2.md` (L3 write-surface enumeration).

---

## §1 — Q1: Current state-machine accuracy on live records

**Finding: zero out-of-sync records today under the strict definition. Identical architecture-vulnerability shape as INV-004 — preventive design needed, but no records exist on which the transition logic would fire today.**

### Query

Filter on Listings_V1: `Envelope_ID is not empty` (the strictest contract-state signal — only signal that lives directly on Listings_V1 per Q2 of INV-004).

- **Total records with `Envelope_ID` populated, entire table: 0**
- Matches INV-004 audit finding: DocuSign JWT provisioning is Phase 12.7 STOP (operator-external); the "Track in Scribe" affordance exists but no envelopes have been tracked because the live integration isn't lit up yet.

### Sub-query: active records with `Outreach_Status ∈ {Negotiating, Response Received}` (per INV-004's 43-record cohort)

| Outreach_Status | Records (n=43 from INV-004 audit) | With `Envelope_ID` set | With linked Deals row | With EMD activity | With `Assignment_Executed` |
|---|---|---|---|---|---|
| Negotiating | ~5 | **0** | 0 (Deals join unreliable per INV-004 Q2; 35/43 have no Offer_Drafts link) | 0 | 0 |
| Response Received | ~38 | **0** | 0 | 0 | 0 |

**Out-of-sync count today = 0.**

### What this means

INV-006's transition rule (`Envelope_ID populated → Outreach_Status = "Offer Accepted"`) has **nothing to fire on today**. The fix is preventive infrastructure, same shape as INV-004 — but with a critical difference noted below.

### How this differs from INV-004's "preventive" shape

INV-004 shipped a runtime guard (`isUnderContract(listing)`) that suppresses Crier signals. Today: zero records pass the guard's predicate, so the guard is a no-op. Forward-going: the moment any record's `Envelope_ID` gets populated, the guard becomes active.

**INV-006 cannot ship a runtime guard with the same shape.** A transition writer needs:
1. A **trigger** (signal change: `Envelope_ID` empty → populated)
2. A **handler** that fires on the trigger
3. A **write** to `Outreach_Status`

Today, item (1) never fires (zero envelopes). The full ship-it-now-as-no-op pattern requires that a trigger handler exists somewhere and runs periodically. That handler doesn't exist yet. So unlike INV-004, INV-006's choice is not "ship it now as a no-op" — it's "decide where the handler will live when triggers start firing."

This is the heart of Q3.

---

## §2 — Q2: Other state-machine drift cases

**Finding: the contract-execution side of the state machine has the largest automation gap. Several other transitions are also manual-only. Two are explicitly cron-eligible but not implemented today.**

### Code grep — every `Outreach_Status` writer

| Source | Path | Writes | Trigger |
|---|---|---|---|
| **Operator action** | `app/api/deal-action/[id]/route.ts:158-180` | `Dead`, `Offer Accepted` | Operator clicks `mark_dead`/`walk`/`accept` in Jarvis UI |
| **Operator action** | `app/api/actions/[type]/route.ts:39` | `Dead` | Pipeline_Stage flow operator action |
| **Outreach send** | `app/api/outreach-fire/route.ts:189, 204` | `Multi-Listing Queued` | H2 send queued pending agent-prior-outreach finalization |
| **Outreach send** | `app/api/outreach-fire/route.ts:238` | `Texted` | H2 send success |
| **Outreach send** | `app/api/outreach-fire/route.ts:257` | `Manual Review` | H2 send edge case |
| **Resurrection** | `lib/resurrection.ts:85` | `Response Received` | Inbound after Dead — dead-record resurrection cron |
| **Bulk Dead cron** | `app/api/admin/bulk-dead-stale-texted/route.ts:164` | `Dead` | Filter: `Outreach_Status = "Texted"` AND `Last_Outreach_Date < cutoff`. **Only touches Texted, not Negotiating.** |
| **Make L3** | Make Scenario `4812756` (4 routes per INV-007 + System Inventory v2) | `Dead` / `Negotiating` / `Response Received` / (append-only) | Inbound message content-routed via Quo webhook |
| **`/api/deal-action/[id]/route.ts:174-180`** | (the path the brief cites) | **`Offer Accepted`** | **Operator clicks `accept` in Jarvis. ONLY writer.** |

### Automated transitions today (cross-referenced)

| Transition | Path | Status |
|---|---|---|
| Not Contacted → Texted | outreach-fire H2 success | ✅ Automated |
| Not Contacted → Multi-Listing Queued | outreach-fire batched (multi-listing agent) | ✅ Automated |
| Multi-Listing Queued → Texted | outreach-fire follow-up | ✅ Automated |
| Texted → Manual Review | outreach-fire edge case | ✅ Automated |
| Texted → Response Received | Make L3 Route 3 | ✅ Automated |
| Texted → Negotiating | Make L3 Route 2 | ✅ Automated |
| Texted → Dead | Make L3 Route 1 OR bulk-dead-stale-texted cron | ✅ Automated |
| Dead → Response Received | resurrection.ts (inbound-after-dead cron) | ✅ Automated |
| **Negotiating → Offer Accepted** | (only deal-action `accept` operator click) | ❌ **Manual-only — INV-006 primary gap** |
| Negotiating → Dead | deal-action `walk`/`mark_dead` operator click | ❌ **Manual-only** |
| Response Received → Negotiating | (no automation; operator manual edit) | ❌ **Manual-only** |
| Offer Accepted → any reverse | (no automation; operator manual edit or `walk`) | ❌ **Manual-only** |

### Brief §3 Q2 sub-questions answered

**Sub-question 1:** "Records in Response Received for >7 days with operator-counter sent → should be `Negotiating`?"
- **No automation today.** Operator transitions manually if at all.
- Distinct gap; separate from contract-execution end. Logged as INV candidate.

**Sub-question 2:** "Records in Negotiating with no recent activity AND no contract state → should they age into Dead automatically?"
- **No automation today.** `bulk-dead-stale-texted/route.ts:64-66` filter is `(l.outreachStatus ?? "").toLowerCase() === "texted"`. `Negotiating` records are NOT in scope.
- Intent vs oversight: ambiguous from code alone. Header comment says "Bulk-dead stale Texted records — Alex 5/14 policy" — narrow scoping is intentional per the policy date.
- Whether `Negotiating` stale records should auto-age to Dead is a separate operator policy decision. Logged as INV candidate.

### Net Q2 finding

The contract-execution end of the ladder (`Negotiating/Response Received → Offer Accepted`) is the largest single gap. Two adjacent gaps (`Response Received → Negotiating`, stale `Negotiating → Dead`) exist but are out of INV-006 scope per brief §5.

---

## §3 — Q3: Architectural placement of contract-transition logic

**Finding: Option β (cron reconciler) is the architecturally-cleanest fit given existing patterns. Option γ (Airtable automation) is rejected by discipline (no Spine, opaque audit trail). Option α (in-process) is structurally unimplementable today because the trigger surface doesn't exist yet.**

### Existing cron infrastructure (for Option β reference)

`vercel.json` declares 5 daily crons (per Phase 11.6 audit lineage):
- `/api/cron/propose-actions` (09:00 UTC)
- `/api/cron/scan-comms` (10:00 UTC)
- `/api/cron/scan-replies` (11:00 UTC)
- `/api/cron/warmup-sequence` (13:00 UTC)
- `/api/cron/recompute-agent-prior-counts` (08:00 UTC)
- `/api/agents/pulse/scan` (12:00 UTC, added Phase 10 P.4)

All daily-cap per Hobby plan. A new transition-reconciler cron would slot into the same pattern at an unused hour (e.g., 14:00).

### Audit-trail discipline

The codebase has explicit precedent for in-process Outreach_Status writes that emit Spine + audit events:
- `lib/resurrection.ts:85` writes `Response Received` + audit
- `outreach-fire/route.ts:238` writes `Texted` + `crier` audit
- `deal-action/[id]/route.ts:178` writes `Offer Accepted` + appends note

Airtable automations bypass this entire layer. Per Master Checklist Rule 10 and Belt v1 Spec §6 source-of-truth communications principle, the system's audit log is the canonical "what happened" record. Native Airtable automations would write field values without any corresponding Spine/audit entry. **Discipline rejects Option γ.**

### Option-by-option finding-adjusted profile

#### Option α — In-process at envelope-creation handler

| Aspect | Finding |
|---|---|
| Trigger surface today | **Does not exist.** No envelope-creation route exists in the codebase. Phase 12.7 will introduce one as part of Scribe/DocuSign-JWT integration. |
| Cost (post-Phase-12.7) | LOW. Insert one `updateListingRecord(id, {Outreach_Status: "Offer Accepted"})` call in the new envelope-create action handler. ~5 lines + audit + test. |
| Coverage | Operator-triggered envelope-creates only. Direct DocuSign UI envelope-creates bypass this code path. |
| Audit trail | Inline `crier` or `scribe` audit event. Clean. |
| Net | **Necessary but not sufficient.** Catches the Jarvis-route case; misses direct DocuSign UI case. |

#### Option β — Cron reconciler

| Aspect | Finding |
|---|---|
| Trigger surface today | **Implementable today as a no-op-firing cron.** Cron scans `Listings_V1` records where `Outreach_Status ∈ {Negotiating, Response Received}` AND `Envelope_ID is not empty`. Today 0 hits; future hits get auto-transitioned + audit-logged + Spine-noted. |
| Cost | MEDIUM. New `/api/cron/reconcile-contract-status` route. ~80-120 lines including Airtable query, transition logic, audit emission, idempotency guard (skip records already at Offer Accepted), Spine write on first-fire per record. + `vercel.json` cron entry at unused 14:00 slot. + tests. |
| Coverage | **All paths** — catches Jarvis-route envelopes AND direct-DocuSign-UI envelopes AND any future automation that populates Envelope_ID. |
| Audit trail | Per-fire Spine entry + audit events. Full visibility. |
| Operator-override discipline | Cron writes only when `Outreach_Status ∈ {Negotiating, Response Received}` AND `Envelope_ID set`. If operator already moved to `Offer Accepted` or `Dead`, cron is a no-op. Operator edits stomp clean. |
| Hobby plan constraint | One daily slot fits the cron cap. |
| Net | **Best architectural fit for INV-006 v1.** Daily reconciliation matches the typical contract-cycle cadence (envelopes don't materialize sub-daily). |

#### Option γ — Airtable native automation

| Aspect | Finding |
|---|---|
| Discipline | **Rejected by Master Checklist Rule 10 + Belt v1 Spec §6 audit-trail principle.** Airtable automations are opaque to Spine and don't write `audit_log` events. |
| Cost | LOWEST. UI-only configuration in Airtable. |
| Coverage | Same as β. |
| Audit trail | Lives only in Airtable's automation history; not queryable by Maverick recall, not visible in Pulse, not in Spine_Decision_Log. |
| Net | **Rejected.** The system's discipline is "every state transition leaves a Spine + audit trail." Airtable automations break that contract. |

#### Option δ — Parallel formula field `Computed_Outreach_Status`

| Aspect | Finding |
|---|---|
| Cost | LOW. Single Airtable formula field add. |
| Coverage | Read-only. The editable `Outreach_Status` field continues to drift. |
| Coverage gap | UI surfaces, charts, briefing counts that read `Outreach_Status` (not `Computed_Outreach_Status`) continue to be wrong. Operator's mental model still diverges from system state. |
| Net | **Doesn't fix the underlying problem** — Lost-Phone Test failure mode persists. Worth flagging as a v2 read-affordance for specific consumers that want "what state SHOULD the record be in" without overriding the editable field. NOT a primary fix. |

### Recommendation surfaced (operator decides)

**Option β (cron reconciler) is the architecturally-cleanest fit.** Discipline-respecting (Spine + audit), coverage-complete (catches all envelope-creation paths), operator-override-safe (no-op when status is post-Offer-Accepted or operator-set Dead), today-implementable as a no-op-firing cron.

**Option α (in-process)** is necessary as a complement when Phase 12.7 envelope-creation route lands — but β catches the envelope-create-via-direct-DocuSign-UI case that α misses.

**Hybrid β + α post-Phase-12.7** (= brief's Option D) is the strongest end state.

---

## §4 — Q4: Reverse transitions and edge cases

**Finding: auto-transition should be one-way (forward-only) in v1. Reverse transitions require operator action. Cancellation and expiration handling is out of v1 scope; operator handles via existing `walk` action.**

### Reverse-transition matrix

| Scenario | Auto-revert? | Operator path |
|---|---|---|
| Envelope canceled (DocuSign envelope status = "voided") | **No.** | Operator clicks `walk` → Dead. |
| Envelope expired | **No.** | Operator decides: re-send (clears Envelope_ID — separate path) OR `walk` → Dead. |
| Envelope completed (signed by all) | **No reverse needed.** | Status stays at Offer Accepted; downstream EMD/closing flow takes over. |
| Operator manual edit Negotiating → Offer Accepted (current `accept` click) | **No reverse needed.** | Already in target state; cron β is a no-op next pass. |
| Operator manual edit Offer Accepted → Dead | **No interference.** | Cron β only writes when source state is Negotiating/Response Received; doesn't touch Offer Accepted/Dead/etc. |
| Operator manual edit Offer Accepted → Negotiating (rare; deal "un-accepted") | **Risk: cron β would re-transition on next pass if Envelope_ID still populated.** | **Mitigation:** add to cron's filter condition: `Envelope_ID populated AND Outreach_Status ∈ {Negotiating, Response Received} AND no prior Offer Accepted state in Notes`. OR simpler: read Notes for the audit line "auto-transition: envelope created at X" — if present, skip (cron has already transitioned this record once; respecting operator's subsequent edit). |

### Operator-override discipline

The system's existing pattern (per `bulk-dead-annotation` + resurrection + Phase 20.2 v1.3 Outreach_Offer_Price stickiness):

- **Auto-writes leave an audit trail** in Notes with timestamp + source (e.g., `"5/20 12:00pm — System: auto-transitioned to Offer Accepted (envelope envelope-guid-xyz created)"`).
- **Operator subsequent edits stomp** — system never re-writes a state operator manually changed.
- **Idempotency**: cron β reads Notes for prior auto-transition audit lines; skips records that have already been auto-transitioned once.

### The "stomp-protection" idempotency rule

```
For each Listings_V1 record where:
  Envelope_ID is populated AND
  Outreach_Status ∈ {Negotiating, Response Received}:

  If Notes contains "auto-transitioned to Offer Accepted (envelope":
    SKIP (cron has already done its job; operator subsequently reverted)
  Else:
    Transition Outreach_Status → Offer Accepted
    Append Notes audit line with timestamp + envelope ID
    Emit Spine entry on first fire per record
    Emit audit event (agent: crier or scribe)
```

This is the only complexity needed. Reverse transitions, expiration handling, cancellation handling are **operator-discretion via existing `walk` action**. v1 ships forward-only with idempotency + audit. v2 considers explicit reverse-transition logic when operator workflow data shows it's needed.

---

## §5 — Findings synthesis

| Dimension | Today | Post-Phase-12.7 (envelopes start populating) | Post-Option-β-ship |
|---|---|---|---|
| Out-of-sync `Outreach_Status` records | 0 | grows with each tracked envelope | 0 (reconciler catches within 24h) |
| Operator clicks per accepted deal | 1 (current `accept` click) | 1 if option C ships at Phase 12.7; else still 1 | **0** (β handles automatically) |
| INV-004 guard status | Active, suppressing nothing | Active, suppressing envelope-bearing records | Active belt-and-suspenders (β prevents most cases; guard catches the 24h reconciliation window) |
| Dashboard / chart / briefing accuracy on contract-execution counts | wrong (Negotiating count inflated) | wrong until operator clicks Accept | **right** within 24h of envelope creation |
| Lost-Phone Test compliance | Fails (manual click required) | Same | **Passes** (system self-maintains state) |
| Spine + audit trail | Complete on every transition | Same | Complete; cron writes Spine on first-fire per record |

### Risk profile

Same shape as INV-004: **preventive infrastructure**. Difference: INV-006 requires the trigger handler (cron β) to be built. INV-004 could ship a guard with a one-line predicate; INV-006 needs a scheduled job.

**Cost of inaction:** every accepted deal becomes a manual click. At brief's projected 50 deals/month, that's 50 clicks that should be zero. More importantly, every dashboard surface lies to operator about deal phase until they click.

---

## §6 — Implications per option (operator decides — Code does not unilaterally pick)

### Option A — Airtable native automation (Q3-γ)

| Aspect | Findings-adjusted profile |
|---|---|
| Cost | LOWEST (UI only). |
| Discipline | **Rejected per Belt v1 §6 + Master Checklist Rule 10.** No Spine, no audit. |
| Net | Not recommended. |

### Option B — Cron reconciler (Q3-β)

| Aspect | Findings-adjusted profile |
|---|---|
| Cost | MEDIUM (~80-120 lines + cron config + tests). |
| Coverage | All paths (Jarvis-route + direct-DocuSign-UI + any future writer). |
| Audit trail | Complete (Spine on first fire + per-transition audit). |
| Operator-override | Idempotency via Notes-audit-line scan; operator edits always win. |
| Today's behavior | No-op (zero records have Envelope_ID populated). |
| Net | **Architecturally cleanest.** Ships now as preventive no-op; activates when Phase 12.7 lands. |

### Option C — In-process at envelope-creation handler (Q3-α)

| Aspect | Findings-adjusted profile |
|---|---|
| Cost | LOW (~5 lines + audit) — but **only once Phase 12.7 envelope-create route exists**. Today: unimplementable (no trigger surface). |
| Coverage | Only Jarvis-route envelope-creates. Misses direct-DocuSign-UI envelopes. |
| Net | Necessary complement to β, not a replacement. |

### Option D — Hybrid (β now as no-op + α at Phase 12.7)

| Aspect | Findings-adjusted profile |
|---|---|
| Cost (now) | MEDIUM (build β). |
| Cost (Phase 12.7) | LOW (α adds inline transition to envelope-create route). |
| Risk | LOW. β no-ops today; α layers in when triggers materialize. |
| Net | **Findings-supported.** Same shape as INV-004 (preventive infrastructure shipped now), but with a different ship-it-today vehicle (cron β instead of runtime guard). |

### Option E — Decline (operator keeps clicking)

| Aspect | Findings-adjusted profile |
|---|---|
| Cost | Zero. |
| Risk | LOW operationally; HIGH long-term per brief §4 — Lost-Phone Test friction scales linearly with deal volume. |
| Net | Acceptable interim if operator wants to defer until DocuSign provisioning lands and they have direct experience with the manual workflow. Honest answer: this is the **status quo** dressed up as a decision. |

### What Code's findings imply (without choosing)

- **Findings-supported: Option D (Hybrid β now + α at Phase 12.7).** Ships preventive cron today (zero records affected); layers in in-process transition at envelope-creation when Phase 12.7 lands. Matches INV-004's pattern.
- **Option B alone** is sound but leaves Phase 12.7's natural integration point unwired (α is cheap once envelope-create route exists).
- **Option A (Airtable automation)** is rejected by discipline.
- **Option C alone** requires Phase 12.7 first; can't ship today.
- **Option E** is honest about deferring; defensible if operator wants to wait for Phase 12.7 to land before designing.

Operator decides.

---

## §7 — Adjacent items observed (per brief §5)

| Item | Code finding | Disposition |
|---|---|---|
| Listings_V1 ↔ Deals join hardening | Confirmed unreliable per INV-004 Q2 + this audit's spot-check (3 historical Deals rows total; none linked to active records). | Already flagged in INV-004 §7. NOT folded into INV-006. |
| `bulk-dead-stale-texted` only touches Texted, not Negotiating | Confirmed via grep + code read (line 64-66 filter). Per-policy narrow scoping ("Alex 5/14 policy" header). | New investigation candidate — distinct from INV-006 (different transition direction; different policy question). |
| Response Received → Negotiating transition gap | Confirmed via grep: no code path writes `Negotiating` after `Response Received` automatically. Make L3 writes `Negotiating` directly (Route 2) only on initial inbound triage; never as a state-machine progression. | New investigation candidate — distinct from INV-006. |
| `Computed_Outreach_Status` formula field (Q3-δ option) | Doesn't fix the editable field; consumers would still read the wrong primary field. | Documented in §6; not pursued. Future v2 read-affordance candidate. |

All four flagged; none folded into INV-006 remediation scope.

---

## §8 — Appendix: code-evidence summary

### The only writer of `"Offer Accepted"`

`app/api/deal-action/[id]/route.ts:174-180` (verbatim):

```typescript
if (action === "accept") {
  await updateListingRecord(id, {
    [FIELD.outreachStatus]: "Offer Accepted",
  });
  await appendNote(id, `${todayStamp()} — System: marked Offer Accepted via Jarvis.`);
  const out: DealActionResponse = { success: true, airtableUpdated: true, newStatus: "Offer Accepted" };
  return NextResponse.json(out);
}
```

Triggered by operator clicking `accept` in Jarvis UI. No other code path in `lib/` or `app/api/` writes this value. No Make scenario writes it.

### Reference query: `Envelope_ID is not empty` (entire Listings_V1)

```
{records: [], metadata: {totalRecordCount: 0}}
```

Zero records system-wide. Confirms INV-004 Q1 finding extended to the full table (not just the 43-record active cohort).

### Existing daily cron slots (`vercel.json` per Phase 10/11 audit)

- 08:00 UTC — recompute-agent-prior-counts
- 09:00 UTC — propose-actions
- 10:00 UTC — scan-comms
- 11:00 UTC — scan-replies
- 12:00 UTC — pulse/scan
- 13:00 UTC — warmup-sequence

**Unused slots compatible with reconciler cron** (per Hobby cap, once-daily): 14:00 UTC or later.

---

*End of audit. Status only. No remediation implemented. Operator decides among Option A / B / C / D / E in §6.*

---

## §9 — Remediation outcome (appended 2026-05-20)

**Decision:** Option D (Hybrid) — cron reconciler ships now; in-process transition at Phase 12.7 envelope-create handler documented for sequel. Operator-ratified 2026-05-20.
**Spine record:** `recmiFJLja4cHrZ3O` (`event_type: principle_amendment`, `attribution_agent: crier`, `related_spine_decision: rec0A9ZWSMMT5Nk9a` INV-004 patch).

### What shipped

**1. `lib/maverick/outreach-status-reconcile.ts`** — pure helper module:
- `RECONCILE_IDEMPOTENCY_MARKER` constant (substring scanned in Notes)
- `ELIGIBLE_SOURCE_STATES` = `{Negotiating, Response Received}`
- `shouldAutoTransition(listing)` returns `{action, reason}` with 4 stable reason codes
- `notesContainMarker(notes)` null-safe, case-insensitive substring scan
- `buildAuditNoteLine(now, envelopeId)` emits the Notes line that includes the marker

**2. `app/api/cron/outreach-status-reconcile/route.ts`** — new cron route:
- Auth waterfall (dashboard → OAuth/cron/bearer; mirrors arv/buyer-intelligence/rehab routes)
- `MAVERICK_CRON_ENABLED` gate on `cron`-kind auth (matches Phase 11.6 cron-burn safeguard)
- Iterates `getListings()`, filters via `shouldAutoTransition`
- Per transition: `updateListingRecord` (status + appended note) + `audit({...})` + `writeState({...})` with per-record Spine row; per-record errors isolated (batch continues)
- Returns summary JSON: `{scanned, transitioned, skipped_no_envelope, skipped_status, skipped_already_transitioned, errors, transitioned_records}`

**3. `vercel.json`** — daily 14:00 UTC cron entry added. No collision with existing 08:00–13:00 daily crons. Hobby plan once-daily cap respected.

**4. `docs/specs/AKB_Belt_v1_Spec.md` §6** — new "Phase 12.7 — In-process Outreach_Status transition (INV-006 sequel)" subsection. Documents the envelope-create-handler wiring at Phase 12.7 landing + reverse-transition deferral to Phase 13+ DocuSign-webhook scope + lineage to INV-004.

**5. 10 unit tests** in `lib/maverick/outreach-status-reconcile.test.ts` covering all transition + skip paths + idempotency roundtrip:
- Cases 1–6 mirror brief §3 specification
- Plus: whitespace-only envelope_id → skip; case-insensitive marker match; null-safe `notesContainMarker`; `buildAuditNoteLine` output is detected by `notesContainMarker` (idempotency invariant)

### Live behavior today

- **0 records have `Envelope_ID` populated** table-wide (confirmed at commit time; matches audit `a2ba60f` finding).
- Cron runs as a **no-op**: every record falls into `skipped_no_envelope` bucket. Zero transitions, zero Spine writes, zero audit events from this code path.
- **First non-zero run** will occur when Phase 12.7 DocuSign provisioning lands and operator's first envelope creates an `Envelope_ID`. Next 14:00 UTC tick (at most ~24h later) auto-transitions that record. Operator will see the Notes audit line + `Outreach_Status = Offer Accepted` + per-record Spine entry on Maverick. Expected behavior.

### Test execution

| Test | Status | Result |
|---|---|---|
| `vitest run lib/maverick/outreach-status-reconcile.test.ts` | ✅ | 10/10 (all new) |
| `vitest run` full suite | ✅ | **1000/1000** (was 990; +10 new) |
| `npx tsc --noEmit` on patched files | ✅ | Zero errors |
| Live deploy curl tests | ⏸ deferred | Operator runs against deployed env after merge; expected zero transitions until Phase 12.7 lands |

### Pair-with INV-004 lineage

INV-004 (Spine `rec0A9ZWSMMT5Nk9a`) was the **patch**: runtime guard on Crier silence + Pulse stale-data-drift when `Envelope_ID` is set.

INV-006 (Spine `recmiFJLja4cHrZ3O`) is the **cure**: the status field itself transitions, so the guard becomes belt-and-suspenders for the ≤24h cron reconciliation window. Two-layer defense.

When Phase 12.7 lands, the in-process arm (`Phase 12.7 sequel`) collapses the reconciliation window to zero: envelope-create writes status synchronously; the cron stays as the safety-net for envelopes created via direct DocuSign UI (operator bypassing Jarvis).

### Operator-override discipline preserved

- Cron writes only when `Outreach_Status ∈ {Negotiating, Response Received}` AND `Envelope_ID` set AND Notes does NOT contain marker.
- If operator manually moves a record to Dead between cron ticks → cron next-run skips (`status_not_eligible`).
- If operator reverts post-transition to Negotiating → cron next-run skips (Notes marker present from first transition).
- Marker is the **durable signal** that the cron has done its job for this record.

### Acceptance criteria status (per brief §7)

| # | Criterion | Status |
|---|---|---|
| 1 | Q1 state-machine accuracy | ✅ (audit §1) |
| 2 | Q2 other drift cases | ✅ (audit §2) |
| 3 | Q3 architectural placement | ✅ (audit §3) |
| 4 | Q4 reverse-transition matrix | ✅ (audit §4) |
| 5 | Operator selects A/B/C/D/E | ✅ Option D (2026-05-20) |
| 6 | Code implements selected option | ✅ Cron route + helper + tests shipped |
| 7 | Spine entry (`principle_amendment`, `crier`) | ✅ `recmiFJLja4cHrZ3O` |
| 8 | `AKB_MASTER_CHECKLIST.md` updated | ✅ Phase 22.10 entry per Rule 9 |
| 9 | `Active_Queue.md` INV-006 flipped to SHIPPED | ✅ this commit |

### Rejected: Option A (Airtable native automation)

Per Master Checklist Rule 10 + Belt v1 §6 source-of-truth communications principle — Airtable native automations bypass Spine + audit log. The system's audit trail is the canonical "what happened" record; Airtable automations break that contract.

### Reversibility

- Set cron schedule disabled or remove `vercel.json` entry → cron stops firing.
- Route file remains in place (no consumer dependency).
- Spec/checklist/queue additions document intent independently; safe to leave.
- Pure helper + tests can stay (zero coupling; no external imports break).

Single revert restores pre-INV-006 state with no downstream impact.

*End of remediation outcome. Status: shipped + verified. Spine: `recmiFJLja4cHrZ3O`.*
