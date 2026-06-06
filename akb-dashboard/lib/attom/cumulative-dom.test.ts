// @agent: orchestrator — relist-aware DOM resolution tests.
import { describe, it, expect } from "vitest";
import { resolveCumulativeDom } from "./cumulative-dom";

const NOW = new Date("2026-06-06T00:00:00.000Z");

describe("resolveCumulativeDom — provenance ranking + relist flag", () => {
  it("operator_confirmed wins absolutely (the Strathmoor fixture: 87d)", () => {
    const r = resolveCumulativeDom({ operatorConfirmedDom: 87, mlsDomV2: 53, now: NOW });
    expect(r.source).toBe("operator_confirmed");
    expect(r.cumulativeDom).toBe(87);
    expect(r.relistSuspected).toBe(false);
  });

  it("ATTOM Listings wins over mls_dom_v2 when present", () => {
    const r = resolveCumulativeDom({ attomListingsDom: 91, mlsDomV2: 53, now: NOW });
    expect(r.source).toBe("attom_listings");
    expect(r.cumulativeDom).toBe(91);
  });

  it("falls back to mls_dom_v2 with no relist suspicion when nothing else fires", () => {
    const r = resolveCumulativeDom({ mlsDomV2: 30, now: NOW });
    expect(r.source).toBe("mls_dom_v2");
    expect(r.cumulativeDom).toBe(30);
    expect(r.relistSuspected).toBe(false);
  });

  it("flags relist_suspected when multiple intake events exist", () => {
    const r = resolveCumulativeDom({ mlsDomV2: 53, intakeEventCount: 3, now: NOW });
    expect(r.source).toBe("mls_dom_v2");
    expect(r.relistSuspected).toBe(true);
    expect(r.reason).toContain("relist suspected");
  });

  it("flags relist_suspected when the first-list date is much earlier than mls_dom_v2 implies", () => {
    // mls_dom_v2 says 30d; first list date was 120d ago → 4× mismatch → flag.
    const oldListIso = new Date(NOW.getTime() - 120 * 86_400_000).toISOString();
    const r = resolveCumulativeDom({ mlsDomV2: 30, firstListDateIso: oldListIso, now: NOW });
    expect(r.relistSuspected).toBe(true);
  });

  it("returns null + source 'none' when nothing is available", () => {
    const r = resolveCumulativeDom({});
    expect(r.cumulativeDom).toBeNull();
    expect(r.source).toBe("none");
  });

  it("DOM is FLAG-only, never a dispose — result surfaces a number, never a verdict", () => {
    // Posture check: the resolver returns DATA + provenance; the dispose
    // decision lives upstream. We assert no dispose-like fields here.
    const r = resolveCumulativeDom({ mlsDomV2: 900 });
    expect(r).toHaveProperty("cumulativeDom");
    expect(r).toHaveProperty("source");
    expect(r).toHaveProperty("relistSuspected");
    expect(r).not.toHaveProperty("disposed");
    expect(r).not.toHaveProperty("dispose");
  });
});
