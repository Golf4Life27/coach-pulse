// COUNTER DECISION — a concrete, bounded recommendation for a live counter-
// offer (Part B, 2026-09-18 operator escalation). @agent: maverick
//
// "If you don't have a recommended reply or reply options based on facts, I
// am doing all the thinking again." Two counters landed the same day with NO
// ARV, NO rehab, NO photos (265 Harrison St / 331 NE 9th Ave) — the system
// could only draft the generic condition question. A third (724 Dennison)
// HAD the facts and the card still just said "HELD — your judgment" with no
// number. This module is the fix: given the facts already on the record, it
// returns a stance, a headline naming the number, and a short menu of
// ready-to-edit reply options — never a fresh guess.
//
// PRICING DOCTRINE (skill: pricing-doctrine): the value-anchored ceiling
// (Buyer_Ceiling / Your_MAO_V21, already net of fee) is the ONLY producer of
// a number here. This module never derives, adjusts, or improvises a price —
// it only compares the ceiling against the seller's counter and our own
// sticky (delivery-stamped) offer, and it never proposes a number above the
// ceiling. Missing ceiling/ARV data is a HOLD ("blind"), never a guess.
//
// Every composed message rides the same sticky-or-silence / never-above-
// ceiling guardrail every other operator draft rides
// (lib/recommended-reply.validateReplyDraft) — the option's own committed
// number stands in for "sticky" in that check, since the one figure a
// message may say is the one figure it is FOR. These messages are built
// deterministically (never model-generated), so a guardrail failure here
// means a bug in this file, not a bad seller reply — it throws rather than
// ship a silently-wrong draft.
//
// PURE. No I/O, no model. See lib/counter-decision.test.ts for the three
// real deals that motivated it (265 Harrison St / 331 NE 9th Ave — blind;
// 724 Dennison — walk/hold).

import { validateReplyDraft, type ReplyDraftContext } from "@/lib/recommended-reply";
import { CONDITION } from "@/lib/dd-volley-machine";

export interface CounterDecisionInputs {
  /** Their number (Latest_Counter_Usd). */
  counterUsd: number | null;
  /** Our delivery-stamped offer (Outreach_Offer_Price) — the floor of what
   *  we have already said. */
  stickyUsd: number | null;
  /** Doctrine ceiling (Buyer_Ceiling / Your_MAO_V21), already net of fee. */
  ceilingUsd: number | null;
  /** Our own max offer (Your_MAO_V21 — ceiling minus the target fee). Used
   *  only to catch the "PASS but their counter is still under the buyer
   *  ceiling" thin-fee case; never a source of a fresh price on its own. */
  maoUsd?: number | null;
  /** Decision_Verdict. */
  verdict: string | null;
  arvUsd: number | null;
  arvConfidence: string | null;
  rehabUsd: number | null;
  listUsd: number | null;
  agentFirstName: string | null;
}

export type CounterStance = "accept" | "counter" | "hold" | "walk" | "blind";

export interface CounterOption {
  key: "accept" | "counter" | "hold" | "walk" | "stall";
  label: string;
  message: string;
  amountUsd: number | null;
}

export interface CounterDecision {
  stance: CounterStance;
  headline: string;
  facts: string[];
  options: CounterOption[];
  reason: string;
}

// ── formatting ─────────────────────────────────────────────────────────

