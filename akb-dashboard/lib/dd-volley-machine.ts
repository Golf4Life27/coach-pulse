// DD-VOLLEY MACHINE — bounded due-diligence question sequences on the
// RECOMMENDED-REPLIES rails (B2, 2026-07-13, unblocked by CP4 verdict
// recsNSfqqaPdKE2GE). @agent: forge / crier
//
// (The name `lib/dd-volley.ts` already holds the LOCKED V3.0 manual 3-text
// copy that /api/dd-volley-send taps out by hand — untouched. This module is
// the AUTOMATED, answer-aware layer that rides the #103 ingestion rails.)
//
// When a seller/agent ENGAGES (interest, offer_format, counter, seller_costs)
// the doctrine is: gather the facts that make a precise contract number
// derivable BEFORE moving any number — and never move a number without them.
// This state machine drives that:
//
//   • per-classification DD question sequences (the "what do we still need to
//     know" bank),
//   • a bounded volley (MAX_VOLLEYS = 3) persisted as JSON on the listing's
//     DD_Volley_State field,
//   • each seller ANSWER delivery-stamped into the notes ledger (stamps, not
//     fields — pricing-doctrine method 6),
//   • a NUMBER-GATE: a precise contract number may be derived (via the
//     EXISTING pricing lanes — this module never touches pricing internals)
//     ONLY once the DD answers are stamped, and even then the sticky
//     delivery-stamped number rules with a ±$5 recompute tolerance.
//
// PURE. No I/O, no model, no Airtable. The crons persist state + notes and run
// the DD question through the SAME lib/recommended-reply guardrails every other
// draft rides. The question templates are authored guardrail-safe (no dollar
// figures, proceeds-at-closing framing on cost topics, defer-to-title on
// liens/estate, no legal assertions), so a DD draft passes validateReplyDraft.

import type { ReplyClassification } from "@/lib/reply-triage";

/** Max DD questions before the thread is handed to the operator (status →
 *  "capped"). Three keeps a volley from becoming an interrogation. */
export const MAX_VOLLEYS = 3;

/** ±$5 recompute tolerance (doctrine): a re-derived contract number within $5
 *  of the sticky delivery-stamped number IS the sticky number — never re-queue
 *  a "new" number for rounding noise. */
export const RECOMPUTE_TOLERANCE_USD = 5;

export interface DDSlot {
  /** Stable key — dedupes asked/answered across volleys. */
  slot: string;
  /** Question text (becomes the draft; authored guardrail-safe). */
  question: string;
}

export interface DDAnswer {
  slot: string;
  /** Verbatim (trimmed) seller answer — the delivery-stamped fact. */
  answer: string;
  stampedAt: string;
  /** Inbound msg id the answer arrived on (idempotency + provenance). */
  msgId: string | null;
}

export type DDVolleyStatus = "active" | "complete" | "capped";

export interface DDVolleyState {
  status: DDVolleyStatus;
  /** The classification that OPENED the volley — locks the sequence so a
   *  mid-volley reclassification doesn't swap question tracks. */
  classification: string;
  /** How many DD questions have been ASKED (0..MAX_VOLLEYS). */
  volleyCount: number;
  /** Slot keys asked, in order. */
  asked: string[];
  /** Stamped answers. */
  answers: DDAnswer[];
  openedAt: string;
  updatedAt: string;
}

// ── DD question bank (guardrail-safe templates) ─────────────────────────────

const CONDITION: DDSlot = {
  slot: "condition",
  question:
    "To firm up the offer, how would you describe the condition — anything major like the roof, foundation, HVAC, or plumbing I should factor in?",
};
const ACCESS: DDSlot = {
  slot: "access",
  question:
    "Would I be able to get in for a quick look, or is it better to work off photos for now?",
};
const OCCUPANCY: DDSlot = {
  slot: "occupancy",
  question: "Is anyone in the property right now — owner, a tenant, or is it vacant?",
};
const TIMELINE: DDSlot = {
  slot: "timeline",
  question:
    "What timeline are you hoping for on closing? We can work around the seller's schedule.",
};

