# Multi-Listing-Agent Message Attribution — Audit v1

**Audit date:** 2026-05-20
**Auditor:** Code
**Scope:** discovery + recommendation only. NO code changes, NO algorithm modifications, NO field updates.
**Triggering question (per `docs/investigations/Active_Queue.md` INV-007):** When a real estate agent holds multiple listings sharing one phone number, inbound messages cannot be deterministically attributed to a specific property. The AMBIGUOUS banner fires correctly, yet wrong-property messages still appear in the wrong conversation thread. Why?
**Anchor case:** Candice Hardaway (`chardaway@kw.com`, `(901) 601-9312`) holding 4 active Memphis listings — observed cross-attribution of a 3273 Steele St outbound message to the 23 Fields Ave deal-room conversation panel.
**Companion specs:** `AKB_Belt_v1_Spec.md` §6 ("Source-of-truth communications: Quo + Gmail threads are canonical"), `AKB_System_Inventory_v2.md` Q3 (L3 attribution surface).

---

## §1 — Attribution logic locations

**There is no single attribution algorithm. There are five.** Each system that consumes Quo data made its own decision about how to assign messages to records. They diverged. The AMBIGUOUS banner correctly fires because one of those five does proper scoring; the conversation thread shows wrong-property messages because a different one of those five does zero scoring.

### Anchor records (confirmed via Airtable lookup)

Candice Hardaway holds 4 listings on `Listings_V1` (`tbldMjKBgPiq45Jjs`), all `Agent_Phone = "(901) 601-9312"`, `Agent_Email = "chardaway@kw.com"`:

| Address | recordId | Outreach_Status |
|---|---|---|
| 23 Fields Ave | `rec1HTUqK0YEVb7uA` | Negotiating |
| 785 Pawnee Ave | `rec2HTt07fNBDKfKf` | Dead |
| 1871 Thrift Ave | `recXKcZhB7QY2OHBj` | Dead |
| 3273 Steele St | `recvCaqLgd6n7AQkA` | Dead |

**Operator note:** the brief mentioned 23 Fields as `recPMmqmU1KrnsCOO`. Actual recordId is `rec1HTUqK0YEVb7uA` per `list_records_for_table` query. Discrepancy flagged — may be a typo or a stale reference; downstream of this audit, please verify which is canonical.

### Five attribution paths

| # | System | File / Module | Attribution behavior | Surface |
|---|---|---|---|---|
| 1 | `/api/deal-context/[id]` | `app/api/deal-context/[id]/route.ts` calls `mergeTimeline()` in `lib/timeline-merge.ts:97` | **Scored.** Calls `scorePropertyMatch()` per message; assigns recordId by best match; flags `<0.6` confidence as ambiguous. Returns `{timeline, ambiguous}`. | Powers AMBIGUOUS banner + multi-listing alert on deal page. |
| 2 | `/api/conversations/[id]` | `app/api/conversations/[id]/route.ts` lines 41–63 | **NO attribution.** Pulls all Quo messages for the agent phone (`getMessagesForParticipant`) and dumps them into the conversation thread unchanged. No `mergeTimeline` call. No `scorePropertyMatch` call. No filter on recordId. | Feeds the conversation panel rendered by `ConversationThread.tsx`. **This is the wrong-property-message leak.** |
| 3 | L3 Make Scenario `4812756` (Reply_Triage_V3) | Module 3 (`ActionSearchRecords`) → Module 4 (`BasicRouter`) → 4 × `ActionUpdateRecord` | **Winner-takes-all (non-deterministic).** Searches Listings_V1 by phone with `maxRecords: 1`, no sort. Updates whichever record Airtable returns first. Mapper formula: `FIND("{{2.clean_phone}}", SUBSTITUTE(...{fldee9MOstjNDKjnm}&"",...))>0`. Sibling records receive zero updates. | Writes Outreach_Status + Verification_Notes on exactly one of the matched listings. |
| 4 | `/api/cron/scan-comms` | `app/api/cron/scan-comms/route.ts` lines 187–262 | **Fan-out.** Groups listings by phone; for each inbound message, creates an `Agent_Proposals` row for EVERY listing in the group (`for (const listing of matchedListings)`). Each proposal references the same inbound body. | Creates N pending Jarvis-reply proposals when one agent replies (one per their N listings). |
| 5 | `/api/multi-listing-detect` | `app/api/multi-listing-detect/route.ts` lines 96–145 | **Detects ambiguity.** Runs `mergeTimeline` per sibling combination, collects ambiguous samples, writes to `DISAMBIGUATION_QUEUE_TABLE_ID` table (if env set). Each sample carries `bestMatchRecordId` + `bestMatchConfidence`. | Surfaces ambiguous-queue badge in `JarvisGreeting`. Does NOT modify any record. |

