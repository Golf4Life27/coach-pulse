// Maverick's proactive voice over the decision conveyor (operator 2026-07-14:
// "I want Maverick to be my right-hand man… a constant feed… staying one step
// ahead of me and compiling all the data, sorting and feeding me things to do
// in order, not just a massive to-do list I have to sort through").
//
// This is a NARRATION layer — nothing new is decided here. It takes the SAME
// ranked buildConveyor() output the Act Now page renders and wraps each item in
// an energetic, imperative headline + an honest clock + a normalized primary
// action, PRESERVING conveyor order (order == priority). Because the dock and
// the landing both narrate the identical ranked items, they can never diverge
// on "what's most important" — the ranking lives in one place (conveyor/model),
// the voice lives here.
//
// PURE. No I/O. Sourced only: the headline is composed from the item's own
// type / sourced dollars / verbatim / clock — it never invents a fact
// (INVARIANTS §1). The energy is in the phrasing, not in new numbers.

import {
  urgencyRank,
  type ConveyorItem,
  type ConveyorType,
  type UrgencyRank,
} from "@/lib/conveyor/model";

const HOUR_MS = 3_600_000;

export type MoveTone = "overdue" | "soon" | "calm";

/** The single action the dock puts in front of the operator. Send is the
 *  money tap (dispatches the drafted reply); open jumps to the deal room where
 *  the full controls live; approve is a one-tap ruling (e.g. frontier retire). */
export type NextMovePrimary =
  | { kind: "send"; proposalId: string; to: string; draftBody: string }
  | { kind: "open"; href: string; label: string }
  | { kind: "approve"; proposalId: string; label: string }
  | { kind: "none" };

export interface NextMove {
  key: string;
  type: ConveyorType;
  /** 0-4 (overdue). Drives the pulse / accent in the dock. */
  urgency: UrgencyRank;
  /** Energetic Maverick-voice imperative — derived only from sourced signals. */
  headline: string;
  /** The one-sentence why carried straight from the conveyor item. */
  why: string;
  /** "waiting 5h" / "due in 2h" / "OVERDUE" / null. */
  clock: string | null;
  tone: MoveTone;
  /** SOURCED dollars in play, or null. */
  dollars: number | null;
  recordId: string | null;
  href: string | null;
  /** Street line only (the deal room carries the full address). */
  street: string;
  /** The inbound this move answers, when it's a reply — so the operator sees
   *  the message he's replying to without opening the deal card. */
  inbound: string | null;
  primary: NextMovePrimary;
}

