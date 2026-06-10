# MAVERICK CMD — Dashboard V2

**Session:** v2-dashboard (parallel build; ops session owns all backend changes)
**Status:** Today + Deal Room live behind the flag. Pipeline / Agent CRM / Money / Theater designed, not built.
**Charter compliance:** everything lives under `app/v2/` + this doc. Zero edits to v1 routes,
libs, crons, schemas, or env. When v2 is accepted it replaces v1 — one dashboard, never two.

---

## 1. Feature flag

`app/v2/layout.tsx` gates server-side, no env changes required anywhere:

| Context | Flag |
|---|---|
| Vercel **preview** deploys | ON automatically (`VERCEL_ENV === "preview"`) |
| Local dev | ON |
| **Production** | OFF unless ops sets `V2_DASHBOARD=true` on the project |

v1 is reachable from v2 (V1 button, "ACT IN V1" links) and is byte-identical to before.

## 2. How v2 sits on the spine (read map)

All data comes from **existing** routes; the dashboard session cookie (`akb-auth`) covers
the auth-gated ones. The only mutation v2 performs is `PATCH /api/operator-actions`
(resolve/defer), the same call v1's Queue already makes.

| Surface | Routes consumed |
|---|---|
| Today — decision queue | `/api/operator-actions`, `/api/queue`, `/api/briefing` |
| Today — overnight digest + health strip | `/api/admin/audit-tail?limit=500` (KV audit_log) |
| Deal Room | `/api/listings/[id]`, `/api/deal-dossier/[id]`, `/api/conversations/[id]` (verified feed), `/api/admin/audit-tail?recordId=` |
| Maverick panel | `GET /api/maverick/load-state?format=narrative`, `POST /api/maverick/recall` |

Design laws enforced in code: every figure renders with provenance + consequence
(`Numbers` in the Deal Room; `detail` on every health-strip cell); missing data renders
as an explicit "no signal / blocks the gate" state — never a fake number.

## 3. Backend requests for the ops session (v2 stops here; nothing built)

1. **Breaker/spend read route** — e.g. `GET /api/admin/spend-status`: Firecrawl breaker
   armed/tripped, window spend, RentCast calls used/remaining. The health strip currently
   infers from audit events and honestly shows "no signal" when the KV window has aged out.
2. **Funnel-audit snapshot** — APPROVED + QUEUED (first in ops priority). Persist the
   last outreach-batch run's funnel audit to KV and expose
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

   The v2 Pipeline lane auto-flips from its labeled SIMULATED fixture to live the moment
   this route 200s with that shape — no UI change needed.
3. **Maverick chat/act** — a conversational endpoint over the Maverick MCP (tools/call
   with named-agent attribution) so the panel can go beyond load_state/recall to
   "approve the Freeland counter". jarvis-chat is deprecated; not wiring v2 to it.
4. **INV-023 DD gate writes** — the Deal Room's OFFER GATE panel is built to become its
   surface; when ops ships the gate schema, v2 needs the field list + write route.
5. **Agent CRM reads** — agents-as-entities needs: listings grouped by `Agent_Phone`,
   prior-contact counts (`Agent_Prior_Outreach_Count` exists), and stall-release timer
   state from the H2 same-agent stall logic (currently internal to `lib/h2-outreach.ts`).
6. **Money surface reads** — cost-per-lead/offer needs spend events joined to intake
   counts; propose a daily rollup written to KV by the existing intake/outreach crons.

## 4. Surface status

- **Today / Deal Room** — LIVE behind the flag (first deliverable, accepted).
- **Pipeline** — BUILT: stage conveyor lane is live from `/api/listings`; the batch-funnel
  lane runs on a loudly-labeled simulated fixture until request #2's snapshot route ships,
  then flips live automatically (adapter in `app/v2/_lib/funnel.ts`).
- **Agent CRM** — BUILT live from `/api/listings` grouped by normalized agent phone:
  listings held, reply-waiting flag, replied/texted history, ZIP concentration filter.
  Stall-release timers render as "awaiting ops read" until request #5.
- **Money** — next; needs requests #1 + #6.
- **Agent Theater** — last; schema below ships now so events accumulate.

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

Unmatched events fall to `watch`. The verb table lives with the theater renderer when it
ships; this contract is recorded now so any new audit event names ops introduces stay
compatible (prefix-based, no enum lock-in).

## 6. Five conversion lanes — data model reserved (design now, build later)

All five are **schema requests** to ops, parked here so the IA has space reserved.
None are built in v2 yet; the Today queue has a slot for each lane's output (they all
surface as decision cards, not new tabs — law #1).

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

- v2 renders as a full-viewport overlay (`fixed inset-0 z-[60]`) because the root layout
  (v1 chrome) cannot be edited under the charter. When v2 is accepted, the root layout
  swap is a 5-line change ops makes at cutover.
- Deals-table records (kind=deal queue cards) link to v1 — the v2 Deal Room reads
  Listings only until the Deals read path is wired (small, planned with Pipeline).
- The health strip's QUO cell measures **confirmed deliveries from audit events**, which
  is delivery rate over the KV window — not the live Quo API health probe. The probe
  lives in load_state's source_health; once request #1/#2 land the strip should read both.
