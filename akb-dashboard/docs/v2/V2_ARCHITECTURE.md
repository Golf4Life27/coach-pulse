# Dashboard V2 — absorbed into the V1 shell

**Session:** v2-dashboard (parallel build; ops session owns all backend changes)
**Charter (pivoted 6/10):** V1 absorbs V2 — v2 surfaces are AKBdash-styled components
mounted as tabs inside the V1 shell. One shell, one design system, one dashboard.
**Status:** TODAY / FUNNEL / AGENTS tabs + header health strip + embedded Maverick
panel live behind the flag on the preview alias. The old `/v2` overlay is deleted
(`/v2` redirects to `/today`). V1's `/pipeline/[id]` is the canonical deal page.

## Merge path (spine rec2tozEB937M8q2d)

- **MERGE GATE** (branch → main, flag still OFF in prod): round-2 rulings
  portfolio-wide ✓ (584693a) · health strip in V1 header ✓ (e5fabc0) · clean Alex
  review with zero open kill items (pending) · ops code-review of the diff (pending).
- **LAUNCH GATE** (prod flag flip): funnel-snapshot route live — no SIMULATED banner
  ships to production per honest-zero — and Alex preferring /today after 2-3 real
  mornings on the preview. After launch the branch retires; iteration moves to main.

---

## 1. Feature flag

`app/v2/_lib/flag.ts` (`v2Enabled()`), evaluated server-side; consumed by the root
layout (Navigation `v2` prop + `V2Frame` mount) and each tab route:

| Context | Flag |
|---|---|
| Vercel **preview** deploys | ON automatically (`VERCEL_ENV === "preview"`) |
| Local dev | ON |
| **Production** | OFF unless ops sets `V2_DASHBOARD=true` on the project |

Flag off → the rendered tree is byte-identical to pre-v2 V1.

## 2. Mount architecture + read map

Everything v2 adds enters through two flag-gated points:

- **`components/Navigation.tsx`** — `v2` prop adds the TODAY / FUNNEL / AGENTS tabs.
- **`app/layout.tsx` → `app/v2/_components/V2Frame.tsx`** — one shared
  `V2DataProvider` around V1's `<main>`, the slim header health strip, and the
  embedded Maverick panel. All tabs + the strip ride one fetch loop.

Tab routes are thin flag-gated wrappers (`app/today`, `app/funnel`, `app/agents`)
around boards in `app/v2/_components/`. All data comes from **existing** routes; the
dashboard cookie covers the auth-gated ones. The only mutations v2 performs are
`PATCH /api/operator-actions` and `POST /api/mark-dead` — both existing v1 routes.

| Surface | Routes consumed |
|---|---|
| Shared provider (strip + all tabs) | `/api/queue`, `/api/operator-actions`, `/api/briefing`, `/api/listings?include_dead=true`, `/api/admin/audit-tail?limit=500` |
| Funnel tab, batch lane | `/api/admin/funnel-snapshot` (adapter; labeled SIMULATED fixture until ops ships it) |
| Maverick panel | `GET /api/maverick/load-state?format=narrative`, `POST /api/maverick/recall` |

Design laws enforced in code (original charter + 6/10 operator-review laws + round-2):

1. **Why-attached numbers** — every figure renders with provenance + consequence
   (`detail` on every health-strip cell; track-labeled ceilings via
   `underwrittenMaoTrack` when v2 renders one).
2. **Buttons are the decisions + stranger test** — each card's stated options become
   its buttons (`_lib/decisions.ts`); labels parse without system vocabulary; any
   button whose effect isn't obvious carries a one-line consequence subtext; Maverick's
   recommended option is marked and rendered lit (pulse + MAVERICK RECOMMENDS tag,
   reasoning directly adjacent), others secondary.
3. **Plain English on surfaces** — raw system/audit/Notes jargon never renders verbatim
   (`_lib/translate.ts`); raw text stays under an expandable "system log".
4. **Honest zero** — a number renders only when its wired source actually returned it
   (`deriveActivity` in `_lib/data.tsx`); otherwise "no signal".
