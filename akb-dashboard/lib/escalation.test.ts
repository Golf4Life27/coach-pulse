import { describe, it, expect } from "vitest";
import {
  readEscalationConfig,
  shouldEscalate,
  composeEscalationSms,
  composeDigestSms,
  insideChicagoWindow,
} from "./escalation";
import { fromPriority, type ConveyorItem } from "./conveyor/model";

const NOW = "2026-07-11T16:00:00Z"; // 11:00 Chicago
const CFG = readEscalationConfig({});

function item(over: Partial<ConveyorItem> = {}): ConveyorItem {
  return {
    ...fromPriority({
      id: "p1",
      title: "COGO letter batch",
      why: "Unblocks 4 deals.",
      instructions: null,
      href: "/pipeline/recLIST000000001",
      revenueUsd: 28_000,
      deadlineAt: null,
      postedAt: "2026-07-11T06:00:00Z", // 10h old at NOW
    }),
    ...over,
  };
}

describe("shouldEscalate", () => {
  it("escalates an aged decision with real dollars while the operator is away", () => {
    const v = shouldEscalate(item(), { lastSeenIso: "2026-07-11T02:00:00Z", nowIso: NOW, cfg: CFG });
    expect(v.escalate).toBe(true);
    expect(v.reason).toBe("aged_with_dollars");
  });

  it("never escalates without a SOURCED dollar amount", () => {
    const v = shouldEscalate(item({ dollars: null }), { lastSeenIso: null, nowIso: NOW, cfg: CFG });
    expect(v).toMatchObject({ escalate: false, reason: "no_real_dollars" });
  });

  it("stays quiet when the operator was just in the cockpit", () => {
    const v = shouldEscalate(item(), { lastSeenIso: "2026-07-11T15:30:00Z", nowIso: NOW, cfg: CFG });
    expect(v).toMatchObject({ escalate: false, reason: "operator_recently_seen" });
  });

  it("stays quiet on young decisions unless a REAL deadline is overdue", () => {
    const young = item({ postedAt: "2026-07-11T14:00:00Z" });
    expect(shouldEscalate(young, { lastSeenIso: null, nowIso: NOW, cfg: CFG }).escalate).toBe(false);

    const overdue = item({ postedAt: "2026-07-11T14:00:00Z", deadlineAt: "2026-07-11T15:00:00Z", deadlineImplied: false });
    const v = shouldEscalate(overdue, { lastSeenIso: null, nowIso: NOW, cfg: CFG });
    expect(v).toMatchObject({ escalate: true, reason: "overdue_with_dollars" });

    // An IMPLIED clock (2A same-day) never counts as a hard overdue.
    const implied = item({ postedAt: "2026-07-11T14:00:00Z", deadlineAt: "2026-07-11T15:00:00Z", deadlineImplied: true });
    expect(shouldEscalate(implied, { lastSeenIso: null, nowIso: NOW, cfg: CFG }).escalate).toBe(false);
  });

  it("respects the dollar floor", () => {
    const small = item({ dollars: 400 });
    expect(shouldEscalate(small, { lastSeenIso: null, nowIso: NOW, cfg: CFG }).escalate).toBe(false);
  });
});

describe("composition", () => {
  it("escalation SMS is one plain sentence with a deep link", () => {
    const sms = composeEscalationSms(item(), "https://coach-pulse-ten.vercel.app", 10);
    expect(sms).toBe(
      "AKB: $28,000 money/signature decision on COGO letter batch waiting 10h — https://coach-pulse-ten.vercel.app/pipeline/recLIST000000001",
    );
  });

  it("digest packs decisions, dollars, and belt into one message", () => {
    const sms = composeDigestSms(
      [item(), item({ type: "2A", dollars: 12_000 })],
      { intakeFreshness: "ok", sendFreshness: "ok", sentYesterday: 8, repliesYesterday: 2 },
      "https://coach-pulse-ten.vercel.app",
    );
    expect(sms).toContain("2 decisions waiting (1 sends, 1 money, 0 rulings)");
    expect(sms).toContain("$40,000 at stake");
    expect(sms).toContain("belt: intake ok · send ok · yday 8 sent/2 replies");
  });
});

describe("insideChicagoWindow", () => {
  it("blocks night-time escalation on the operator's own phone", () => {
    expect(insideChicagoWindow(new Date("2026-07-11T16:00:00Z"), CFG)).toBe(true); // 11:00 CT
    expect(insideChicagoWindow(new Date("2026-07-11T08:00:00Z"), CFG)).toBe(false); // 03:00 CT
  });
});
