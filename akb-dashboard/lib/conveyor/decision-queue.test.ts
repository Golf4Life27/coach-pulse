import { describe, it, expect } from "vitest";
import {
  buildDecisionQueue,
  decisionClass,
  fromListingDecision,
  isPendingDecision,
  mathLine,
  ourNumber,
  stagedAction,
  type ListingDecisionRow,
} from "./decision-queue";
import { buildConveyor, dedupeConveyor, type ProposalRow } from "./model";

const NOW = "2026-09-01T23:00:00Z";

function row(over: Partial<ListingDecisionRow> = {}): ListingDecisionRow {
  return {
    id: "recSHnUgSiHRZeFzA",
    address: "1102 Montrose Ave, Toledo, OH 43607",
    agentName: "Marlin Winchester",
    outreachStatus: "Offer Accepted",
    pipelineStage: "negotiating",
    listPrice: 89_900,
    roughOpenerAmount: 55_750,
    contractOfferPrice: null,
    latestCounterUsd: null,
    buyerCeiling: null,
    dealSpread: null,
    decisionVerdict: "NEEDS_DATA",
    lastInboundAt: "2026-09-01T19:53:05Z",
    lastOutboundAt: "2026-08-30T22:32:16Z",
    actionCardState: null,
    blacklist: false,
    doNotText: false,
    ...over,
  };
}

describe("decisionClass", () => {
  it("acceptances and counters are decisions; everything else is machine work", () => {
    expect(decisionClass(row())).toBe("acceptance");
    expect(decisionClass(row({ outreachStatus: "Counter Received" }))).toBe("counter");
    expect(decisionClass(row({ outreachStatus: "Negotiating", latestCounterUsd: 66_000 }))).toBe("counter");
    expect(decisionClass(row({ outreachStatus: "Negotiating" }))).toBeNull();
    expect(decisionClass(row({ outreachStatus: "Response Received" }))).toBeNull();
    expect(decisionClass(row({ outreachStatus: "Texted", latestCounterUsd: 1 }))).toBeNull();
  });
});

describe("isPendingDecision", () => {
  it("renders a live acceptance", () => {
    expect(isPendingDecision(row(), NOW)).toBe(true);
  });
  it("never renders a killed record", () => {
    expect(isPendingDecision(row({ blacklist: true }), NOW)).toBe(false);
    expect(isPendingDecision(row({ doNotText: true }), NOW)).toBe(false);
    expect(isPendingDecision(row({ pipelineStage: "dead" }), NOW)).toBe(false);
  });
  it("stays off the belt once the operator ruled (Cleared/Held)", () => {
    expect(isPendingDecision(row({ actionCardState: "Cleared" }), NOW)).toBe(false);
    expect(isPendingDecision(row({ actionCardState: "Held" }), NOW)).toBe(false);
    expect(isPendingDecision(row({ actionCardState: "Open" }), NOW)).toBe(true);
  });
  it("needs a live inbound inside the age gate", () => {
    expect(isPendingDecision(row({ lastInboundAt: null }), NOW)).toBe(false);
    expect(isPendingDecision(row({ lastInboundAt: "2026-08-01T00:00:00Z" }), NOW)).toBe(false);
    expect(isPendingDecision(row({ lastInboundAt: "2026-08-20T00:00:00Z" }), NOW)).toBe(true);
  });
});

describe("math line — sourced only", () => {
  it("prefers the negotiation-stage number over the opener", () => {
    expect(ourNumber(row())).toBe(55_750);
    expect(ourNumber(row({ contractOfferPrice: 60_000 }))).toBe(60_000);
    expect(ourNumber(row({ roughOpenerAmount: null }))).toBeNull();
  });
  it("renders blanks as dashes, never estimates", () => {
    expect(mathLine(row())).toBe("List $89,900 · ours $55,750 · buyer ceiling — · spread — · verdict NEEDS_DATA");
    expect(
      mathLine(row({ outreachStatus: "Negotiating", latestCounterUsd: 66_000, buyerCeiling: 78_000, dealSpread: 9_000, decisionVerdict: "GO" })),
    ).toBe("List $89,900 · ours $55,750 · their $66,000 · buyer ceiling $78,000 · spread $9,000 · verdict GO");
    expect(mathLine(row({ listPrice: null, roughOpenerAmount: null, decisionVerdict: null }))).toBe(
      "List — · ours — · buyer ceiling — · spread — · verdict —",
    );
  });
  it("staged action names the number on the table", () => {
    expect(stagedAction(row())).toBe("Accept at $55,750 — paper it with an inspection period");
    expect(stagedAction(row({ roughOpenerAmount: null }))).toBe(
      "Acceptance received — confirm the number on the thread before papering",
    );
    expect(stagedAction(row({ outreachStatus: "Counter Received", latestCounterUsd: 66_000 }))).toBe(
      "Rule on the $66,000 counter (accept / counter back / walk)",
    );
  });
});

