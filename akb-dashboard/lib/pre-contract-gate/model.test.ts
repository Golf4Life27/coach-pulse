import { describe, it, expect } from "vitest";
import { evaluatePreContractGate, type GateInput } from "./model";

const NOW = "2026-07-16T18:00:00.000Z";

/** A CLEAN, ready-to-contract wholesale deal. Your MAO = 93,886 − 15,000 =
 *  78,886; price 75,000 sits under it. */
function gi(o: Partial<GateInput> = {}): GateInput {
  return {
    contractPrice: 75_000,
    arv: 190_000,
    rehab: 45_000,
    buyerCeiling: 93_886,
    landlordMao: 70_000,
    listPrice: 150_000,
    decisionVerdict: "TIGHT",
    ddDone: 12,
    ddTotal: 12,
    lastVerifiedAt: "2026-07-14T00:00:00.000Z", // 2 days ago
    exit: "wholesale",
    waivers: {},
    wholesaleFee: 15_000,
    ...o,
  };
}
const byId = (g: ReturnType<typeof evaluatePreContractGate>, id: string) => g.checks.find((c) => c.id === id)!;

describe("evaluatePreContractGate — the clean path", () => {
  it("a fully-underwritten, exit-picked, priced-right deal clears", () => {
    const g = evaluatePreContractGate(gi(), NOW);
    expect(g.status).toBe("clear");
    expect(g.canContract).toBe(true);
    expect(g.blockers).toBe(0);
    expect(g.checks.every((c) => c.status === "pass")).toBe(true);
  });
});

describe("evaluatePreContractGate — the 3123 Sunbeam scenario", () => {
  it("un-underwritten + no exit + no market check → BLOCKED with multiple blockers", () => {
    const g = evaluatePreContractGate(
      gi({
        arv: null,
        rehab: null,
        buyerCeiling: null,
        decisionVerdict: "NEEDS_DATA",
        exit: null,
        contractPrice: 113_750,
        listPrice: 175_000,
        ddDone: 0,
        lastVerifiedAt: null,
      }),
      NOW,
    );
    expect(g.status).toBe("blocked");
    expect(g.canContract).toBe(false);
    expect(byId(g, "underwriting_real").status).toBe("fail");
    expect(byId(g, "exit_selected").status).toBe("fail");
    expect(byId(g, "dd_checklist").status).toBe("fail");
    expect(byId(g, "market_fresh").status).toBe("fail");
    expect(g.blockers).toBeGreaterThanOrEqual(4);
  });
});

describe("price ceiling — exit-aware", () => {
  it("cash/wholesale: price above the buyer ceiling is UNDERWATER → fail", () => {
    const g = evaluatePreContractGate(gi({ contractPrice: 120_000 }), NOW); // > ceiling 93,886
    const p = byId(g, "price_within_ceiling");
    expect(p.status).toBe("fail");
    expect(p.detail).toMatch(/underwater/i);
    expect(g.status).toBe("blocked");
  });

  it("cash/wholesale: price between Your MAO and buyer ceiling is THIN → warn, not blocked", () => {
    const g = evaluatePreContractGate(gi({ contractPrice: 85_000 }), NOW); // 78,886 < 85k < 93,886
    expect(byId(g, "price_within_ceiling").status).toBe("warn");
    expect(g.status).toBe("warn");
    expect(g.canContract).toBe(true);
  });

  it("rental: priced against the LANDLORD MAO, not the flip ceiling", () => {
    expect(byId(evaluatePreContractGate(gi({ exit: "rental", contractPrice: 65_000 }), NOW), "price_within_ceiling").status).toBe("pass");
    const over = byId(evaluatePreContractGate(gi({ exit: "rental", contractPrice: 75_000 }), NOW), "price_within_ceiling");
    expect(over.status).toBe("fail");
    expect(over.detail).toMatch(/landlord MAO/i);
  });

  it("creative: NOT judged on flip-MAO — needs an eyes-open confirmation (waiver)", () => {
    // Underwater as a flip, but exit=creative → the price check isn't the flip test.
    const blocked = evaluatePreContractGate(gi({ exit: "creative", contractPrice: 120_000 }), NOW);
    const p = byId(blocked, "price_within_ceiling");
    expect(p.label).toMatch(/creative/i);
    expect(p.detail).not.toMatch(/underwater/i); // creative is not flip-judged
    expect(blocked.status).toBe("blocked"); // until confirmed
    // Operator confirms the structure → waive → clears to WAIVED, can contract.
    const confirmed = evaluatePreContractGate(
      gi({ exit: "creative", contractPrice: 120_000, waivers: { price_within_ceiling: "sub-to, 3.1% rate, cash-flows $340/mo" } }),
      NOW,
    );
    expect(confirmed.canContract).toBe(true);
    expect(confirmed.status).toBe("waived");
  });
});

describe("waivers — eyes-open override (the anti-strangle rule)", () => {
  it("waiving a hard fail removes it as a blocker; status becomes WAIVED", () => {
    const g = evaluatePreContractGate(
      gi({ lastVerifiedAt: "2026-06-01T00:00:00.000Z", waivers: { market_fresh: "just pulled HAR, still $150k" } }),
      NOW,
    );
    expect(byId(g, "market_fresh").waived).toBe(true);
    expect(g.canContract).toBe(true);
    expect(g.status).toBe("waived");
  });

  it("exit_selected is NOT waivable — you must consciously pick the exit", () => {
    const g = evaluatePreContractGate(gi({ exit: null, waivers: { exit_selected: "skip it" } }), NOW);
    expect(byId(g, "exit_selected").waived).toBe(false);
    expect(byId(g, "exit_selected").status).toBe("fail");
    expect(g.status).toBe("blocked");
  });
});

describe("dd + market checks", () => {
  it("an incomplete DD checklist fails; an absent checklist only warns", () => {
    expect(byId(evaluatePreContractGate(gi({ ddDone: 5, ddTotal: 12 }), NOW), "dd_checklist").status).toBe("fail");
    expect(byId(evaluatePreContractGate(gi({ ddTotal: 0 }), NOW), "dd_checklist").status).toBe("warn");
  });

  it("a stale market read fails and forces a re-verify", () => {
    const g = evaluatePreContractGate(gi({ lastVerifiedAt: "2026-06-20T00:00:00.000Z" }), NOW); // ~26d
    expect(byId(g, "market_fresh").status).toBe("fail");
    expect(byId(g, "market_fresh").detail).toMatch(/re-verify/i);
  });
});