const DD_SEQUENCES: Partial<Record<ReplyClassification, DDSlot[]>> = {
  // Owed + on what timeline (so net-at-closing is real). Proceeds framing +
  // title deferral keep these past G2/G3.
  seller_costs: [
    {
      slot: "payoff_amount",
      question:
        "To make sure the numbers work cleanly at closing, do you know roughly what's still owed — any mortgage payoff? The title company confirms the exact figures, and anything owed comes out of the sale proceeds at closing, so it's covered on that end.",
    },
    {
      slot: "lien_details",
      question:
        "Are there any other liens, back taxes, or utility balances you're aware of? Anything like that gets paid off through the title company at closing — it just helps to know upfront.",
    },
    TIMELINE,
  ],
  interest: [CONDITION, ACCESS, OCCUPANCY, TIMELINE],
  offer_format: [CONDITION, ACCESS, OCCUPANCY, TIMELINE],
  // Hold the sticky number; understand the basis; THEN condition + timeline.
  // Never accepts or counters with a number (the doctrine "no number move
  // without DD" is enforced by the number-gate downstream).
  counter: [
    {
      slot: "counter_basis",
      question:
        "Appreciate you coming back with a number. Help me understand what's driving it — recent sales nearby, condition, something specific? I want to account for the right things before I take another look.",
    },
    CONDITION,
    TIMELINE,
  ],
};

/** Classifications that open a DD volley. Everything else (acceptance →
 *  contract path, disclosure_step → never drafts, appointment / unknown /
 *  soft_no / rejection) is handled by the normal reply lanes. */
export function classificationOpensVolley(classification: string): boolean {
  return Object.prototype.hasOwnProperty.call(DD_SEQUENCES, classification);
}

/** The ordered slot list for a classification (empty if none). */
export function ddSequenceFor(classification: string): DDSlot[] {
  return DD_SEQUENCES[classification as ReplyClassification] ?? [];
}

// ── State (de)serialization ─────────────────────────────────────────────────

/** Parse the DD_Volley_State JSON field (fail-soft to null). */
export function parseVolleyState(raw: string | null | undefined): DDVolleyState | null {
  if (!raw || !raw.trim()) return null;
  try {
    const o = JSON.parse(raw) as DDVolleyState;
    if (!o || typeof o !== "object" || !o.status || !Array.isArray(o.answers) || !Array.isArray(o.asked)) {
      return null;
    }
    return o;
  } catch {
    return null;
  }
}

export function serializeVolleyState(state: DDVolleyState): string {
  return JSON.stringify(state);
}

export function initVolleyState(classification: string, nowIso: string): DDVolleyState {
  return {
    status: "active",
    classification,
    volleyCount: 0,
    asked: [],
    answers: [],
    openedAt: nowIso,
    updatedAt: nowIso,
  };
}

// ── State machine ───────────────────────────────────────────────────────────

/** The slot asked but not yet answered (the one the next inbound answers).
 *  null when every asked slot is answered. */
export function pendingSlot(state: DDVolleyState): string | null {
  const answered = new Set(state.answers.map((a) => a.slot));
  for (const s of state.asked) {
    if (!answered.has(s)) return s;
  }
  return null;
}

/** True once every slot in the (opening) classification's sequence is stamped
 *  — the volley has the facts a precise number needs. */
export function ddAnswersComplete(state: DDVolleyState): boolean {
  const seq = ddSequenceFor(state.classification);
  if (seq.length === 0) return false;
  const answered = new Set(state.answers.map((a) => a.slot));
  return seq.every((s) => answered.has(s.slot));
}

/** Cap reached AND still incomplete → operator takes the wheel. */
export function isVolleyCapped(state: DDVolleyState): boolean {
  return state.volleyCount >= MAX_VOLLEYS && !ddAnswersComplete(state);
}

/** Next DD slot to ASK — first sequence slot neither asked nor answered.
 *  null when the sequence is exhausted or the cap is hit. */
export function nextDDSlot(state: DDVolleyState): DDSlot | null {
  if (state.volleyCount >= MAX_VOLLEYS) return null;
  const seq = ddSequenceFor(state.classification);
  const seen = new Set([...state.asked, ...state.answers.map((a) => a.slot)]);
  for (const s of seq) {
    if (!seen.has(s.slot)) return s;
  }
  return null;
}

/** Stamp an answer to the pending slot. No-op when nothing is pending, the
 *  answer is empty, or this msg id already stamped an answer — idempotent, so
 *  re-processing the same ingested inbound never double-stamps a DD answer
 *  (the "never skip a stamped answer" invariant runs both ways). */
export function recordDDAnswer(
  state: DDVolleyState,
  answer: string,
  msgId: string | null,
  nowIso: string,
): DDVolleyState {
  const slot = pendingSlot(state);
  if (!slot) return state;
  const trimmed = (answer ?? "").trim();
  if (!trimmed) return state;
  if (msgId && state.answers.some((a) => a.msgId === msgId)) return state;
  const answers = [...state.answers, { slot, answer: trimmed, stampedAt: nowIso, msgId: msgId ?? null }];
  const answeredSet = new Set(answers.map((a) => a.slot));
  const nextStatus: DDVolleyStatus = ddSequenceFor(state.classification).every((s) => answeredSet.has(s.slot))
    ? "complete"
    : state.status;
  return { ...state, answers, status: nextStatus, updatedAt: nowIso };
}

