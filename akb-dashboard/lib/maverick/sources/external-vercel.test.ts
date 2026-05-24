// @agent: maverick — external-vercel summarizer tests.

import { describe, it, expect } from "vitest";
import { summarizeDeployment } from "./external-vercel";

describe("external-vercel summarizeDeployment", () => {
  it("extracts SHA + branch + state + timestamps from a deploy record", () => {
    const r = summarizeDeployment({
      uid: "dpl_test123",
      url: "coach-pulse-test.vercel.app",
      state: "READY",
      ready: Date.UTC(2026, 4, 15, 2, 38, 6),
      created: Date.UTC(2026, 4, 15, 2, 37, 33),
      meta: {
        githubCommitSha: "a0ea0211b7c234a16b7dca0fb2b35c2ed95a5393",
        githubCommitRef: "claude/build-akb-inevitable-week1-uG6xD",
      },
    });
    expect(r).toMatchObject({
      api_token_configured: true,
      latest_deploy_id: "dpl_test123",
      latest_deploy_state: "READY",
      latest_deploy_sha: "a0ea0211b7c234a16b7dca0fb2b35c2ed95a5393",
      latest_deploy_short_sha: "a0ea021",
      latest_deploy_branch: "claude/build-akb-inevitable-week1-uG6xD",
    });
    expect(r.latest_deploy_ready_at).toMatch(/^2026-05-15T02:38:/);
  });

  it("returns UNKNOWN state for unrecognized status strings", () => {
    const r = summarizeDeployment({ uid: "dpl_x", state: "MYSTERY_STATE" });
    expect(r.latest_deploy_state).toBe("UNKNOWN");
  });

  it("normalizes case for known states (BUILDING/Ready/canceled etc.)", () => {
    const states = ["READY", "BUILDING", "ERROR", "CANCELED", "QUEUED", "INITIALIZING"] as const;
    for (const s of states) {
      const r = summarizeDeployment({ uid: "x", state: s.toLowerCase() });
      expect(r.latest_deploy_state).toBe(s);
    }
  });

  it("returns the empty-but-api-configured shape when no deployment exists", () => {
    const r = summarizeDeployment(undefined);
    expect(r).toMatchObject({
      api_token_configured: true,
      latest_deploy_id: null,
      latest_deploy_state: "UNKNOWN",
      latest_deploy_sha: null,
      latest_deploy_short_sha: null,
    });
  });

  it("handles missing meta gracefully", () => {
    const r = summarizeDeployment({ uid: "dpl_x", state: "READY" });
    expect(r.latest_deploy_sha).toBeNull();
    expect(r.latest_deploy_branch).toBeNull();
  });
});