/** Compact money for a headline: $42k / $950. */
export function compactUsd(n: number): string {
  return n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${Math.round(n)}`;
}

/** Street line from the conveyor title (which is the address). */
export function streetOf(title: string | null): string {
  return (title ?? "").split(",")[0].trim() || "(address pending)";
}

/** Normalize the item's action list to the one primary tap the dock surfaces.
 *  Send (dispatch a drafted reply) wins; then an explicit open; then a one-tap
 *  approve; then any deep link; else nothing (headline-only nudge). */
export function primaryOf(item: ConveyorItem): NextMovePrimary {
  const send = item.actions.find((a) => a.kind === "proposal_send");
  if (send && send.kind === "proposal_send") {
    return { kind: "send", proposalId: send.proposalId, to: send.to, draftBody: send.draftBody };
  }
  const open = item.actions.find((a) => a.kind === "open");
  if (open && open.kind === "open") {
    return { kind: "open", href: open.href, label: open.label ?? "Open" };
  }
  const approve = item.actions.find((a) => a.kind === "proposal_approve");
  if (approve && approve.kind === "proposal_approve") {
    return { kind: "approve", proposalId: approve.proposalId, label: approve.label ?? "Approve" };
  }
  if (item.href) return { kind: "open", href: item.href, label: "Open" };
  return { kind: "none" };
}

/** The honest clock, mirroring ConveyorCard's semantics so the dock and the
 *  card never label the same item differently. Implied same-day clocks render
 *  as waiting time (never a fake countdown); real deadlines count down. */
export function moveClock(item: ConveyorItem, nowIso: string): { text: string | null; tone: MoveTone } {
  const now = Date.parse(nowIso);
  if (item.deadlineAt) {
    const t = Date.parse(item.deadlineAt);
    if (Number.isFinite(t)) {
      const h = (t - now) / HOUR_MS;
      if (item.deadlineImplied) {
        const posted = item.postedAt ? Date.parse(item.postedAt) : NaN;
        const waitedH = Number.isFinite(posted) ? Math.max(0, Math.round((now - posted) / HOUR_MS)) : null;
        if (h <= 0) return { text: waitedH != null ? `waiting ${waitedH}h — overdue` : "overdue", tone: "overdue" };
        return { text: waitedH != null ? `waiting ${waitedH}h` : "due today", tone: h <= 6 ? "soon" : "calm" };
      }
      if (h <= 0) return { text: "OVERDUE", tone: "overdue" };
      if (h <= 24) return { text: `due in ${Math.max(1, Math.round(h))}h`, tone: "soon" };
      return { text: `due ${new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`, tone: "calm" };
    }
  }
  if (item.postedAt) {
    const p = Date.parse(item.postedAt);
    if (Number.isFinite(p)) {
      const h = Math.round((now - p) / HOUR_MS);
      return { text: h < 24 ? `waiting ${Math.max(0, h)}h` : `waiting ${Math.round(h / 24)}d`, tone: "calm" };
    }
  }
  return { text: null, tone: "calm" };
}

/** The Maverick-voice imperative. Composed only from sourced signals: the
 *  item's type, whether a dispatchable draft exists, whether a seller message
 *  triggered it (verbatim), the sourced dollars, and the urgency. No numbers
 *  are invented — the punch is phrasing. */
export function moveHeadline(
  item: ConveyorItem,
  urgency: UrgencyRank,
  primaryKind: NextMovePrimary["kind"],
): string {
  const money = item.dollars != null ? compactUsd(item.dollars) : null;
  const hot = urgency >= 3;

  if (item.type === "2B") {
    return hot
      ? "Money's on the table — sign or wire to lock it in."
      : "Money step — your signature or wire moves this one.";
  }
  if (item.type === "2C") {
    return "Your call — the machine holds here until you rule on it.";
  }

  // 2A — a send lane.
  if (primaryKind === "send") {
    if (item.verbatim) {
      if (money && hot) return `${money} live — they just replied and your answer's drafted. Send it.`;
      if (hot) return "They replied and they're waiting — your reply's drafted, send it.";
      if (money) return `${money} in play — agent replied, your reply's ready to go.`;
      return "Agent replied — your reply's drafted and ready.";
    }
    return money ? `${money} drafted and ready — one tap sends it.` : "Drafted and ready — one tap sends it.";
  }
  // 2A with no dispatchable draft (a guardrail HOLD): the operator's own words
  // are required — we route him into the room, never fire a canned line.
  return "Held for your words — open it and reply in your voice.";
}

/** Narrate one ranked conveyor item into a Maverick NextMove. */
export function narrateMove(item: ConveyorItem, nowIso: string): NextMove {
  const urgency = urgencyRank(item, nowIso);
  const primary = primaryOf(item);
  const clock = moveClock(item, nowIso);
  // Back-half contract items carry their own crafted, specific imperative in
  // `reasoning` ("Earnest money due Jul 16 — voice-verify the wire…"), so use
  // THAT as the headline rather than the generic type-based line, and suppress
  // the duplicate `why`.
  const isContract = item.source === "contract";
  const headline = isContract ? item.reasoning : moveHeadline(item, urgency, primary.kind);
  return {
    key: item.key,
    type: item.type,
    urgency,
    headline,
    why: isContract ? "" : item.reasoning,
    clock: clock.text,
    tone: clock.tone,
    dollars: item.dollars,
    recordId: item.recordId,
    href: item.href,
    street: streetOf(item.title),
    inbound: item.verbatim,
    primary,
  };
}

/** Narrate the whole ranked feed — order preserved (conveyor order IS the
 *  priority the operator wants fed to him in sequence). */
export function narrateConveyor(items: ConveyorItem[], nowIso: string): NextMove[] {
  return items.map((it) => narrateMove(it, nowIso));
}