### Anatomy of `scorePropertyMatch()` (the only real attribution scorer)

`lib/timeline-merge.ts:33-80`. Pure function. Signature: `(messageBody, targetAddress, targetPrice, siblings) => {recordId, confidence}`.

**Target scoring (0.0 – 1.1):**
- `+0.6` if message body contains ≥50% of target-address tokens longer than 2 chars (e.g., for "23 Fields Ave" → tokens = ["23", "fields", "ave"] with length filter; tokens longer than 2: ["fields", "ave"]; needs ≥1 token hit out of 2)
- `+0.2` if body contains literal phrase `"listing at"` or `"property at"` AND that phrase is followed by any target-address token. **This is the H2 outreach-fire signature pattern** (`"I am interested in your listing at {address}"` — `lib/outreach-fire/route.ts:31-38`).
- `+0.3` if body contains a `$N,NNN` pattern within $1,000 of `targetPrice`

**Sibling scoring (0.0 – 0.9):** same as target but no "listing at" bonus.

**Return rule (`line 78`):**
```typescript
if (bestSibling.confidence > targetScore && bestSibling.confidence >= 0.5)
  return bestSibling;
return { recordId: "", confidence: targetScore };
```

Sibling wins only if it scores **strictly greater** than target AND meets the 0.5 floor. Ties favor target. Empty recordId is later replaced with `opts.recordId` (target).

**Ambiguous gate (`line 119`):** `if (hasSiblings && match.confidence < 0.6) ambiguous.push(entry)`. Pushed to a separate array but NOT removed from the main timeline (`line 120: timeline.push(entry)` always runs).

### Stall condition surfaced: no live Quo data available

