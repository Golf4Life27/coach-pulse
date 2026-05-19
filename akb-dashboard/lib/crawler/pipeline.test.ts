// Phase 13.3 + 13.5 + 13.6 / Q.7 — Crawler pipeline tests.

import { describe, it, expect } from "vitest";
import { classifyCandidate, runCrawlerScan } from "./pipeline";
import type { CrawlerCandidate } from "./types";

function mkCandidate(over: Partial<CrawlerCandidate> = {}): CrawlerCandidate {
  return {
    source_id: "test-1",
    source: "propstream",
    address: "100 Test Ln",
    city: "San Antonio",
    state: "TX",
    zip: "78210",
    list_price: 150_000,
    body: "Motivated seller, vacant property.",
    agent_name: "Jane Smith",
    agent_phone: "(210) 555-0100",
    agent_email: "jane@example.com",
    emitted_at: "2026-05-19T03:00:00Z",
    ...over,
  };
}

describe("classifyCandidate", () => {
  it("clean candidate → gate_action pass", () => {
    const r = classifyCandidate(mkCandidate());
    expect(r.gate_action).toBe("pass");
  });

  it("off-market body language → manual_review", () => {
    const r = classifyCandidate(
      mkCandidate({ body: "This property is under contract." }),
    );
    expect(r.gate_action).toBe("manual_review");
  });

  it("flip-keyword reject body → reject", () => {
    const r = classifyCandidate(
      mkCandidate({
        body: "Brand new completely remodeled turnkey move-in ready granite quartz stainless custom upgraded",
      }),
    );
    expect(r.gate_action).toBe("reject");
  });

  it("invalid agent phone → manual_review", () => {
    const r = classifyCandidate(
      mkCandidate({ agent_phone: "call the office" }),
    );
    expect(r.gate_action).toBe("manual_review");
  });
});

describe("runCrawlerScan (default sources, uncredentialed)", () => {
  it("returns empty candidates + per-source health markers", async () => {
    const r = await runCrawlerScan();
    expect(r.total_candidates).toBe(0);
    expect(r.classified).toEqual([]);
    expect(r.source_scans.length).toBe(4);
    for (const s of r.source_scans) {
      expect(["uncredentialed", "degraded"]).toContain(s.source_health);
    }
  });

  it("filters to requested sources", async () => {
    const r = await runCrawlerScan({ sources: ["propstream"] });
    expect(r.source_scans.length).toBe(1);
    expect(r.source_scans[0].source).toBe("propstream");
  });

  it("ignores unknown source names", async () => {
    // Bypass type system to test runtime defensiveness.
    const r = await runCrawlerScan({
      sources: ["nonexistent" as unknown as "propstream"],
    });
    expect(r.source_scans.length).toBe(0);
  });

  it("action_counts initialized at zero when no candidates", async () => {
    const r = await runCrawlerScan({ sources: ["propstream"] });
    expect(r.action_counts).toEqual({ pass: 0, manual_review: 0, reject: 0 });
  });
});
