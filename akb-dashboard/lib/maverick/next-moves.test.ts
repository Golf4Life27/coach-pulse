import { describe, it, expect } from "vitest";
import type { ConveyorItem } from "@/lib/conveyor/model";
import {
  compactUsd,
  moveClock,
  moveHeadline,
  narrateConveyor,
  narrateMove,
  primaryOf,
  streetOf,
} from "./next-moves";

const NOW = "2026-07-14T18:00:00.000Z";

function item(o: Partial<ConveyorItem> = {}): ConveyorItem {
  return {
    key: "proposal:recX",
    source: "proposal",
    type: "2A",
    title: "123 Main St, Atlanta, GA 30310",
    reasoning: "Agent asked who covers the taxes.",
    recordId: "recX",
    href: "/pipeline/recX",
    dollars: null,
    deadlineAt: null,
    deadlineImplied: false,
    postedAt: NOW,
    verbatim: null,
    actions: [],
    ...o,
  };
}

const SEND = (proposalId = "jarvis_reply-1") =>
  ({ kind: "proposal_send", proposalId, to: "+13135551212", draftBody: "Bills get paid at closing.", inboundBody: null }) as const;

describe("compactUsd", () => {
  it("compacts thousands and keeps small amounts", () => {
    expect(compactUsd(42_000)).toBe("$42k");
    expect(compactUsd(137_800)).toBe("$138k");
    expect(compactUsd(950)).toBe("$950");
  });
});

describe("streetOf", () => {
  it("takes the street line off a full address", () => {
    expect(streetOf("123 Main St, Atlanta, GA 30310")).toBe("123 Main St");
    expect(streetOf(null)).toBe("(address pending)");
    expect(streetOf("")).toBe("(address pending)");
  });
});

describe("primaryOf", () => {
  it("prefers a dispatchable send", () => {
    const p = primaryOf(item({ actions: [SEND(), { kind: "proposal_snooze", proposalId: "x" }] }));
    expect(p).toEqual({ kind: "send", proposalId: "jarvis_reply-1", to: "+13135551212", draftBody: "Bills get paid at closing." });
  });
  it("falls to an explicit open (held reply — needs the room)", () => {
    const p = primaryOf(item({ actions: [{ kind: "open", href: "/pipeline/recX", label: "Open deal" }] }));
    expect(p).toEqual({ kind: "open", href: "/pipeline/recX", label: "Open deal" });
  });
  it("surfaces a one-tap approve (e.g. frontier retire)", () => {
    const p = primaryOf(item({ href: null, actions: [{ kind: "proposal_approve", proposalId: "fr-1", label: "Approve — pause ZIP" }] }));
    expect(p).toEqual({ kind: "approve", proposalId: "fr-1", label: "Approve — pause ZIP" });
  });
  it("falls back to the deep link when no dispatch action exists", () => {
    const p = primaryOf(item({ actions: [] }));
    expect(p).toEqual({ kind: "open", href: "/pipeline/recX", label: "Open" });
  });
  it("is none when there is nothing to do", () => {
    expect(primaryOf(item({ href: null, actions: [] }))).toEqual({ kind: "none" });
  });
});

describe("moveClock", () => {
  it("an implied same-day clock reads as waiting time, never a countdown", () => {
    const c = moveClock(
      item({ postedAt: "2026-07-14T14:00:00.000Z", deadlineAt: "2026-07-15T14:00:00.000Z", deadlineImplied: true }),
      NOW,
    );
    expect(c.text).toBe("waiting 4h");
    expect(c.tone).toBe("calm");
  });
  it("an overdue implied clock is flagged overdue", () => {
    const c = moveClock(
      item({ postedAt: "2026-07-13T10:00:00.000Z", deadlineAt: "2026-07-14T10:00:00.000Z", deadlineImplied: true }),
      NOW,
    );
    expect(c.text).toMatch(/overdue/);
    expect(c.tone).toBe("overdue");
  });
  it("a real deadline counts down, then goes OVERDUE", () => {
    expect(moveClock(item({ deadlineAt: "2026-07-14T20:00:00.000Z", deadlineImplied: false }), NOW).text).toBe("due in 2h");
    expect(moveClock(item({ deadlineAt: "2026-07-14T12:00:00.000Z", deadlineImplied: false }), NOW).text).toBe("OVERDUE");
  });
  it("no deadline → waiting since posted", () => {
    expect(moveClock(item({ deadlineAt: null, postedAt: "2026-07-14T13:00:00.000Z" }), NOW).text).toBe("waiting 5h");
  });
  it("no clock signal at all → null", () => {
    expect(moveClock(item({ deadlineAt: null, postedAt: null }), NOW).text).toBeNull();
  });
});

