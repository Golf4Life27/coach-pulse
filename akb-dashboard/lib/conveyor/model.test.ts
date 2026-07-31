import { describe, it, expect } from "vitest";
import {
  firstDollarAmount,
  typeForProposal,
  typeForText,
  fromProposal,
  fromActionItem,
  fromPriority,
  fromBroCard,
  rankConveyor,
  dedupeConveyor,
  buildConveyor,
  urgencyRank,
  filterDecisionProposals,
  type ProposalRow,
  batchFrontierRetire,
  fromVisionHold,
} from "./model";

const NOW = "2026-07-11T16:00:00Z";

function proposal(over: Partial<ProposalRow> = {}): ProposalRow {
  return {
    id: "recPROP000000001",
    proposalType: "jarvis_reply",
    recordId: "recLIST000000001",
    recordAddress: "2718 Ave I, Ensley",
    reasoning: "Seller said no go to $12,000; soft-no re-engagement drafted. Second sentence ignored.",
    actionPayload: JSON.stringify({
      action: "send_sms",
      to: "+12055550111",
      draftBody: "Hi there — my $12,000 cash offer still stands if timing changes.",
      inboundBody: "No go",
    }),
    createdTime: "2026-07-11T10:00:00Z",
    ...over,
  };
}

describe("firstDollarAmount", () => {
  it("extracts the first sourced amount and never invents one", () => {
    expect(firstDollarAmount("offer of $37,250 on Frisbee")).toBe(37_250);
    expect(firstDollarAmount(null, "no numbers here")).toBeNull();
    expect(firstDollarAmount("$0 case")).toBeNull();
    expect(firstDollarAmount("first $1,000 then $2,000")).toBe(1_000);
  });
});

describe("typing", () => {
  it("send-class proposals are 2A, decisions are 2C", () => {
    expect(typeForProposal("jarvis_reply")).toBe("2A");
    expect(typeForProposal("follow_up")).toBe("2A");
    expect(typeForProposal("frontier_retire")).toBe("2C");
    expect(typeForProposal("h2_opener_hold")).toBe("2C");
  });

  it("money/signature language types 2B", () => {
    expect(typeForText("Send the COGO letter batch")).toBe("2B");
    expect(typeForText("Wire the EMD to escrow")).toBe("2B");
    expect(typeForText("Decide whether to widen the buy box")).toBe("2C");
  });
});

describe("mappers", () => {
  it("jarvis_reply proposal → 2A card with send action, sourced $, implied same-day clock", () => {
    const item = fromProposal(proposal());
    expect(item.type).toBe("2A");
    expect(item.dollars).toBe(12_000);
    expect(item.verbatim).toBe("No go");
    expect(item.deadlineImplied).toBe(true);
    expect(item.deadlineAt).toBe("2026-07-12T10:00:00.000Z");
    expect(item.actions[0].kind).toBe("proposal_send");
    expect(item.href).toBe("/pipeline/recLIST000000001");
    expect(item.reasoning).toBe("Seller said no go to $12,000; soft-no re-engagement drafted.");
  });

  it("h2_opener_hold → list price NEVER renders as money-in-play; Open is the tap; plain-English preface", () => {
    const item = fromProposal(
      proposal({
        id: "recHOLD0000000002",
        proposalType: "h2_opener_hold",
        recordId: "recREGAL00000001",
        recordAddress: "817 Regal Ln SW, Atlanta, GA 30331",
        reasoning:
          "H2 opener HOLD [market_not_priceable]: rough ceiling null (hold_no_value_basis) × anchor ? vs list $355,000. Decide: source ARV/rehab and re-run, or skip this record.",
        actionPayload: JSON.stringify({ action: "h2_opener_hold" }),
      }),
    );
    expect(item.dollars).toBeNull(); // $355,000 is the ASK, not money in play
    expect(item.actions[0]).toMatchObject({ kind: "open", href: "/pipeline/recREGAL00000001" });
    expect(item.actions.some((a) => a.kind === "proposal_approve")).toBe(false);
    expect(item.reasoning).toContain("Pricer HOLD — no autonomous text will fire");
    expect(item.deadlineAt).toBeNull(); // holds rank by age, never by a fake clock
  });

  it("frontier_retire proposal → 2C one-tap approve, no implied clock", () => {
    const item = fromProposal(
      proposal({
        proposalType: "frontier_retire",
        actionPayload: JSON.stringify({ action: "frontier_retire", recordId: "recZIP0000000001", zip: "77051" }),
        reasoning: "Zero-yield snapshot.",
      }),
    );
    expect(item.type).toBe("2C");
    expect(item.deadlineAt).toBeNull();
    expect(item.actions[0]).toMatchObject({ kind: "proposal_approve", label: "Approve — pause ZIP" });
    expect(item.dollars).toBeNull();
  });

  it("action item with signature language → 2B with resolve/defer", () => {
    const item = fromActionItem({
      id: "itm1",
      title: "Sign the Poteet assignment contract",
      sourceRecordId: "recLIST000000002",
      actionRequired: "DocuSign envelope waiting; $7,500 assignment fee at stake.",
      context: null,
      verbatimReply: null,
      priority: "high",
      createdAt: "2026-07-10T12:00:00Z",
    });
    expect(item.type).toBe("2B");
    expect(item.dollars).toBe(7_500);
    expect(item.actions.map((a) => a.kind)).toEqual(["action_item_resolve", "action_item_defer"]);
  });

  it("curated priority keeps its real revenue + deadline", () => {
    const item = fromPriority({
      id: "cogo-batch",
      title: "COGO letter batch",
      why: "Unblocks 4 deals worth $28,000 combined.",
      instructions: null,
      href: "/pipeline/recLIST000000003",
      revenueUsd: 28_000,
      deadlineAt: "2026-07-11T20:00:00Z",
      postedAt: "2026-07-10T09:00:00Z",
    });
    expect(item.type).toBe("2B");
    expect(item.dollars).toBe(28_000);
    expect(item.deadlineAt).toBe("2026-07-11T20:00:00Z");
    expect(item.deadlineImplied).toBe(false);
    expect(item.recordId).toBe("recLIST000000003");
  });
});

