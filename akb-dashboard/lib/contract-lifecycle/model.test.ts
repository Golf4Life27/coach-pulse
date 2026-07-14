import { describe, it, expect } from "vitest";
import {
  isBackHalfStage,
  nextContractAction,
  contractLifecycleItems,
  type ContractDealRow,
} from "./model";

const NOW = "2026-07-14T18:00:00.000Z";

function deal(o: Partial<ContractDealRow> = {}): ContractDealRow {
  return {
    recordId: "recSUNBEAM0000001",
    address: "3123 Sunbeam St, Houston, TX 77051",
    pipelineStage: "under_contract",
    contractPrice: 113_750,
    dealSpread: null,
    contractExecutedAt: null,
    emdDueAt: null,
    emdReceived: false,
    optionDeadline: null,
    closeDate: null,
    ...o,
  };
}

describe("isBackHalfStage", () => {
  it("true only for under_contract / dispo_active / assignment_signed", () => {
    expect(isBackHalfStage("under_contract")).toBe(true);
    expect(isBackHalfStage("dispo_active")).toBe(true);
    expect(isBackHalfStage("assignment_signed")).toBe(true);
  });
  it("false for front-half, terminal, and empty", () => {
    for (const s of ["negotiating", "offer_drafted", "closed", "dead", "", null, undefined]) {
      expect(isBackHalfStage(s as string | null)).toBe(false);
    }
  });
});

describe("nextContractAction — non-back-half deals never surface", () => {
  it("returns null for a negotiating deal", () => {
    expect(nextContractAction(deal({ pipelineStage: "negotiating" }), NOW)).toBeNull();
  });
  it("returns null for a closed deal", () => {
    expect(nextContractAction(deal({ pipelineStage: "closed" }), NOW)).toBeNull();
  });
});

describe("nextContractAction — lifecycle walk (first unmet step)", () => {
  it("1. under contract, no executed date → verify status (2B), hot implied clock", () => {
    const item = nextContractAction(deal(), NOW)!;
    expect(item.source).toBe("contract");
    expect(item.key).toBe("contract:recSUNBEAM0000001");
    expect(item.type).toBe("2B");
    expect(item.reasoning).toMatch(/confirm the fully-executed contract/i);
    expect(item.deadlineImplied).toBe(true);
    expect(item.href).toBe("/pipeline/recSUNBEAM0000001");
    expect(item.actions).toEqual([{ kind: "open", href: "/pipeline/recSUNBEAM0000001", label: "Verify status" }]);
    expect(item.dollars).toBe(113_750);
  });

  it("2. executed, EMD due & not received → confirm EMD (2B) on the EMD clock", () => {
    const item = nextContractAction(deal({ contractExecutedAt: "2026-07-10", emdDueAt: "2026-07-16", emdReceived: false }), NOW)!;
    expect(item.type).toBe("2B");
    expect(item.reasoning).toMatch(/earnest money due/i);
    expect(item.reasoning).toMatch(/voice-verify/i);
    expect(item.deadlineAt).toBe("2026-07-16");
    expect(item.deadlineImplied).toBe(false);
    expect(item.actions[0]).toMatchObject({ label: "Confirm EMD" });
  });

  it("EMD received → skips the EMD step", () => {
    const item = nextContractAction(deal({ contractExecutedAt: "2026-07-10", emdDueAt: "2026-07-16", emdReceived: true }), NOW)!;
    expect(item.reasoning).not.toMatch(/earnest money due/i);
  });

  it("3. executed, EMD clear, option window open → dispo-or-terminate (2C) on the option clock", () => {
    const item = nextContractAction(deal({ contractExecutedAt: "2026-07-10", emdReceived: true, optionDeadline: "2026-07-20" }), NOW)!;
    expect(item.type).toBe("2C");
    expect(item.reasoning).toMatch(/option window closes/i);
    expect(item.deadlineAt).toBe("2026-07-20");
    expect(item.actions[0]).toMatchObject({ label: "Run dispo" });
  });

  it("4. dispo_active past the option window → run dispo (2C)", () => {
    const item = nextContractAction(
      deal({ pipelineStage: "dispo_active", contractExecutedAt: "2026-07-01", optionDeadline: "2026-07-01", emdReceived: true }),
      NOW,
    )!;
    expect(item.type).toBe("2C");
    expect(item.reasoning).toMatch(/in dispo/i);
  });

  it("5. executed, clear, close date set → confirm closing (2B) on the close clock", () => {
    const item = nextContractAction(deal({ contractExecutedAt: "2026-07-01", emdReceived: true, closeDate: "2026-08-01" }), NOW)!;
    expect(item.type).toBe("2B");
    expect(item.reasoning).toMatch(/closing/i);
    expect(item.deadlineAt).toBe("2026-08-01");
    expect(item.actions[0]).toMatchObject({ label: "Confirm closing" });
  });

  it("6. under contract, executed, no forward dates → set-your-dates nudge (2C)", () => {
    const item = nextContractAction(deal({ contractExecutedAt: "2026-07-01", emdReceived: true }), NOW)!;
    expect(item.type).toBe("2C");
    expect(item.reasoning).toMatch(/set your EMD, option, and close dates/i);
    expect(item.deadlineImplied).toBe(true);
    expect(item.actions[0]).toMatchObject({ label: "Set dates" });
  });
});

describe("nextContractAction — dollars in play", () => {
  it("prefers the decision-math spread over the contract price", () => {
    const item = nextContractAction(deal({ dealSpread: 15_000, contractPrice: 113_750 }), NOW)!;
    expect(item.dollars).toBe(15_000);
  });
  it("falls back to the contract price, else null", () => {
    expect(nextContractAction(deal({ dealSpread: null, contractPrice: 113_750 }), NOW)!.dollars).toBe(113_750);
    expect(nextContractAction(deal({ dealSpread: null, contractPrice: null }), NOW)!.dollars).toBeNull();
  });
});

describe("contractLifecycleItems", () => {
  it("keeps back-half deals, drops the rest", () => {
    const items = contractLifecycleItems(
      [
        deal({ recordId: "recA0000000000001", pipelineStage: "under_contract" }),
        deal({ recordId: "recB0000000000002", pipelineStage: "negotiating" }),
        deal({ recordId: "recC0000000000003", pipelineStage: "dispo_active" }),
      ],
      NOW,
    );
    expect(items.map((i) => i.recordId)).toEqual(["recA0000000000001", "recC0000000000003"]);
  });
});