describe("moveHeadline — energy without invention", () => {
  it("2A send + inbound + money + urgent → money-led, ends in Send it", () => {
    const h = moveHeadline(item({ type: "2A", dollars: 42_000, verbatim: "who pays taxes?" }), 3, "send");
    expect(h).toContain("$42k");
    expect(h).toMatch(/send it/i);
  });
  it("2A send + inbound, calm, no money → agent replied / ready", () => {
    const h = moveHeadline(item({ type: "2A", dollars: null, verbatim: "who pays taxes?" }), 0, "send");
    expect(h).toMatch(/agent replied/i);
    expect(h).toMatch(/ready/i);
  });
  it("2A send, no inbound → drafted and ready", () => {
    expect(moveHeadline(item({ type: "2A", verbatim: null }), 0, "send")).toMatch(/drafted and ready/i);
  });
  it("2A with an open primary (held) → routes to the operator's own words", () => {
    expect(moveHeadline(item({ type: "2A" }), 0, "open")).toMatch(/your words/i);
  });
  it("2B → money/signature language", () => {
    expect(moveHeadline(item({ type: "2B" }), 3, "open")).toMatch(/sign|wire/i);
  });
  it("2C → your call", () => {
    expect(moveHeadline(item({ type: "2C" }), 0, "open")).toMatch(/your call/i);
  });
  it("never emits a dollar figure the item does not carry", () => {
    const h = moveHeadline(item({ type: "2A", dollars: null, verbatim: "x" }), 3, "send");
    expect(h).not.toMatch(/\$/);
  });
});

describe("narrateMove / narrateConveyor", () => {
  it("carries the inbound through so the card can show what we're replying to", () => {
    const m = narrateMove(item({ verbatim: "Who covers the back taxes?", actions: [SEND()] }), NOW);
    expect(m.inbound).toBe("Who covers the back taxes?");
    expect(m.street).toBe("123 Main St");
    expect(m.primary.kind).toBe("send");
  });

  it("preserves conveyor order — order IS the priority", () => {
    const items = [
      item({ key: "proposal:a", title: "1 A St, X, GA" }),
      item({ key: "proposal:b", title: "2 B St, X, GA" }),
      item({ key: "proposal:c", title: "3 C St, X, GA" }),
    ];
    expect(narrateConveyor(items, NOW).map((m) => m.key)).toEqual(["proposal:a", "proposal:b", "proposal:c"]);
  });

  it("urgency is derived from the item's clock (overdue implied → 4)", () => {
    const m = narrateMove(
      item({ deadlineAt: "2026-07-14T10:00:00.000Z", deadlineImplied: true, postedAt: "2026-07-13T10:00:00.000Z" }),
      NOW,
    );
    expect(m.urgency).toBe(4);
    expect(m.tone).toBe("overdue");
  });

  it("a back-half contract item uses its own crafted message as the headline (no generic 2B line, no duplicate why)", () => {
    const m = narrateMove(
      item({
        source: "contract",
        type: "2B",
        reasoning: "Earnest money due Jul 16 — voice-verify the wire landed, then mark EMD received.",
        actions: [{ kind: "open", href: "/pipeline/recX", label: "Confirm EMD" }],
      }),
      NOW,
    );
    expect(m.headline).toMatch(/earnest money due jul 16/i);
    expect(m.headline).not.toMatch(/money's on the table/i); // not the generic 2B line
    expect(m.why).toBe(""); // suppressed — headline already carries it
    expect(m.primary).toEqual({ kind: "open", href: "/pipeline/recX", label: "Confirm EMD" });
  });
});
