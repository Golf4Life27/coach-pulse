// MLS-date projection — unit tests. Validates the in-code replication against
// the live Airtable formula chain (incl. reproducing today's "no date ->
// Manual Review" state, which proves the replication is faithful).

import { describe, it, expect } from "vitest";
import { projectMlsRouting } from "./mls-date-projection";

const NOW = new Date("2026-06-19T12:00:00Z");
// 5793 Holcomb anchor: List 32000, MAO 20750 -> spread 11250 -> /10000 = 1.125.
// distress score = DOM/30 + 0 drops + 1.125; >= 3 needs DOM >= ~56.25.
const base = { now: NOW, listPrice: 32000, mao: 20750, priceDrops: 0, hasAgentPhone: true };

describe("projectMlsRouting", () => {
  it("NO date reproduces today's state: Data Issue -> Manual Review", () => {
    const p = projectMlsRouting({ ...base, listedDate: null });
    expect(p.hasMlsDate).toBe(false);
    expect(p.dom).toBeNull();
    expect(p.stageCalc).toBe("Data Issue: Missing MLS Date");
    expect(p.routing).toBe("Manual Review");
  });

  it("aged listing (DOM clears distress) -> Passed -> Auto Proceed", () => {
    // listed 70 days before NOW -> DOM 70 -> score 70/30 + 1.125 = 3.46 -> Moderate.
    const listed = new Date(NOW.getTime() - 70 * 86_400_000).toISOString();
    const p = projectMlsRouting({ ...base, listedDate: listed });
    expect(p.dom).toBe(70);
    expect(p.distressPass).toBe(true);
    expect(p.stageCalc).toBe("Passed: Ready for Offer");
    expect(p.routing).toBe("Auto Proceed");
    expect(p.autoProceedSendable).toBe(true);
  });

  it("fresh listing (low DOM, not distressed) -> Rejected: No Distress -> Reject", () => {
    const listed = new Date(NOW.getTime() - 20 * 86_400_000).toISOString();
    const p = projectMlsRouting({ ...base, listedDate: listed });
    expect(p.dom).toBe(20);
    expect(p.distressPass).toBe(false);
    expect(p.stageCalc).toBe("Rejected: No Distress");
    expect(p.routing).toBe("Reject");
  });

  it("Auto Proceed but no agent phone -> not sendable", () => {
    const listed = new Date(NOW.getTime() - 70 * 86_400_000).toISOString();
    const p = projectMlsRouting({ ...base, listedDate: listed, hasAgentPhone: false });
    expect(p.routing).toBe("Auto Proceed");
    expect(p.autoProceedSendable).toBe(false);
  });

  it("a price drop lowers the DOM needed to clear distress", () => {
    // 2 drops contribute 4.0 to the score on their own -> distressed even fresh.
    const listed = new Date(NOW.getTime() - 5 * 86_400_000).toISOString();
    const p = projectMlsRouting({ ...base, listedDate: listed, priceDrops: 2 });
    expect(p.distressPass).toBe(true);
    expect(p.routing).toBe("Auto Proceed");
  });
});