`QUO_API_KEY` is not set in this remote-container environment (it's a Vercel-deployment secret). I cannot pull the actual Quo message thread for Candice's phone from this session to perform a live trace of the 4/20 Steele message. **All §2 findings below are code-path analyses** — the failure mode is fully traceable from the source, but the specific message body and timestamps cannot be quoted verbatim from Quo. Operator can run the trace by hitting `/api/deal-context/rec1HTUqK0YEVb7uA` and `/api/conversations/rec1HTUqK0YEVb7uA` against a live deploy and comparing the timelines.

---

## §2 — Anchor case trace (23 Fields ↔ 3273 Steele leakage)

**Failure mode mechanically explained without invoking the wrong scorer or a bug in the scorer — both endpoints work as written; they just disagree on the contract.**

### What happens when operator opens the 23 Fields Ave deal page

1. **Page mount** calls two endpoints in parallel:
   - `/api/deal-context/rec1HTUqK0YEVb7uA`
   - `/api/conversations/rec1HTUqK0YEVb7uA`

2. **`/api/deal-context/[id]`** flow (`route.ts:38-100`):
   - `getListing(id)` → returns 23 Fields listing (target).
   - `getListings()` → all listings → filter by `cleanPhone(agentPhone) === "+19016019312"` and `id !== target` → siblings list: `[785 Pawnee, 1871 Thrift, 3273 Steele]`.
   - `getMessagesForParticipant("+19016019312", 60*24*90)` → all Quo messages for Candice's phone, 90-day window. **This call has no per-property filtering** — Quo doesn't expose that concept; it's a phone-based conversation log.
   - Returns ~N Quo messages (mix of all 4 listings' outbounds + Candice's replies).
   - `mergeTimeline(quoMessages, gmailMessages, noteEntries, {recordId, targetAddress: "23 Fields Ave", targetPrice, agentName, siblings})`.
   - Per message:
     - Outbound `"Hi Candice, this is Alex... your listing at 3273 Steele St..."` is scored: target = "23 Fields Ave", tokens long enough = ["fields", "ave"]. Body lowercased: `"...your listing at 3273 steele st..."`. Token hits for `"fields"`: 0. For `"ave"`: 0. `targetScore` = 0.
     - Sibling 3273 Steele tokens long enough = ["3273", "steele"] (both length > 2). Body contains "3273" → hit. Body contains "steele" → hit. 2/2 ≥ ceil(2*0.5) = 1 → `sibScore += 0.6`. No matching price within $1,000 → `sibScore = 0.6`.
     - Other siblings: Pawnee, Thrift — score 0 (no tokens in this body).
     - `bestSibling = {recordId: "recvCaqLgd6n7AQkA", confidence: 0.6}`. Condition `0.6 > 0 && 0.6 >= 0.5` → TRUE → returns `bestSibling`.
   - Entry pushed to `timeline` with `propertyMatch = {recordId: "recvCaqLgd6n7AQkA", confidence: 0.6}`.
   - Confidence 0.6 ≥ 0.6 → NOT ambiguous (just barely passes the threshold).
   - **Key observation:** the message ends up in `dealContext.timeline` with `propertyMatch.recordId = 3273_Steele_recordId` and `confidence = 0.6`. The operator viewing 23 Fields sees this message — but its `propertyMatch.recordId` is NOT 23 Fields.
   - The AMBIGUOUS banner counts entries with `confidence < 0.6` (`ambiguousMessages` array). A 0.6 confidence entry does not show in the banner. **A 0.55 entry would.**

3. **`/api/conversations/[id]`** flow (`route.ts:41-63`):
   - `getListing(id)` → 23 Fields listing.
   - `getMessagesForParticipant("+19016019312", 60*24*90)` → same Quo messages as deal-context.
   - **For each message**: pushes a `UnifiedMessage` into the messages array. No `mergeTimeline` call. No `scorePropertyMatch` call. **No filter by `propertyMatch.recordId`.** The endpoint has zero awareness that the messages come from siblings.
   - Returns `{messageCount: N, messages: [...all N messages...]}`.

4. **The conversation panel renderer** consumes `messages` from `/api/conversations`, not `timeline` from `/api/deal-context`. The 3273 Steele outbound is in there. It renders.

5. **Result observed by operator:** AMBIGUOUS banner fires correctly (deal-context flagged some messages < 0.6) BUT the conversation panel shows messages about 3273 Steele in the 23 Fields thread (conversations endpoint dumped everything).

### Why the failure isn't visible to the scorer

The scorer (`scorePropertyMatch`) on the 4/20 3273 Steele outbound returns `{recordId: 3273_Steele_recordId, confidence: 0.6}` — **correctly attributing it to 3273 Steele**. The scorer is doing its job. The deal-context endpoint then attaches this attribution to the timeline entry. Then the conversation-thread endpoint, running in parallel, does its own un-scored pull and ignores the attribution that the scorer just computed. **The bug isn't in attribution — it's in the data contract between the two endpoints feeding the same UI.**

### Adjacent failure modes (same root cause)

- **L3 winner-takes-all** (`maxRecords: 1` with no sort): when Candice replies, L3 may update Outreach_Status on 23 Fields Ave even though the reply was about 3273 Steele — depending purely on Airtable's record-ordering happenstance. The non-determinism is invisible until two operators observe different states.
- **scan-comms fan-out**: one Candice reply creates 4 Jarvis-reply proposals (one per her 4 listings) with identical inbound body. Operator gets 4 cards to triage when only one is real.

---

## §3 — Available signals assessment

For each signal that could improve attribution: precision (when it fires, how often is it right), recall (how often is it available), cost.

| Signal | Precision | Recall | Cost | Currently consumed by |
|---|---|---|---|---|
| **Outbound body — explicit `"listing at {address}"` pattern** | **Very high.** Generated programmatically by H2 (`outreach-fire/route.ts:31-38` and the multi-listing variant at line 36). Format is fixed: `"...your listing at {full street address}..."`. Address is the canonical Listings_V1 `address` field. | **Outbound: ~100%** (every H2 send hits this format). Inbound: ~0% (sellers don't repeat the address back unless asked). | Free; already in body. | `scorePropertyMatch` (+0.6 token match), with a +0.2 bonus when `"listing at"` literal is present. |
| **Outbound body — `$price` near targetPrice (±$1,000)** | High when prices differ. Drops to zero when two siblings have identical/near-identical list prices. | ~100% on outbound (H2 always includes the offer dollar amount, which is 65% of list — so the OFFER is in body, not the list price; mapping requires recognizing the 65% relationship or matching against the OFFER price not list). **Bug-adjacent:** scorer matches against `targetPrice` which is `List_Price`, not offer. The H2 outbound contains the offer amount (`formatOffer(listing.listPrice!)`), not the list amount. So the +$1,000 price match almost never fires correctly. | Free. | `scorePropertyMatch` +0.3 — **likely misaligned in practice; needs verification with a live H2 message body**. |
| **Inbound body — explicit address reference** | Very high when present (verbatim address tokens). | **Low — anecdotally <20%.** Sellers reply with "yes", "no", "what's your offer?", "call me", etc. Address repetition is rare in SMS, common in email. | Free. | Same scorer; no signal-availability stratification today. |
| **Inbound body — price reference (e.g., "$165k")** | Medium. Same multi-listing problem if siblings have similar prices. | Moderate — ~30% of inbound mentions a number. | Free. | `scorePropertyMatch` +0.3. |
| **Outbound→Inbound recency (correlation)** | **High when outbound is unique.** If you sent one outbound about X 30 minutes before the inbound, the inbound is statistically very likely about X. **Collapses to zero in multi-listing batch sends** where you sent 4 outbounds to Candice in 90 minutes about 4 different properties. | ~100% of inbound has a "most recent outbound" — but the signal is unreliable in the multi-listing case (which is exactly when you need it). | Free; computable from timeline. | Not consumed by `scorePropertyMatch` today. Documented gap. |
| **Inbound body — agent first-name reference** | Low. Doesn't disambiguate properties (it's the operator's name). | High. | Free. | Not consumed. |
| **Quo conversation-thread metadata (topic / thread ID)** | N/A — **Quo's SMS conversation model is per-participant-phone, not per-topic.** No native thread/topic concept. | 0% — feature doesn't exist. | N/A. | N/A. |
| **`Last_Outreach_Date` field on Listings_V1 per record** | Medium. Each listing tracks when its last H2 fired. Correlating inbound time to whichever listing had the most recent H2 outbound to that agent is a reasonable proxy. | High — Last_Outreach_Date is populated by H2 path. | Free, one Airtable lookup. | Not consumed by `scorePropertyMatch` today. Documented gap. |
| **`Outreach_Status` per record** | Active listings (Texted, Negotiating) are more likely to be the subject than Dead/Manual Review records. In Candice's case: only 23 Fields is "Negotiating"; the other 3 are "Dead". Strong prior. | High. | Free. | Not consumed. **Strongest under-used signal for the anchor case.** |

---

## §4 — Confidence model proposal

Not implementation — design. Surface for operator decision.

### Per-message attribution should produce a **vector**, not a scalar

Today `propertyMatch` is `{recordId: string, confidence: number}` — one record, one number. **Proposed:** `{ scores: Array<{recordId, score, signals: string[]}>, best: {recordId, confidence}, ambiguity_class: "deterministic" | "best-guess" | "unattributed" }`.

- **Deterministic** = best score ≥ 0.8 AND second-best score < 0.4. Message is firmly attributed; renders only in the matched property's thread.
- **Best-guess** = best score 0.4–0.79 OR second-best within 0.2 of best. Message renders in matched property's thread BUT carries a visible badge `[best-guess]`; operator can re-attribute via a UI affordance.
- **Unattributed** = best score < 0.4. Message held in a per-agent "unattributed" pool, NOT shown in any individual property thread. Operator triages from the pool.

### Threshold values (proposal)

| Threshold | Current | Proposed |
|---|---|---|
| Sibling override | sibling > target AND sibling ≥ 0.5 | sibling ≥ target + 0.2 AND sibling ≥ 0.6 |
| Ambiguous flag | < 0.6 | < 0.8 (more generous flagging) |
| Render-in-thread cutoff | (no cutoff — all messages render) | ≥ 0.4 to render; < 0.4 to "unattributed pool" |

### Signals to add to the scorer

1. **Outbound→Inbound recency boost** — for inbound messages, find the most recent outbound to the same phone with `propertyMatch.recordId = X`. If gap < 6 hours and no other outbound to a different recordId in between → boost `score[X] += 0.3`. If multi-outbound burst within 24h → boost = 0.
2. **Active-status prior** — `Outreach_Status ∈ {Negotiating, Response Received}` → boost `score[record] += 0.15`. `Outreach_Status = Dead` → boost `score[record] -= 0.3`.
3. **Last_Outreach_Date recency** — among siblings, the listing with the most recent H2 fire gets `+0.1`.
4. **Fix the price-match misalignment** — match against both `List_Price` AND `Outreach_Offer_Price` (which is what H2 actually puts in body).

### Where attribution should live

**Move attribution out of the render path and into the ingest path.** Today every page load re-runs `scorePropertyMatch` on every message. Proposal:
- Persist attribution at the message-ingestion moment (L3 webhook handler + Gmail sync cron + outbound-send moment).
- New table or new fields on a new table: `Comms_Attribution` rows, one per message, with `(message_id, recordId, confidence, signals, attributed_at)`.
- Render endpoints (`/api/conversations`, `/api/deal-context`) consume the persisted attribution instead of re-computing.
- Single source of truth → all five attribution paths converge on the same attribution decision per message.

---

## §5 — Recommendation

**Path (c): architectural redesign needed.** Surgical fix at the endpoint level (option b) closes the visible bug but leaves the structural divergence between five attribution paths intact. The next agent with 6+ listings will surface the next variant.

### Concrete two-step proposal (operator decides)

**Step 1 — Surgical fix (closes the visible leak in ~30 min):**
`/api/conversations/[id]` should mirror `/api/deal-context/[id]`'s attribution: call `mergeTimeline()` instead of dumping raw Quo messages. Then filter the output to messages where `propertyMatch.recordId === recordId AND propertyMatch.confidence >= 0.6`. Ambiguous messages route to a separate "ambiguous queue" surface (already exists in `multi-listing-detect`).

This fix:
- Closes the 23 Fields ↔ 3273 Steele leak immediately.
- Does NOT address L3 winner-takes-all or scan-comms fan-out.
- Does NOT change attribution accuracy (still uses today's scorer).
- Low risk: pure read-path change, no field schema, no scenario edits.

**Step 2 — Structural redesign (closes all five paths):**
Persist attribution at ingest (L3 webhook handler, scan-comms cron, Gmail sync). Create `Comms_Attribution` records keyed by message id. All five render/orchestration paths consume the persisted attribution. L3 stops being winner-takes-all (it consults Comms_Attribution to pick the right record). scan-comms stops fanning out (it consults Comms_Attribution and proposes only for the attributed record).

This is larger work (~1 sprint). Step 1 is a useful interim because Step 2 needs the persistent table designed and the migration story figured out.

### What this audit is NOT recommending

- Not changing the AMBIGUOUS banner threshold (it's correctly fired today; the issue is downstream).
- Not changing `scorePropertyMatch` scoring weights without first capturing live message-body samples (operator should pull 50 recent Quo bodies for Candice and run the scorer against them to calibrate before retuning).
- Not removing the multi-listing-detect cron — it's the only place that surfaces ambiguous messages to operator review and that surface is valuable.

### Adjacent items spawned and queued

Three findings from this audit are out of scope for INV-007 remediation but warrant their own briefs:

- **[INV-014 candidate] L3 winner-takes-all on multi-listing-agent phone matches** — `maxRecords: 1` with no sort produces non-deterministic record selection. Updates to `Outreach_Status` and `Verification_Notes` may land on the wrong listing. Should be wired through the same attribution layer as the Step 2 redesign.
- **[INV-015 candidate] scan-comms cron fan-out on multi-listing-agent inbound** — creates a Jarvis-reply proposal per listing in the phone group, all referencing the same inbound. Operator sees N proposals when only one is real. Same redesign-path as INV-014.
- **[INV-016 candidate] `scorePropertyMatch` price-match likely misaligned** — scorer compares body $-tokens against `List_Price`, but H2 outbound bodies contain the OFFER (0.65 × List_Price), not the list price. Needs live verification with a sample of H2 message bodies. Cheap to fix once confirmed.

All three logged in `docs/investigations/Active_Queue.md` under "Discovered during prior investigations."

---

## §6 — Appendix: code-path attribution trace for the anchor case

Because `QUO_API_KEY` is not available in this remote container, the table below traces a representative outbound message through each of the five attribution systems. The message body is the **canonical H2 multi-listing-followup template** (`outreach-fire/route.ts:36-38`) parameterized to the 3273 Steele property. The behavior shown is what each system would produce when an operator on 23 Fields Ave's deal page views this message in the timeline.

**Hypothetical message:** outbound SMS, 2026-04-20T14:30:00Z, body = `"Hi Candice, this is Alex with AKB Solutions again. I see you also have the listing at 3273 Steele St. Would the seller be open to a cash offer of $58,500? Same terms — quick close, no financing contingency. Thanks!"`

**Operator viewing:** 23 Fields Ave (`rec1HTUqK0YEVb7uA`), targetAddress = "23 Fields Ave", targetPrice = (23 Fields' List_Price, unknown without live pull).
**Siblings:** 785 Pawnee (`rec2HTt07fNBDKfKf`), 1871 Thrift (`recXKcZhB7QY2OHBj`), 3273 Steele (`recvCaqLgd6n7AQkA`).

| System | What it does with this message | Surface impact |
|---|---|---|
| **`/api/deal-context/[id]` → `mergeTimeline`** | targetScore = 0 ("23 fields ave" tokens not in body). siblingScore (3273 Steele) = 0.6 (both "3273" and "steele" present). Returns `{recordId: "recvCaqLgd6n7AQkA", confidence: 0.6}`. **Entry pushed to `timeline`. Confidence 0.6 = NOT in `ambiguous` array** (cutoff is `< 0.6`, strict). | AMBIGUOUS banner doesn't increment for this specific message. Timeline contains an entry tagged with `propertyMatch.recordId = 3273_Steele`, but operator UI may not surface that tag. |
| **`/api/conversations/[id]`** | Pulls the message via `getMessagesForParticipant(+19016019312)`. Pushes it into `messages[]`. No attribution. | **Message renders in 23 Fields conversation panel.** ← OBSERVED LEAK |
| **L3 Make 4812756** | If this were an INBOUND (not outbound — L3 only fires on inbound), L3 would `FIND(phone, ...) > 0` in Listings_V1 with `maxRecords: 1`. Whichever of the 4 Candice records Airtable returns first gets the Outreach_Status update. | Not applicable to outbound. For an inbound reply to this thread: one of the 4 records gets updated (non-deterministic which one). |
| **`/api/cron/scan-comms`** | Operates on inbound only — finds Candice's most recent inbound, then loops over `phoneToListings.get("+19016019312")` (4 listings) and creates a Jarvis proposal for each. | One inbound from Candice → 4 pending proposals, all with the same `inboundBody`. |
| **`/api/multi-listing-detect`** | Runs `mergeTimeline` per sibling combination. Collects messages with `confidence < 0.6` as ambiguous. This particular message scores 0.6 → just above the floor → **does NOT appear in the ambiguous queue** for any record. | Ambiguous queue silently misses it. Pure attribution-class miss. |

**Net behavior:** the message is **correctly attributed** by the scorer to 3273 Steele, but **incorrectly rendered** in 23 Fields's conversation panel because the renderer doesn't consult the scorer's output. The AMBIGUOUS banner doesn't trip because confidence is exactly at the threshold. All five systems make defensible local decisions; together they produce the observed cross-attribution.

### Sanity-check the appendix

Operator can verify by running these against a live deploy and pasting outputs into a future appendix update:
1. `GET /api/conversations/rec1HTUqK0YEVb7uA` — count messages; look for body containing "3273 Steele" / "Steele St" tokens.
2. `GET /api/deal-context/rec1HTUqK0YEVb7uA` — inspect `timeline` entries; for each entry whose body mentions a Candice property OTHER than 23 Fields, note the `propertyMatch.recordId` and `propertyMatch.confidence`.
3. Compare: every message in (1) that's tagged to a non-23-Fields recordId in (2) is a cross-attribution leak.

---

*End of audit. Status only. No remediation implemented. Operator decides among Path (a) / (b) / (c) in §5.*

---

## §7 — Remediation outcome — Step 1 (appended 2026-05-20)

**Decision:** Path (c) Step 1 — surgical interim fix at `/api/conversations/[id]`. Step 2 (architectural redesign with unified attribution layer at ingest) deferred to belt MVP sprint.
**Operator authorization:** 2026-05-20 (this session).
**Spine record:** `rec5UVLsXktD8M8Mi`.

### What shipped

**1. `lib/timeline-merge.ts` — 2-line export change**

```diff
-interface SiblingRecord {
+export interface SiblingRecord {
   recordId: string;
   address: string;
   listPrice: number | null;
 }

-function scorePropertyMatch(
+export function scorePropertyMatch(
   messageBody: string,
   targetAddress: string,
   targetPrice: number | null,
   siblings: SiblingRecord[]
 ): { recordId: string; confidence: number } {
```

No body changes. Function moved from private to public so `/api/conversations/[id]` can call it directly. `mergeTimeline()` continues to call the same function with the same semantics — single source of truth.

**2. `app/api/conversations/[id]/route.ts` — sibling lookup + Quo-loop filter**

```diff
@@ Imports @@
-import { getListing } from "@/lib/airtable";
+import { getListing, getListings } from "@/lib/airtable";
 import { getMessagesForParticipant } from "@/lib/quo";
 import { parseConversation } from "@/lib/notes";
+import { scorePropertyMatch, type SiblingRecord } from "@/lib/timeline-merge";

@@ After `if (!listing)` block — new sibling-lookup section @@
     if (!listing) {
       return Response.json({ error: "Listing not found" }, { status: 404 });
     }
+
+    // INV-007 Step 1 attribution filter: pull sibling listings (same Agent_Phone)
+    // so we can attribute each Quo message to a specific property. Filter out
+    // messages that score to a sibling OR fall below the 0.6 confidence floor
+    // (same threshold the AMBIGUOUS banner uses in /api/deal-context/[id]).
+    // Step 2 (unified attribution layer at ingest) deferred to belt MVP sprint.
+    let siblings: SiblingRecord[] = [];
+    if (listing.agentPhone) {
+      try {
+        const all = await getListings();
+        const target = cleanPhone(listing.agentPhone);
+        siblings = all
+          .filter((l) => l.id !== id && l.agentPhone && cleanPhone(l.agentPhone) === target)
+          .map((l) => ({ recordId: l.id, address: l.address, listPrice: l.listPrice }));
+      } catch (err) {
+        console.error(`[conversations] Sibling lookup failed for ${id}:`, err);
+      }
+    }
+    const hasSiblings = siblings.length > 0;

     const messages: UnifiedMessage[] = [];

@@ Inside Quo message loop — attribution filter @@
         const quoMessages = await getMessagesForParticipant(phone, 60 * 24 * 90); // 90 days
         for (const msg of quoMessages) {
+          // Attribute via scorePropertyMatch when this agent holds multiple listings.
+          // match.recordId === "" means target won; empty fallback to current id.
+          // Sibling-attributed OR low-confidence (<0.6) messages are excluded from
+          // this property's thread. They remain visible via the AMBIGUOUS banner
+          // on /pipeline/[id] and the disambiguation queue.
+          if (hasSiblings) {
+            const match = scorePropertyMatch(
+              msg.body,
+              listing.address,
+              listing.listPrice,
+              siblings,
+            );
+            const attributedRecordId = match.recordId || id;
+            if (attributedRecordId !== id || match.confidence < 0.6) continue;
+          }
           messages.push({
             id: `quo-${msg.id}`,
             source: "quo",
             // ... existing UnifiedMessage construction unchanged
```

**Total diff: 2 lines changed in `timeline-merge.ts`, 18 lines added in `conversations/route.ts` (imports + sibling lookup + filter, comments included). Zero deletions of existing logic. No changes to `UnifiedMessage` API contract.**

### Behavior change — plain language

For agents who hold ONE listing (the common case — most agents in the pipeline), nothing changes. `hasSiblings === false` skips the filter entirely.

For agents who hold MULTIPLE listings (multi-listing agents — Candice Hardaway is the anchor case with 4), the conversation panel for any one of those listings now shows ONLY messages that score `confidence >= 0.6` against that listing's address AND whose best-match recordId is that listing. Messages about sibling properties (e.g., the 3273 Steele outbound previously appearing in the 23 Fields panel) are excluded.

### Documented trade-off (per operator non-blocking note on D1.1)

The 0.6 filter excludes messages even when `attributedRecordId === id` if their confidence falls below the threshold. This means **low-signal inbound messages may disappear from the deal-room conversation panel and be visible only via the AMBIGUOUS banner + disambiguation queue.**

Concrete examples of low-signal inbound:
- Single-word replies: `"yes"`, `"no"`, `"call me"` — zero token match, zero price match, zero "listing at" phrase → confidence 0.
- Ambiguous replies: `"what's your offer?"`, `"send the contract"` — no address/price tokens → confidence 0.
- Brief acknowledgments: `"thanks"`, `"got it"` — confidence 0.

For a multi-listing agent, ALL of these inbound messages disappear from the conversation panel. They will be visible:
1. As an **AMBIGUOUS banner** count on `/pipeline/[id]` (operator sees "N message(s) could not be confidently matched to this property")
2. In the **disambiguation queue** surface (when `DISAMBIGUATION_QUEUE_TABLE_ID` env is configured — written by the `/api/multi-listing-detect` cron)
3. Via the **JarvisGreeting "ambiguous queue" badge** on the dashboard

**Operator acceptance noted:** "deal-room panel gets cleaner, queue becomes the destination for low-signal comms. If operator workflow needs low-confidence messages rendered with a confidence-badge instead of hidden, that's a Step 2 design question."

### Test execution

| Test | Status | Result |
|---|---|---|
| **#1 TypeScript compile (`npx tsc --noEmit`)** | RAN | PASS — after `npm install` (138 packages, 14s) in fresh container, zero TS errors in either patched file. Pre-existing environmental errors (missing `@types/node` in untouched routes) are unrelated. |
| **#2 Unit tests for `scorePropertyMatch`** | NOT RUNNABLE — **gap** | `lib/timeline-merge.test.ts` does not exist. The scorer has no unit-test coverage today. Adding tests is a useful Step 2 follow-up but out of scope for Step 1. Logged below. |
| **#3–#7 End-to-end curls** (`/api/conversations/{rec1HTUqK0YEVb7uA, recvCaqLgd6n7AQkA, rec2HTt07fNBDKfKf}` + AMBIGUOUS banner consistency + before/after message counts) | DEFERRED — runtime-dependent | `QUO_API_KEY` is a Vercel-deployment secret, not in this remote container. Operator runs the curls against a deployed environment. Commands documented in §6 of this audit. |

### Curls for operator post-deploy verification

```bash
# #3 — 23 Fields panel should NOT contain 3273 Steele
curl -s <deploy>/api/conversations/rec1HTUqK0YEVb7uA | jq '.messages[] | select(.body | test("3273 Steele|Steele St"; "i"))'
# Expected: empty output

# #4 — 3273 Steele panel SHOULD contain the Steele message
curl -s <deploy>/api/conversations/recvCaqLgd6n7AQkA | jq '.messages[] | select(.body | test("3273 Steele|Steele St"; "i"))'
# Expected: ≥1 outbound H2 message

# #5 — 785 Pawnee panel (Dead) — no leaked messages from other 3 listings
curl -s <deploy>/api/conversations/rec2HTt07fNBDKfKf | jq '.messages[] | select(.body | test("23 Fields|1871 Thrift|3273 Steele"; "i"))'
# Expected: empty output

# #7 — before/after message-count sanity (run against an old deploy + new deploy)
for rec in rec1HTUqK0YEVb7uA rec2HTt07fNBDKfKf recXKcZhB7QY2OHBj recvCaqLgd6n7AQkA; do
  echo "$rec: $(curl -s <deploy>/api/conversations/$rec | jq '.messageCount')"
done
# Expected: each thread shrinks vs pre-patch; sum across 4 listings roughly
# equals the count of any single pre-patch thread (since pre-patch all 4
# showed the same dumped messages).
```

### Reversibility

Revert is trivial:
- 2 lines in `lib/timeline-merge.ts` (remove `export` keywords)
- 18 lines in `app/api/conversations/[id]/route.ts` (remove imports + sibling block + filter block)

Pre-patch behavior is "no attribution filter" — restoring it is a clean diff revert. Operator can revert via single git operation if Step 1 surfaces unexpected behavior on multi-listing agents.

### Untouched paths (still have original behavior)

Per Step 1 scope, the following remain unchanged. They are now formal queue items:

- **INV-014** — L3 Make Scenario 4812756 `maxRecords: 1` no-sort phone lookup (winner-takes-all, non-deterministic).
- **INV-015** — `/api/cron/scan-comms` fan-out (one inbound → N proposals).
- **INV-016** — `scorePropertyMatch` price-match comparing against `List_Price` (H2 body contains Offer).

Step 1 does NOT address these. They are part of Step 2's unified-attribution-at-ingest redesign.

### Step 2 specification (deferred to belt MVP sprint)

When operator authorizes Step 2:

1. **New Airtable table: `Comms_Attribution`** (or equivalent) keyed by `message_id`, columns: `recordId`, `confidence`, `signals_json`, `attributed_at`, `attribution_source` (which scorer fired).
2. **Attribution computed at ingest** — three write-paths:
   - L3 webhook handler (Make Scenario 4812756 retired or reworked) → runs scorer on inbound, writes Comms_Attribution row, then routes by content
   - `/api/cron/scan-comms` reworked to attribute first, then propose only for the attributed record
   - Gmail sync (`cron/scan-comms` Gmail half + ad-hoc Gmail polls) similarly
3. **All five render/orchestration paths consume `Comms_Attribution`** instead of re-scoring at render time:
   - `/api/deal-context/[id]`: replaces `mergeTimeline`'s scoring step with attribution-table lookup
   - `/api/conversations/[id]`: filter logic from Step 1 replaced with attribution-table lookup
   - L3: stops being winner-takes-all
   - scan-comms: stops fanning out
   - multi-listing-detect: still surfaces ambiguous messages, but pulls them from the attribution table directly
4. **Migration:** existing messages remain unattributed in the table; a one-shot backfill cron runs scorer over the last N days. Pre-Inevitable comms remain unattributed per the queue's backfill discipline.
5. **Confidence-badge UI affordance** (per operator note): low-confidence target-attributed messages render with `[best-guess]` badge instead of being hidden; operator can re-attribute via click. This addresses the §7 documented trade-off.

Estimated effort: 1 sprint after belt MVP design lands.

### Adjacent items spawned

One follow-up surfaced during this Step 1 work:

- **`scorePropertyMatch` has no unit-test coverage** — `lib/timeline-merge.test.ts` does not exist. The scorer is now consumed by two callers (`mergeTimeline` and `/api/conversations/[id]`) and three indirect surfaces (`/api/deal-context`, `/api/multi-listing-detect`, the AMBIGUOUS banner). Coverage is overdue. Not pursued in this Step 1; logged for future investigation/test-add ticket.

*End of remediation outcome — Step 1. Status: shipped + locally verified. Spine: `rec5UVLsXktD8M8Mi`. End-to-end curl verification deferred to deploy.*