describe("ranking", () => {
  it("urgency dominates, then dollars, then type, then oldest", () => {
    const overdueRuling = fromPriority({
      id: "r1", title: "Ruling", why: "Old ruling.", instructions: null, href: null,
      revenueUsd: null, deadlineAt: "2026-07-11T10:00:00Z", postedAt: "2026-07-09T09:00:00Z",
    });
    const bigMoneyLater = fromPriority({
      id: "r2", title: "Sign contract", why: "Money.", instructions: null, href: null,
      revenueUsd: 50_000, deadlineAt: "2026-07-15T10:00:00Z", postedAt: "2026-07-11T09:00:00Z",
    });
    const replyToday = fromProposal(proposal()); // implied deadline within 24h
    const ranked = rankConveyor([bigMoneyLater, overdueRuling, replyToday], NOW);
    expect(ranked.map((i) => i.key)).toEqual([overdueRuling.key, replyToday.key, bigMoneyLater.key]);
  });

  it("urgencyRank buckets deadlines honestly", () => {
    const base = fromProposal(proposal());
    expect(urgencyRank({ ...base, deadlineAt: "2026-07-11T15:00:00Z" }, NOW)).toBe(4);
    expect(urgencyRank({ ...base, deadlineAt: "2026-07-12T10:00:00Z" }, NOW)).toBe(3);
    expect(urgencyRank({ ...base, deadlineAt: "2026-07-13T20:00:00Z" }, NOW)).toBe(2);
    expect(urgencyRank({ ...base, deadlineAt: "2026-07-20T10:00:00Z" }, NOW)).toBe(1);
    expect(urgencyRank({ ...base, deadlineAt: null }, NOW)).toBe(0);
  });
});