function usd(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

/** Plain-ASCII normalization — every message here must be SMS-safe (no
 *  em/en dashes, curly quotes, or ellipsis glyphs a carrier can mangle). */
function toAscii(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...");
}

function greet(first: string | null): string {
  return first ? `Hey ${first}, ` : "";
}

function roundDown250(n: number): number {
  return Math.floor(n / 250) * 250;
}

// ── guardrail (reuses lib/recommended-reply's deterministic checks) ─────

function guardCtx(amountUsd: number | null, ceilingUsd: number | null, agentFirstName: string | null): ReplyDraftContext {
  return {
    recordId: "",
    street: "",
    channel: "sms",
    classification: "counter",
    inbound: "",
    conversationTail: "",
    stickyOfferUsd: amountUsd,
    ceilingUsd,
    listPriceUsd: null,
    cappedToList: false,
    flags: { estate: false, lien: false, probate: false, multiOffer: false },
    agentFirstName,
  };
}

/** Validate + return a composed message. `ceilingForCheck` is the ceiling
 *  this SPECIFIC message must never exceed — for a newly proposed number
 *  that is the true doctrine ceiling; for a message that only RESTATES our
 *  own already-sent sticky offer, it is the sticky amount itself (restating
 *  what was already said is never "inventing a number above ceiling", even
 *  when a freshly recomputed ceiling has since dropped below it — the
 *  sticky number is the floor of what we have said, doctrine standard 6). */
function guarded(message: string, amountUsd: number | null, ceilingForCheck: number | null, agentFirstName: string | null): string {
  const text = toAscii(message);
  const v = validateReplyDraft(text, guardCtx(amountUsd, ceilingForCheck, agentFirstName));
  if (!v.ok) {
    throw new Error(`counter-decision: composed message failed guardrail (${v.holdReason}): ${text}`);
  }
  return text;
}

function stickyRestateMessage(first: string | null, stickyUsd: number, ceilingUsd: number | null): string {
  const message = `${greet(first)}${usd(stickyUsd)} is where we can be - cash, as-is, and we'll close on your timeline.`;
  const ceilingForCheck = ceilingUsd != null ? Math.max(ceilingUsd, stickyUsd) : stickyUsd;
  return guarded(message, stickyUsd, ceilingForCheck, first);
}

// ── the universal "ask about condition" stall option ────────────────────

function stallMessage(first: string | null): string {
  const q = toAscii(CONDITION.question);
  if (!first) return q;
  return `Hey ${first}, ${q.charAt(0).toLowerCase()}${q.slice(1)}`;
}

function stallOption(i: CounterDecisionInputs): CounterOption {
  const message = guarded(stallMessage(i.agentFirstName), null, i.ceilingUsd, i.agentFirstName);
  return { key: "stall", label: "Ask about condition", message, amountUsd: null };
}

// ── shared facts ──────────────────────────────────────────────────────

function factLines(i: CounterDecisionInputs, ceilingUsd: number, extra: string[] = []): string[] {
  const facts: string[] = [];
  if (i.arvUsd != null) facts.push(`ARV: ${usd(i.arvUsd)}${i.arvConfidence ? ` (${i.arvConfidence})` : ""}`);
  if (i.rehabUsd != null) facts.push(`Rehab estimate: ${usd(i.rehabUsd)}`);
  facts.push(`Ceiling (max a buyer can pay): ${usd(ceilingUsd)}`);
  if (i.maoUsd != null) facts.push(`Our max offer (MAO): ${usd(i.maoUsd)}`);
  if (i.stickyUsd != null) facts.push(`Our current offer on record: ${usd(i.stickyUsd)}`);
  if (i.counterUsd != null) {
    const diff = i.counterUsd - ceilingUsd;
    facts.push(
      diff > 0
        ? `Their counter ${usd(i.counterUsd)} is ${usd(diff)} above the ceiling`
        : `Their counter ${usd(i.counterUsd)} is within the ceiling`,
    );
  }
  facts.push(...extra);
  return facts;
}

// ── stance builders ──────────────────────────────────────────────────────

function buildBlind(i: CounterDecisionInputs): CounterDecision {
  const missing: string[] = [];
  if (i.arvUsd == null) missing.push("No ARV on file");
  if (i.rehabUsd == null) missing.push("No rehab estimate on file");
  if (i.verdict === "NEEDS_DATA") missing.push("Underwrite verdict: NEEDS_DATA");
  if (i.verdict === "HOLD_LOW_CONF") missing.push("Underwrite verdict: HOLD_LOW_CONF (low confidence)");
  if (missing.length === 0) missing.push("No doctrine ceiling computed yet");
  return {
    stance: "blind",
    headline: "Blind: no ARV or rehab on this deal yet",
    facts: missing,
    options: [stallOption(i)],
    reason: `missing: ${missing.join("; ")}`,
  };
}

function buildNoCounter(i: CounterDecisionInputs): CounterDecision {
  return {
    stance: "hold",
    headline: "Hold: no counter number on record yet",
    facts: [],
    options: [stallOption(i)],
    reason: "no_counter_recorded",
  };
}

function buildAccept(i: CounterDecisionInputs, ceilingUsd: number, counterUsd: number, extraFacts: string[] = []): CounterDecision {
  const options: CounterOption[] = [];
  const acceptMsg = guarded(
    `${greet(i.agentFirstName)}${usd(counterUsd)} works - send over the contract and let's get it signed.`,
    counterUsd,
    ceilingUsd,
    i.agentFirstName,
  );
  options.push({ key: "accept", label: `Accept at ${usd(counterUsd)}`, message: acceptMsg, amountUsd: counterUsd });

  if (i.stickyUsd != null && counterUsd > i.stickyUsd + 250) {
    const midpoint = (i.stickyUsd + counterUsd) / 2;
    const proposed = Math.min(roundDown250(midpoint), ceilingUsd);
    const counterMsg = guarded(
      `${greet(i.agentFirstName)}I can move to ${usd(proposed)} - let me know if that works and we'll lock it in.`,
      proposed,
      ceilingUsd,
      i.agentFirstName,
    );
    options.push({ key: "counter", label: `Counter at ${usd(proposed)}`, message: counterMsg, amountUsd: proposed });
  }

  options.push(stallOption(i));
  return {
    stance: "accept",
    headline: `Accept at ${usd(counterUsd)}: it clears the ceiling`,
    facts: factLines(i, ceilingUsd, extraFacts),
    options,
    reason: `counter ${usd(counterUsd)} is at or under the ${usd(ceilingUsd)} ceiling`,
  };
}

// PASS but the counter is still at or under the buyer ceiling ("thin fee"):
// the underwrite PASSed only because the counter sits above our MAO (the
// ceiling minus the $10k target fee), not because the deal is unaffordable.
// Never let that masquerade as "walk" (265 Harrison St, 2026-09-18 —
// counter $35,000 clears the $41,032 ceiling with $6,032 left for us, and
// the old code walked anyway). If the counter is still above our own MAO,
// counter AT the MAO instead; the MAO is a real number already on the
// record, never a fresh guess.
function buildThinFeeCounter(i: CounterDecisionInputs, ceilingUsd: number, counterUsd: number, maoUsd: number): CounterDecision {
  const proposed = roundDown250(maoUsd);
  const fee = ceilingUsd - counterUsd;
  const options: CounterOption[] = [];

  const counterMsg = guarded(
    `${greet(i.agentFirstName)}I can do ${usd(proposed)} - cash, as-is, closing on your timeline.`,
    proposed,
    ceilingUsd,
    i.agentFirstName,
  );
  options.push({ key: "counter", label: `Counter at ${usd(proposed)}`, message: counterMsg, amountUsd: proposed });

  const acceptMsg = guarded(
    `${greet(i.agentFirstName)}${usd(counterUsd)} works - send over the contract and let's get it signed.`,
    counterUsd,
    ceilingUsd,
    i.agentFirstName,
  );
  options.push({
    key: "accept",
    label: `Accept at ${usd(counterUsd)} (thin: ${usd(fee)} fee)`,
    message: acceptMsg,
    amountUsd: counterUsd,
  });

  options.push(stallOption(i));

  const walkMsg = guarded(
    `${greet(i.agentFirstName)}that number doesn't work on our end, but if anything changes on price or terms we'd love another look.`,
    null,
    ceilingUsd,
    i.agentFirstName,
  );
  options.push({ key: "walk", label: "Walk away politely", message: walkMsg, amountUsd: null });

  return {
    stance: "counter",
    headline: `Counter at ${usd(proposed)}: their ${usd(counterUsd)} clears the buyer ceiling but leaves only ${usd(fee)} for us`,
    facts: factLines(i, ceilingUsd),
    options,
    reason: `counter ${usd(counterUsd)} is within the ${usd(ceilingUsd)} ceiling but above our ${usd(maoUsd)} MAO`,
  };
}

function buildCounter(i: CounterDecisionInputs, ceilingUsd: number, counterUsd: number): CounterDecision {
  const proposed = roundDown250(ceilingUsd);
  const options: CounterOption[] = [];
  const counterMsg = guarded(
    `${greet(i.agentFirstName)}The best we can do is ${usd(proposed)} - cash, as-is, closing on your timeline.`,
    proposed,
    ceilingUsd,
    i.agentFirstName,
  );
  options.push({ key: "counter", label: `Counter at ${usd(proposed)}`, message: counterMsg, amountUsd: proposed });

  if (i.stickyUsd != null) {
    options.push({
      key: "hold",
      label: `Hold at ${usd(i.stickyUsd)}`,
      message: stickyRestateMessage(i.agentFirstName, i.stickyUsd, ceilingUsd),
      amountUsd: i.stickyUsd,
    });
  }

  options.push(stallOption(i));
  return {
    stance: "counter",
    headline: `Counter at ${usd(proposed)}: their number is above what a buyer can pay`,
    facts: factLines(i, ceilingUsd),
    options,
    reason: `counter ${usd(counterUsd)} exceeds the ${usd(ceilingUsd)} ceiling`,
  };
}

function buildHold(i: CounterDecisionInputs, ceilingUsd: number, stickyUsd: number): CounterDecision {
  const holdMsg = stickyRestateMessage(i.agentFirstName, stickyUsd, ceilingUsd);
  const walkMsg = guarded(
    `${greet(i.agentFirstName)}that number doesn't work on our end, but if anything changes on price or terms we'd love another look.`,
    null,
    ceilingUsd,
    i.agentFirstName,
  );
  return {
    stance: "hold",
    headline: `Hold at ${usd(stickyUsd)}: we are already at the ceiling`,
    facts: factLines(i, ceilingUsd),
    options: [
      { key: "hold", label: `Hold at ${usd(stickyUsd)}`, message: holdMsg, amountUsd: stickyUsd },
      { key: "walk", label: "Walk away politely", message: walkMsg, amountUsd: null },
      stallOption(i),
    ],
    reason: `ceiling ${usd(ceilingUsd)} does not clear our own ${usd(stickyUsd)} sticky offer`,
  };
}

function buildWalk(i: CounterDecisionInputs, ceilingUsd: number): CounterDecision {
  const walkMsg = guarded(
    `${greet(i.agentFirstName)}that number is more than the house is worth fixed up, so we have to pass - if anything changes we'd love another look.`,
    null,
    ceilingUsd,
    i.agentFirstName,
  );
  const options: CounterOption[] = [{ key: "walk", label: "Walk away politely", message: walkMsg, amountUsd: null }];
  if (i.stickyUsd != null) {
    options.push({
      key: "hold",
      label: `Hold at ${usd(i.stickyUsd)}`,
      message: stickyRestateMessage(i.agentFirstName, i.stickyUsd, ceilingUsd),
      amountUsd: i.stickyUsd,
    });
  }
  options.push(stallOption(i));

  const namesArv = i.arvUsd != null && i.counterUsd != null && i.counterUsd >= i.arvUsd;
  const headline = namesArv
    ? `Walk: their ${usd(i.counterUsd as number)} is at or above the ${usd(i.arvUsd as number)} after-repair value`
    : i.counterUsd != null
      ? `Walk: their ${usd(i.counterUsd)} is above the ${usd(ceilingUsd)} ceiling and the math says PASS`
      : "Walk: the underwrite says PASS";
  const reason = namesArv
    ? `counter ${usd(i.counterUsd as number)} is at or above ARV ${usd(i.arvUsd as number)}`
    : i.counterUsd != null
      ? `counter ${usd(i.counterUsd)} exceeds the ${usd(ceilingUsd)} ceiling and the underwrite verdict is PASS`
      : "decision verdict is PASS";

  return {
    stance: "walk",
    headline,
    facts: factLines(i, ceilingUsd),
    options,
    reason,
  };
}

// ── entry point ───────────────────────────────────────────────────────

/** Pure: turn the record's already-computed facts into a stance, a
 *  headline that names the number, and a bounded menu of ready-to-edit
 *  reply options. Never derives a price — the ceiling (already computed by
 *  the pricing lanes) is the only producer of a number this module reads. */
export function decideCounter(i: CounterDecisionInputs): CounterDecision {
  // BLIND — no doctrine ceiling, or the underwrite itself says it can't be
  // trusted yet. Never guess; ask the one question that unblocks it.
  if (i.ceilingUsd == null || i.verdict === "NEEDS_DATA" || i.verdict === "HOLD_LOW_CONF") {
    return buildBlind(i);
  }
  const ceilingUsd = i.ceilingUsd;

  if (i.counterUsd == null) {
    return buildNoCounter(i);
  }
  const counterUsd = i.counterUsd;

  // WALK — never pay at or above ARV, and never let a genuinely-over-ceiling
  // PASS through; this outranks the ceiling/sticky comparisons below. A PASS
  // whose counter is still at or under the ceiling is NOT a walk (265
  // Harrison St, 2026-09-18: PASS came from missing the $10k target fee by
  // $3,968, not from the counter being unaffordable — $35,000 counter was
  // comfortably under the $41,032 ceiling).
  const overArv = i.arvUsd != null && counterUsd >= i.arvUsd;
  const passOverCeiling = i.verdict === "PASS" && counterUsd > ceilingUsd;
  if (overArv || passOverCeiling) {
    return buildWalk(i, ceilingUsd);
  }

  // THIN FEE — PASS, but their counter is still under the ceiling. If it's
  // also above our own MAO, counter at the MAO (a real number already on
  // the record) instead of accepting a fee below doctrine target.
  if (i.verdict === "PASS" && counterUsd <= ceilingUsd && i.maoUsd != null && counterUsd > i.maoUsd) {
    return buildThinFeeCounter(i, ceilingUsd, counterUsd, i.maoUsd);
  }

  if (counterUsd <= ceilingUsd) {
    // Reaching here with verdict PASS means the thin-fee branch above didn't
    // fire (no MAO on record, or the counter is already at/under our MAO) —
    // surface the contradiction so the operator can see the PASS on a deal
    // that otherwise accepts cleanly.
    const extraFacts = i.verdict === "PASS" ? ["Underwrite verdict: PASS"] : [];
    return buildAccept(i, ceilingUsd, counterUsd, extraFacts);
  }
  if (ceilingUsd > (i.stickyUsd ?? -Infinity)) {
    return buildCounter(i, ceilingUsd, counterUsd);
  }
  return buildHold(i, ceilingUsd, i.stickyUsd as number);
}