/** Mark a slot as asked (the volley just sent this DD question). */
export function markAsked(state: DDVolleyState, slot: string, nowIso: string): DDVolleyState {
  if (state.asked.includes(slot)) return state;
  return {
    ...state,
    asked: [...state.asked, slot],
    volleyCount: state.volleyCount + 1,
    status: "active",
    updatedAt: nowIso,
  };
}

// ── Orchestration decision (pure) ───────────────────────────────────────────

export type DDAction =
  | { kind: "none" } // classification opens no volley
  | { kind: "ask"; slot: string; question: string; state: DDVolleyState } // DD question = the draft
  | { kind: "number_gate_open"; state: DDVolleyState } // DD complete → derive (gated) elsewhere
  | { kind: "capped"; state: DDVolleyState }; // 3 asked, still incomplete → operator takes over

/** Decide what the volley wants to do for THIS inbound: record any pending
 *  answer, then either ask the next DD question (the draft), open the
 *  number-gate (facts complete), or cap out to the operator. Pure — the caller
 *  persists state, stamps the answer note, and drafts the question. */
export function decideDDAction(
  prev: DDVolleyState | null,
  classification: string,
  inbound: string,
  msgId: string | null,
  nowIso: string,
): DDAction {
  // A volley in flight continues on ITS opening classification; a fresh
  // engagement only opens one if the classification has a sequence.
  if (!prev && !classificationOpensVolley(classification)) return { kind: "none" };

  let state = prev ?? initVolleyState(classification, nowIso);

  // Record the answer to whatever we last asked (if anything is pending).
  if (pendingSlot(state)) {
    state = recordDDAnswer(state, inbound, msgId, nowIso);
  }

  if (ddAnswersComplete(state)) {
    return { kind: "number_gate_open", state: { ...state, status: "complete", updatedAt: nowIso } };
  }

  const next = nextDDSlot(state);
  if (!next) {
    // Sequence exhausted without completion, or cap reached.
    return { kind: "capped", state: { ...state, status: "capped", updatedAt: nowIso } };
  }

  state = markAsked(state, next.slot, nowIso);
  return { kind: "ask", slot: next.slot, question: next.question, state };
}

// ── Number-gate (pure) ──────────────────────────────────────────────────────

export interface NumberGateDecision {
  ok: boolean;
  /** Refusal reason when ok=false (surfaced, never silently dropped). */
  reason: string | null;
  /** Slots still missing when refused. */
  missing: string[];
}

/** THE GATE: may a precise contract number be derived for this deal yet? Only
 *  once every DD slot for the opening classification is stamped. Refuses (with
 *  the missing slots) otherwise — the derivation caller must HOLD, never
 *  fabricate a number ahead of the facts. This module decides ALLOWED/REFUSED;
 *  the number itself is computed by the existing pricing lanes downstream. */
export function canDeriveContractNumber(state: DDVolleyState | null): NumberGateDecision {
  if (!state) return { ok: false, reason: "no_dd_volley_started", missing: [] };
  const seq = ddSequenceFor(state.classification);
  if (seq.length === 0) return { ok: false, reason: "classification_has_no_dd_sequence", missing: [] };
  const answered = new Set(state.answers.map((a) => a.slot));
  const missing = seq.filter((s) => !answered.has(s.slot)).map((s) => s.slot);
  if (missing.length > 0) {
    return { ok: false, reason: `dd_answers_incomplete (need: ${missing.join(", ")})`, missing };
  }
  return { ok: true, reason: null, missing: [] };
}

/** ±$5 recompute-tolerance doctrine: a re-derived number within tolerance of
 *  the sticky delivery-stamped number IS the sticky number (no re-queue). */
export function withinRecomputeTolerance(
  stickyUsd: number,
  recomputedUsd: number,
  toleranceUsd: number = RECOMPUTE_TOLERANCE_USD,
): boolean {
  return Math.abs(Math.round(stickyUsd) - Math.round(recomputedUsd)) <= toleranceUsd;
}

/** Delivery-stamp line for a seller DD answer — appended to the notes ledger
 *  so the answer is a durable, provenance-tagged fact (not a field). */
export function ddAnswerStampLine(slot: string, answer: string, nowIso: string, msgId: string | null): string {
  const date = nowIso.slice(0, 10);
  return `${date} — [DD Volley] ${slot}: "${answer.slice(0, 240)}" [stamped ts=${nowIso}${msgId ? ` msg=${msgId}` : ""}]`;
}