describe("dedupe + buildConveyor", () => {
  it("drops a brief card duplicated by an actionable proposal on the same record", () => {
    const items = dedupeConveyor([
      fromProposal(proposal()),
      fromBroCard({ recordId: "recLIST000000001", address: "2718 Ave I", headline: "Reply", why_this_matters: "" }),
      fromBroCard({ recordId: "recOTHER00000001", address: "Elsewhere", headline: "Check", why_this_matters: "" }),
    ]);
    expect(items.map((i) => i.key)).toEqual(["proposal:recPROP000000001", "brocard:recOTHER00000001"]);
  });

  it("buildConveyor merges all four sources into one ranked feed", () => {
    const { items: feed } = buildConveyor(
      {
        proposals: [proposal()],
        actionItems: [],
        priorities: [
          {
            id: "p1", title: "Sign EMD wire", why: "Deal closes Friday.", instructions: null,
            href: null, revenueUsd: 9_000, deadlineAt: "2026-07-11T12:00:00Z", postedAt: "2026-07-10T08:00:00Z",
          },
        ],
        broCards: [{ recordId: "recLIST000000001", address: "2718 Ave I", headline: "dup", why_this_matters: "" }],
      },
      NOW,
    );
    expect(feed).toHaveLength(2);
    expect(feed[0].key).toBe("priority:p1"); // overdue money outranks
    expect(feed[1].key).toBe("proposal:recPROP000000001");
  });

  it("the machine-work gate: housekeeping proposals never render, and are counted as proof", () => {
    const { items, hidden } = buildConveyor(
      {
        proposals: [
          proposal(), // jarvis_reply — decision-grade, renders
          proposal({ id: "recFUP0000000001", proposalType: "follow_up", recordId: "recDEAD00000001", reasoning: "[HIGH] Silent for multiple days after Negotiating status." }),
          proposal({ id: "recKILL0000000001", proposalType: "kill_dead_deal", recordId: "recDEAD00000002" }),
          proposal({ id: "recSTALE000000001", proposalType: "surface_stale", recordId: "recDEAD00000003" }),
        ],
        actionItems: [],
        priorities: [],
        broCards: [],
      },
      NOW,
    );
    expect(items.map((i) => i.key)).toEqual(["proposal:recPROP000000001"]);
    expect(hidden.machineWork).toBe(3);
    expect(hidden.stale).toBe(0);
  });

  it("the staleness gate: a cold reply draft (>10d) and an ancient ruling (>14d) hide", () => {
    const { items, hidden } = buildConveyor(
      {
        proposals: [
          proposal({ id: "recCOLD0000000001", createdTime: "2026-06-25T10:00:00Z" }), // 16d-old jarvis_reply
          proposal({
            id: "recOLDRULE00000001",
            proposalType: "underwater_review",
            createdTime: "2026-06-20T10:00:00Z", // 21d-old ruling
            actionPayload: JSON.stringify({ action: "underwater_review" }),
          }),
          proposal({
            id: "recFRESH000000001",
            proposalType: "underwater_review",
            createdTime: "2026-07-10T10:00:00Z", // fresh ruling — renders
            actionPayload: JSON.stringify({ action: "underwater_review" }),
          }),
        ],
        actionItems: [],
        priorities: [],
        broCards: [],
      },
      NOW,
    );
    expect(items.map((i) => i.key)).toEqual(["proposal:recFRESH000000001"]);
    expect(hidden.stale).toBe(2);
    expect(hidden.machineWork).toBe(0);
  });

  it("opener holds are BACKLOG at any age — never cards, never counted as handled", () => {
    // Operator 2026-07-31: 533 pending h2_opener_hold against 72 live seller
    // threads. A price-guard HOLD is maintenance, not a ruling owed an answer.
    // Age is irrelevant — a fresh hold is backlog too.
    const { items, hidden } = buildConveyor(
      {
        proposals: [
          proposal({
            id: "recHOLD0000000001",
            proposalType: "h2_opener_hold",
            createdTime: "2026-06-20T10:00:00Z", // ancient
            actionPayload: JSON.stringify({ action: "h2_opener_hold" }),
          }),
          proposal({
            id: "recHOLD0000000002",
            proposalType: "h2_opener_hold",
            createdTime: "2026-07-10T10:00:00Z", // fresh
            actionPayload: JSON.stringify({ action: "h2_opener_hold" }),
          }),
        ],
        actionItems: [],
        priorities: [],
        broCards: [],
      },
      NOW,
    );
    expect(items).toEqual([]);
    expect(hidden.backlog).toBe(2);
    // NOT machine work — the distinction is the point. Machine work is done;
    // backlog is real work nobody has started.
    expect(hidden.machineWork).toBe(0);
    expect(hidden.stale).toBe(0);
  });
});

// ── underwater_review (post-vision park, 2026-07-16) ───────────────────────
describe("underwater_review renders as a decision, not machine-work", () => {
  const row = {
    id: "recProposalUW1",
    proposalType: "underwater_review",
    recordId: "recDEAL123456789A",
    recordAddress: "2208 Mayfield Ave SW",
    reasoning: "Deal went underwater when the math got real: spread -$14,608 (buyer ceiling $12,392 vs current price $27,000). An offer is already out — rule it: pass, re-verify condition, or route creative.",
    actionPayload: "{}",
    createdTime: "2026-07-16T00:00:00.000Z",
  };
  it("passes the machine-work gate (decision-grade)", () => {
    const gate = filterDecisionProposals([row], "2026-07-16T12:00:00.000Z");
    expect(gate.kept).toHaveLength(1);
    expect(gate.machineWorkHidden).toBe(0);
  });
  it("maps to a 2C ruling with Open-deal primary (no lying Approve)", () => {
    const item = fromProposal(row);
    expect(item.type).toBe("2C");
    expect(item.actions[0]).toMatchObject({ kind: "open", label: "Open deal" });
    expect(item.reasoning).toMatch(/underwater/i);
    expect(item.reasoning).not.toMatch(/Pricer HOLD/); // carries its own sentence
  });
});