5. **Queue hygiene** — terminal-state and paused-market items leave the queue into a
   collapsed "already decided" section with the standing-decision reference
   (`_lib/policy.ts`); the open-decision count is forward-only. One merged queue,
   sorted importance (ACT NOW > HIGH > MEDIUM > LOW) then recency, today's live
   items pinned.

## 3. Backend requests for the ops session (v2 stops here; nothing built)

1. **Breaker/spend read route** — e.g. `GET /api/admin/spend-status`: Firecrawl breaker
   armed/tripped, window spend, RentCast calls used/remaining. The health strip currently
   infers from audit events and honestly shows "no signal" when the KV window has aged out.
2. **Funnel-audit snapshot** — APPROVED + QUEUED (first in ops priority; LAUNCH-GATE
   blocker). Persist the last outreach-batch run's funnel audit to KV and expose
   `GET /api/admin/funnel-snapshot` returning exactly this (shape copied verbatim from
   the batch route's existing `Disposition` / `funnel_audit` computation — see
   `app/v2/_lib/funnel.ts` for the frozen TypeScript contract the UI already consumes):

   ```ts
   interface FunnelSnapshot {
     generated_at: string;
     mode: "dry_run" | "live";
     params: { zips: string[] | null; limit: number };
     funnel_audit: {
       input_count: number;
       in_zip_scope: number | null;
       disposition_total: number;
       missing_from_funnel: string[];
       bucket_counts: Record<Disposition, number>; // the 9 existing buckets
     };
     dispositions: RecordDisposition[]; // { recordId, address, zip, disposition, reason, prior? }
   }
   ```

   The Funnel tab's batch lane auto-flips from its labeled SIMULATED fixture to live the
   moment this route 200s with that shape — no UI change needed.
3. **Maverick chat/act** — a conversational endpoint over the Maverick MCP (tools/call
   with named-agent attribution) so the panel can go beyond load_state/recall to
   "approve the Freeland counter". jarvis-chat is deprecated; not wiring v2 to it.
4. **Additive deal-page cards** *(superseded INV-023 request; ops shipped the gate on
   `/pipeline/[id]`)* — v2-only pieces proposed as smallest-diff additive cards for the
   V1 deal page, each to be proposed before building: (a) why-attached numbers grid with
   track-labeled ceilings (`Underwritten_MAO_Track`), (b) the translated system log for
   the record trail, (c) anything the verified `/api/conversations/[id]` feed shows that
   the page's current thread misses.
5. **Agent CRM reads** — prior-contact counts + auto-release timer state from the H2
   same-agent stall logic (currently internal to `lib/h2-outreach.ts`).
6. **Money surface reads** — cost-per-lead/offer needs spend events joined to intake
   counts; propose a daily rollup written to KV by the existing intake/outreach crons.
7. **Standing-policy read + decision capture** — RATIFIED + QUEUED behind #2.
   (a) machine-readable read of standing spine policies (paused markets, do-not-resurface)
   so queue hygiene stops running on the hardcoded projection in `app/v2/_lib/policy.ts`
   (currently: TN/Memphis paused); (b) a `Decision_Taken` field on Operator_Action_Items
   so the chosen button label persists with the resolved item.

## 4. Surface status

- **TODAY** — LIVE behind flag: merged decision queue (operator items + queue cards,
  importance→recency, TODAY pins), lit recommendations, stranger-test buttons with
  consequences, already-decided + held sections, overnight digest.