describe("fromListingDecision", () => {
  it("acceptance is 2B with Approve / Edit / Kill and money = the number on the table", () => {
    const item = fromListingDecision(row());
    expect(item.key).toBe("listing:recSHnUgSiHRZeFzA");
    expect(item.source).toBe("listing");
    expect(item.type).toBe("2B");
    expect(item.title).toBe("1102 Montrose Ave, Toledo, OH 43607 — Marlin Winchester");
    expect(item.dollars).toBe(55_750);
    expect(item.href).toBe("/pipeline/recSHnUgSiHRZeFzA");
    expect(item.deadlineImplied).toBe(true);
    expect(item.deadlineAt).toBe("2026-09-02T19:53:05.000Z");
    expect(item.actions.map((a) => a.kind)).toEqual(["listing_approve", "open", "listing_kill"]);
    const approve = item.actions[0];
    expect(approve.kind === "listing_approve" && approve.note).toBe("Accept at $55,750 — paper it with an inspection period");
    const edit = item.actions[1];
    expect(edit.kind === "open" && edit.label).toBe("Edit");
  });
  it("counter is 2C and the counter is the money in play", () => {
    const item = fromListingDecision(row({ outreachStatus: "Negotiating", latestCounterUsd: 66_000, agentName: null }));
    expect(item.type).toBe("2C");
    expect(item.dollars).toBe(66_000);
    expect(item.title).toBe("1102 Montrose Ave, Toledo, OH 43607");
  });
});

describe("buildDecisionQueue + conveyor integration", () => {
  it("selects only pending decisions", () => {
    const items = buildDecisionQueue(
      [row(), row({ id: "recDEAD0000000001", blacklist: true }), row({ id: "recTEXT0000000001", outreachStatus: "Texted" })],
      NOW,
    );
    expect(items.map((i) => i.key)).toEqual(["listing:recSHnUgSiHRZeFzA"]);
  });
  it("rides the existing conveyor and ranks above a plain ruling", () => {
    const { items } = buildConveyor(
      {
        proposals: [],
        actionItems: [
          { id: "recAI000000000001", title: "Decide the buy box", sourceRecordId: null, actionRequired: "Widen or not.", context: null, verbatimReply: null, priority: "low", createdAt: "2026-08-30T00:00:00Z" },
        ],
        priorities: [],
        broCards: [],
        listingDecisions: buildDecisionQueue([row()], NOW),
      },
      NOW,
    );
    expect(items[0].key).toBe("listing:recSHnUgSiHRZeFzA");
  });
  it("a drafted reply proposal for the same record wins the dedupe", () => {
    const proposal: ProposalRow = {
      id: "recPROP000000001",
      proposalType: "jarvis_reply",
      recordId: "recSHnUgSiHRZeFzA",
      recordAddress: "1102 Montrose Ave",
      reasoning: "Counter-terms drafted.",
      actionPayload: JSON.stringify({ action: "send_sms", to: "+14194663514", draftBody: "Counter terms: 7-day inspection.", inboundBody: "Seller will accept" }),
      createdTime: "2026-09-01T20:00:00Z",
    };
    const { items } = buildConveyor(
      { proposals: [proposal], actionItems: [], priorities: [], broCards: [], listingDecisions: buildDecisionQueue([row()], NOW) },
      NOW,
    );
    expect(items.map((i) => i.source)).toEqual(["proposal"]);
    expect(dedupeConveyor([fromListingDecision(row())]).length).toBe(1);
  });
});