// ── Frontier batching + vision holds (operator 2026-07-31) ─────────────────
describe("batchFrontierRetire — one ruling, not forty-two cards", () => {
  const frontier = (id: string, zip: string, reason: string) => ({
    id,
    proposalType: "frontier_retire",
    recordId: "recZIP0000000001",
    recordAddress: `ZIP ${zip}`,
    reasoning: reason,
    actionPayload: JSON.stringify({ action: "frontier_retire", zip }),
    createdTime: "2026-07-09T10:00:00Z",
  });
  const STALE = (z: string) =>
    `Frontier retirement candidate: ZIP ${z} — zero_yield_latest_snapshot: crawled within 30d, 0 records ingested, 0% accept.`;
  const STREAK = (z: string) =>
    `Frontier retirement candidate: ZIP ${z} — zero_yield_streak: 4 consecutive empty ingest runs (min 3).`;

  it("collapses many into one card carrying every proposal id", () => {
    const rows = ["44307", "78210", "44314", "35206", "44310", "35211"].map((z, i) =>
      frontier(`recFR000000000${i}`, z, STREAK(z)),
    );
    const { batch, rest } = batchFrontierRetire(rows);
    expect(rest).toEqual([]);
    expect(batch).not.toBeNull();
    expect(batch!.title).toBe("Retire 6 zero-yield ZIPs");
    const action = batch!.actions[0] as { kind: string; proposalIds: string[]; decision: string };
    expect(action.kind).toBe("proposal_batch");
    expect(action.proposalIds).toHaveLength(6);
    expect(action.decision).toBe("approve");
    // First five ZIPs shown, the remainder counted — not truncated silently.
    expect(batch!.verbatim).toBe("44307 · 78210 · 44314 · 35206 · 44310 · +1");
  });

  it("flips to ARCHIVE when any row carries the retired single-snapshot rule", () => {
    // The 42 pending on 2026-07-31 were written before the 07-29 rule change
    // (3-run streak + 30d revival). Approving them would retire ZIPs that only
    // had one slow crawl — the operator's "farm it once and never again".
    const rows = ["44307", "78210", "44314"].map((z, i) => frontier(`recFR000000000${i}`, z, STALE(z)));
    const { batch } = batchFrontierRetire(rows);
    const action = batch!.actions[0] as { decision: string; label: string };
    expect(action.decision).toBe("reject");
    expect(action.label).toBe("Archive all 3");
    expect(batch!.reasoning).toMatch(/single empty crawl/);
    expect(batch!.reasoning).toMatch(/rests 30 days/);
  });

  it("leaves a couple of proposals alone — batching two costs more than it saves", () => {
    const rows = ["44307", "78210"].map((z, i) => frontier(`recFR000000000${i}`, z, STREAK(z)));
    const { batch, rest } = batchFrontierRetire(rows);
    expect(batch).toBeNull();
    expect(rest).toHaveLength(2);
  });

  it("never touches non-frontier proposals", () => {
    const rows = [
      frontier("recFR0000000001", "44307", STREAK("44307")),
      frontier("recFR0000000002", "78210", STREAK("78210")),
      frontier("recFR0000000003", "44314", STREAK("44314")),
      proposal({ id: "recREPLY00000001" }),
    ];
    const { batch, rest } = batchFrontierRetire(rows);
    expect(batch).not.toBeNull();
    expect(rest.map((r) => r.id)).toEqual(["recREPLY00000001"]);
  });
});

describe("fromVisionHold — the 256 Westchester lane", () => {
  it("says the rehab would be invented, and never renders list price as money in play", () => {
    const item = fromVisionHold({
      recordId: "recVIS00000000001",
      address: "1617 5th St NW, Center Point, AL",
      listPrice: 124_900,
      failureReason: "no_photos_available",
      heldAt: "2026-07-31T09:00:00Z",
    });
    expect(item.source).toBe("vision");
    expect(item.reasoning).toMatch(/no photos/i);
    expect(item.reasoning).toMatch(/invented/);
    // Nothing has been offered — a held record must not report dollars in play.
    expect(item.dollars).toBeNull();
    expect(item.verbatim).toBe("List $124,900");
    // Run rehab is PRIMARY — one tap, costs the operator nothing. Looking at
    // the photos yourself is the fallback for when the machine already failed.
    expect(item.actions.map((a) => a.kind)).toEqual(["vision_rerun", "open"]);
  });

  it("distinguishes a thrown vision call from missing photos", () => {
    const item = fromVisionHold({
      recordId: "recVIS00000000002",
      address: "44 Springfield St, Dayton, OH",
      listPrice: null,
      failureReason: "vision_error: rate limited",
      heldAt: null,
    });
    expect(item.reasoning).toMatch(/could not resolve/i);
    expect(item.verbatim).toBeNull();
  });
});
