// Reply-funnel rollup — "our reply rate is fine, so where do threads DIE?"
// @agent: sentinel
//
// WHY THIS EXISTS (2026-07-31)
//
// The send side has meters everywhere (supply floor, send caps, daily
// governor, zero-output-streak). The REPLY side had none. Every inbound was
// classified and routed individually — correctly — but nobody ever asked the
// cohort question. The measured shape that forced this:
//
//     1,053 texted → 121 replies (11.5%) → 1 executed contract (0.8% of
//     replies). The opener works. Something after the reply does not.
//
// A per-event triage cannot answer that; only a rollup over all replies can.
// This module is that rollup, and it is deliberately PURE so the numbers are
// testable and the route stays I/O-only.
//
// TERMINAL OUTCOME is derived from the record, not guessed: a contract
// timestamp beats a status, a status beats silence. "dropped" is the finding
// that matters most — a record that got a genuine reply and never left
// Texted is a thread nobody answered.

export type ReplyOutcome =
  | "contracted"      // Contract_Executed_At present — the only real win
  | "negotiating"     // live, mid-volley
  | "engaged"         // replied and advanced, not yet countering
  | "parked"          // deliberately shelved (re-engage later)
  | "dead"            // closed out, ours or theirs
  | "dropped";        // REPLIED but never advanced past Texted — the leak

export interface ReplyFunnelRow {
  id: string;
  address: string | null;
  classification: string | null;
  decisionKind: string | null;
  outcome: ReplyOutcome;
  /** Hours from the inbound to now — how long a dropped thread has sat. */
  ageHours: number | null;
}

export interface ReplyFunnelInput {
  id: string;
  address?: string | null;
  outreachStatus?: string | null;
  lastInboundAt?: string | null;
  contractExecutedAt?: string | null;
  replyClassification?: string | null;
  replyDecisionKind?: string | null;
}

export interface ReplyFunnelSummary {
  /** Records carrying a genuine inbound. */
  replies: number;
  /** Of those, how many have a persisted classification. The coverage meter:
   *  100% means the 2026-07-31 hole is closed; anything less is backfill
   *  work still outstanding. */
  classified: number;
  classificationCoveragePct: number;
  byOutcome: Record<ReplyOutcome, number>;
  /** classification → outcome → count. The actual diagnostic: it says which
   *  KIND of reply dies and where. */
  byClassificationOutcome: Record<string, Record<string, number>>;
  /** Replied-but-never-advanced, worst (oldest) first. The work-list. */
  dropped: ReplyFunnelRow[];
  /** replies → contracted, as a percentage. The load-bearing number. */
  replyToContractPct: number;
}

const ENGAGED_STATUSES = new Set(["Response Received", "Emailed", "Manual Review"]);
const NEGOTIATING_STATUSES = new Set(["Negotiating", "Counter Received", "Offer Accepted"]);

/** Pure: derive the terminal outcome of one replied thread. Order matters —
 *  a contract stamp outranks whatever the status says, because status drift
 *  is exactly the failure mode the 2026-07-28 audit found. */
export function deriveOutcome(input: ReplyFunnelInput): ReplyOutcome {
  if (input.contractExecutedAt) return "contracted";
  const s = (input.outreachStatus ?? "").trim();
  if (NEGOTIATING_STATUSES.has(s)) return "negotiating";
  if (s === "Dead") return "dead";
  if (s === "Parked") return "parked";
  if (ENGAGED_STATUSES.has(s)) return "engaged";
  // Replied, but the status never moved off the send-side value (or is
  // empty). Nobody advanced this thread.
  return "dropped";
}

function ageHours(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.round(((now.getTime() - t) / 3_600_000) * 10) / 10;
}

/** Pure: roll every replied thread into the funnel. Callers pass ONLY
 *  records with a genuine inbound; filtering lives in the route so this
 *  stays a pure fold. */
export function rollupReplyFunnel(
  inputs: ReplyFunnelInput[],
  now: Date = new Date(),
): ReplyFunnelSummary {
  const byOutcome: Record<ReplyOutcome, number> = {
    contracted: 0, negotiating: 0, engaged: 0, parked: 0, dead: 0, dropped: 0,
  };
  const byClassificationOutcome: Record<string, Record<string, number>> = {};
  const dropped: ReplyFunnelRow[] = [];
  let classified = 0;

  for (const r of inputs) {
    const outcome = deriveOutcome(r);
    byOutcome[outcome] += 1;

    const cls = r.replyClassification ?? "(unclassified)";
    if (r.replyClassification) classified += 1;
    byClassificationOutcome[cls] ??= {};
    byClassificationOutcome[cls][outcome] = (byClassificationOutcome[cls][outcome] ?? 0) + 1;

    if (outcome === "dropped") {
      dropped.push({
        id: r.id,
        address: r.address ?? null,
        classification: r.replyClassification ?? null,
        decisionKind: r.replyDecisionKind ?? null,
        outcome,
        ageHours: ageHours(r.lastInboundAt, now),
      });
    }
  }

  dropped.sort((a, b) => (b.ageHours ?? 0) - (a.ageHours ?? 0));
  const replies = inputs.length;
  const pct = (n: number) => (replies === 0 ? 0 : Math.round((n / replies) * 1000) / 10);

  return {
    replies,
    classified,
    classificationCoveragePct: pct(classified),
    byOutcome,
    byClassificationOutcome,
    dropped,
    replyToContractPct: pct(byOutcome.contracted),
  };
}