- **FUNNEL** — LIVE behind flag: stage conveyor (live) + batch funnel lane (labeled
  SIMULATED until request #2 ships; launch-gate blocker by design).
- **AGENTS** — LIVE behind flag: grouped by normalized phone, reply-waiting flags,
  replied/texted history, ZIP filter; auto-release timers awaiting request #5.
- **Health strip** — LIVE behind flag in the V1 header on every page.
- **Maverick panel** — LIVE behind flag on every page (load_state + recall).
- **Money** — not built; needs requests #1 + #6.
- **Agent Theater** — design only; schema below ships now so events accumulate.

## 5. Agent Theater — event schema (defined now, skin later)

Driven entirely off the existing `AuditEntry` stream (KV `agent:audit`). No new writes:
the theater is a **pure projection** of audit events. Mapping:

```ts
interface TheaterEvent {
  ts: string;                 // AuditEntry.ts
  actor: AgentName;           // AuditEntry.agent → sprite (sentinel, sentry, appraiser,
                              //   crier, scribe, scout, forge, pulse, ledger, maverick)
  verb: TheaterVerb;          // derived from AuditEntry.event by prefix table below
  object?: { recordId?: string; address?: string };   // from recordId + inputSummary
  outcome: "ok" | "fail" | "unsure";                  // from AuditEntry.status
  detail?: string;            // AuditEntry.decision / error
}

type TheaterVerb =
  | "scan"      // *intake*, *crawl*, *scan*        → Sentinel sweeping the radar
  | "verify"    // *verify*, *gate*                  → Sentry stamping papers
  | "appraise"  // *arv*, *rehab*, *underwrite*, *mao*, *dossier* → Appraiser at the desk
  | "speak"     // *send*, *outreach*, *reply*, *volley*          → Crier on the horn
  | "write"     // *patch*, *field*, *backfill*      → Scribe filing
  | "watch"     // *audit*, *reconcile*, *triage*    → Pulse on the monitors
  | "trade";    // *buyer*, *blast*, *warmup*        → Scout/Forge at the market
```

Unmatched events fall to `watch`. Prefix-based, no enum lock-in — new audit event
names ops introduces stay compatible.

## 6. Five conversion lanes — data model reserved (design now, build later)

All five are **schema requests** to ops, parked here so the IA has space reserved.
None are built yet; each lane's output surfaces as TODAY decision cards (sorted by the
same importance→recency rules), not new tabs.

1. **Resurrection watcher** — closed-lost re-engagement at the sticky number.
   Needs per-listing: `Closed_Lost_At`, `Closed_Lost_Reason`, `Sticky_Offer` (exists as
   `Outreach_Offer_Price`), plus a relist/price-cut/fall-through detector on the intake
   cron writing `Resurrection_Signal` + `Resurrection_Signal_At`. (Partial groundwork
   exists in `lib/resurrection.ts` / `lib/never-resurface.ts` — extend, don't fork.)
2. **Follow-up cadence engine** — day-3 / day-10 / DOM-trigger re-touches.
   Exists in embryo: `Follow_Up_Count`, `lib/d3-cadence.ts`. Needs: `Next_Touch_At`
   (computed), `Cadence_Track` (d3 | d10 | dom_drop), surfaced as queue cards.
3. **Reply intel capture** — structured what-it-sold-for / why-rejected per ZIP.
   Needs a `Reply_Intel` table: `Source_Record_Id`, `ZIP`, `Intel_Type`
   (sold_price | rejection_reason | competing_offer), `Value_Num`, `Verbatim`, `Captured_At`.
   The classifier patch (399595c) already triages replies — this adds the structured sink.
4. **Buyer warming** — dispo pre-build. `Prospective_Buyers` + warmup-sequence cron exist;
   needs `Warmth_Score` + `Last_Warm_Touch_At` to rank, and a per-ZIP buyer-demand view.
5. **ZIP expansion autopilot** — ranked next-market queue. `ZIP_Registry` exists; needs
   `Expansion_Score` (deal density × reply rate × buyer depth) and a ranked read route.

## 7. Open design notes

- Deals-table queue cards link to `/deals` — the v2 boards read Listings only until a
  Deals read path is needed (the Deals table now also carries the Pre_EMD_* gate fields).
- The conveyor tab is named **FUNNEL** to avoid colliding with V1's PIPELINE tab
  (the listings table). One-line rename if Alex prefers.
- The health strip's QUO cell measures **confirmed deliveries from audit events** over
  the KV window — not the live Quo API health probe. The probe lives in load_state's
  source_health; once requests #1/#2 land the strip should read both.
- Paused-markets list in `_lib/policy.ts` is a hardcoded projection of the spine
  decision (TN/Memphis) until request #7a — flagged so it can't silently drift.
