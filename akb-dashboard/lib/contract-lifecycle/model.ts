// Back-of-funnel lane — contract lifecycle surfacing (operator 2026-07-14:
// "I have a signed contract out… a live inspection period, and it's not being
// slapped in my face to verify status or begin dispo"). @agent: maverick
//
// THE BLIND SPOT THIS CLOSES: the front-of-funnel machine (find → verify →
// price → negotiate) is heavily built, but once a deal goes under contract the
// system had NO surfacing and NO clocks — the highest-stakes, most time-
// sensitive deals (executed contract, live inspection/option window, EMD
// deadline, close date) fell out of the priority feed entirely (3123 Sunbeam
// was even mislabeled Pipeline_Stage="dead"). This module turns each back-half
// deal into ONE ranked, clocked "next move" that rides the SAME conveyor the
// front half uses — so it shows on Act Now and in the Maverick dock for free.
//
// DOCTRINE: money/signature steps (EMD, closing, executed-contract) are 2B —
// operator-only, forever. The card ROUTES to the deal room; it never wires,
// signs, or auto-advances. EMD is voice-verified (never from emailed
// instructions). No number is invented — dollars are the sourced spread/
// contract price or null.
//
// PURE. No I/O — the route supplies rows; the model computes the move.

import type { ConveyorItem, ConveyorAction, ConveyorType } from "@/lib/conveyor/model";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Pipeline stages that put a deal in the back half (contract → close). Closed
 *  and dead are terminal — they never surface a next move. */
export const BACK_HALF_STAGES: ReadonlySet<string> = new Set([
  "under_contract",
  "dispo_active",
  "assignment_signed",
]);

export function isBackHalfStage(stage: string | null | undefined): boolean {
  return !!stage && BACK_HALF_STAGES.has(stage);
}

export interface ContractDealRow {
  recordId: string;
  address: string | null;
  pipelineStage: string | null;
  /** The negotiated contract price (sourced). */
  contractPrice: number | null;
  /** The assignment spread from decision-math, when computed (the real AKB
   *  revenue). Preferred over contractPrice for "dollars in play". */
  dealSpread: number | null;
  contractExecutedAt: string | null;
  emdDueAt: string | null;
  emdReceived: boolean;
  optionDeadline: string | null;
  closeDate: string | null;
}

/** A back-half lifecycle step — the single most-pressing thing on this deal. */
interface LifecycleStep {
  /** Stable code (telemetry / tests). */
  kind:
    | "verify_executed"
    | "verify_emd"
    | "option_window"
    | "run_dispo"
    | "closing"
    | "set_dates";
  type: ConveyorType;
  /** The crafted, specific imperative — shown as the card's line and the dock
   *  headline (never a generic "money on the table" placeholder). */
  message: string;
  deadlineAt: string | null;
  deadlineImplied: boolean;
  /** Primary action button label. */
  actionLabel: string;
}

function impliedIso(nowMs: number, hours: number): string {
  return new Date(nowMs + hours * HOUR_MS).toISOString();
}

function fmtDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * The single most-pressing back-half step, walked in lifecycle order so the
 * card advances as the deal (and the operator's data entry) progresses:
 *   1. executed contract not yet confirmed  → verify status  (2B)
 *   2. EMD due & not confirmed received      → confirm wire   (2B, voice-verify)
 *   3. option/inspection window still open   → dispo-or-terminate (2C)
 *   4. in dispo, no assignment yet           → run dispo      (2C)
 *   5. close date set                        → confirm closing (2B)
 *   6. under contract, no forward dates       → set your dates (2C nudge)
 * Money/signature steps carry NO dispatch action — only a route to the room.
 */
export function pickLifecycleStep(row: ContractDealRow, nowIso: string): LifecycleStep {
  const now = Date.parse(nowIso);
  const nowMs = Number.isFinite(now) ? now : 0;

  // 1. Executed contract not confirmed — the operator's exact ask ("verify
  //    status"). Short implied clock keeps it hot until he stamps the date.
  if (!row.contractExecutedAt) {
    return {
      kind: "verify_executed",
      type: "2B",
      message:
        "Under contract — confirm the fully-executed contract is back, then stamp the execution date so the clock can run.",
      deadlineAt: impliedIso(nowMs, 24),
      deadlineImplied: true,
      actionLabel: "Verify status",
    };
  }

  // 2. Earnest money due and not confirmed delivered — money at risk. Voice-
  //    verify the wire (never trust emailed instructions), then check the box.
  if (row.emdDueAt && !row.emdReceived) {
    return {
      kind: "verify_emd",
      type: "2B",
      message: `Earnest money due ${fmtDate(row.emdDueAt)} — voice-verify the wire landed, then mark EMD received.`,
      deadlineAt: row.emdDueAt,
      deadlineImplied: false,
      actionLabel: "Confirm EMD",
    };
  }

  // 3. Option / inspection / DD window still open (or within a 2-day grace of
  //    closing) — last dispo push or terminate before the deposit goes hard.
  if (row.optionDeadline) {
    const opt = Date.parse(row.optionDeadline);
    if (Number.isFinite(opt) && opt >= nowMs - 2 * DAY_MS) {
      return {
        kind: "option_window",
        type: "2C",
        message: `Option window closes ${fmtDate(row.optionDeadline)} — make your last dispo push or terminate before the EMD goes hard.`,
        deadlineAt: row.optionDeadline,
        deadlineImplied: false,
        actionLabel: "Run dispo",
      };
    }
  }

  // 4. In active dispo with no assignment yet — get it in front of buyers.
  if (row.pipelineStage === "dispo_active") {
    return {
      kind: "run_dispo",
      type: "2C",
      message: "In dispo — get this in front of your buyers and lock an assignment.",
      deadlineAt: row.closeDate ?? impliedIso(nowMs, 72),
      deadlineImplied: !row.closeDate,
      actionLabel: "Run dispo",
    };
  }

  // 5. Closing scheduled — confirm title / settlement / your fee.
  if (row.closeDate) {
    return {
      kind: "closing",
      type: "2B",
      message: `Closing ${fmtDate(row.closeDate)} — confirm title, the settlement statement, and your assignment fee.`,
      deadlineAt: row.closeDate,
      deadlineImplied: false,
      actionLabel: "Confirm closing",
    };
  }

  // 6. Under contract, executed, but no forward dates — nudge data entry so the
  //    clocks can track EMD / option / close.
  return {
    kind: "set_dates",
    type: "2C",
    message: "Under contract — set your EMD, option, and close dates so the machine can watch the clock for you.",
    deadlineAt: impliedIso(nowMs, 72),
    deadlineImplied: true,
    actionLabel: "Set dates",
  };
}

/** The single ranked back-half move for one deal, as a ConveyorItem — null when
 *  the deal is not in a back-half stage. */
export function nextContractAction(row: ContractDealRow, nowIso: string): ConveyorItem | null {
  if (!isBackHalfStage(row.pipelineStage)) return null;
  const step = pickLifecycleStep(row, nowIso);
  const href = `/pipeline/${row.recordId}`;
  const actions: ConveyorAction[] = [{ kind: "open", href, label: step.actionLabel }];
  return {
    key: `contract:${row.recordId}`,
    source: "contract",
    type: step.type,
    title: row.address ?? row.recordId,
    reasoning: step.message,
    recordId: row.recordId,
    href,
    // Dollars in play: the assignment spread (real revenue) when decision-math
    // has it, else the sourced contract price. Never invented.
    dollars: row.dealSpread ?? row.contractPrice ?? null,
    deadlineAt: step.deadlineAt,
    deadlineImplied: step.deadlineImplied,
    postedAt: row.contractExecutedAt ?? null,
    verbatim: null,
    actions,
  };
}

/** Map a set of back-half deals to their conveyor items (drops non-back-half). */
export function contractLifecycleItems(rows: ContractDealRow[], nowIso: string): ConveyorItem[] {
  const out: ConveyorItem[] = [];
  for (const r of rows) {
    const item = nextContractAction(r, nowIso);
    if (item) out.push(item);
  }
  return out;
}
