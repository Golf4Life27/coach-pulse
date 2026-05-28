// @agent: maverick — external-vercel summarizer tests.

import { describe, it, expect } from "vitest";
import { summarizeDeployment, buildProductionDeploymentsUrl } from "./external-vercel";

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
      production_deploy_id: "dpl_test123",
      production_deploy_state: "READY",
      production_deploy_sha: "a0ea0211b7c234a16b7dca0fb2b35c2ed95a5393",
      production_deploy_short_sha: "a0ea021",
      production_deploy_branch: "claude/build-akb-inevitable-week1-uG6xD",
    });
    expect(r.production_deploy_ready_at).toMatch(/^2026-05-15T02:38:/);
  });

  it("returns UNKNOWN state for unrecognized status strings", () => {
    const r = summarizeDeployment({ uid: "dpl_x", state: "MYSTERY_STATE" });
    expect(r.production_deploy_state).toBe("UNKNOWN");
  });

  it("normalizes case for known states (BUILDING/Ready/canceled etc.)", () => {
    const states = ["READY", "BUILDING", "ERROR", "CANCELED", "QUEUED", "INITIALIZING"] as const;
    for (const s of states) {
      const r = summarizeDeployment({ uid: "x", state: s.toLowerCase() });
      expect(r.production_deploy_state).toBe(s);
    }
  });

  it("returns the empty-but-api-configured shape when no deployment exists", () => {
    const r = summarizeDeployment(undefined);
    expect(r).toMatchObject({
      api_token_configured: true,
      production_deploy_id: null,
      production_deploy_state: "UNKNOWN",
      production_deploy_sha: null,
      production_deploy_short_sha: null,
    });
  });

  it("handles missing meta gracefully", () => {
    const r = summarizeDeployment({ uid: "dpl_x", state: "READY" });
    expect(r.production_deploy_sha).toBeNull();
    expect(r.production_deploy_branch).toBeNull();
  });
});

describe("external-vercel production query contract (Spine recwkHvBMTjeMLECp)", () => {
  // The deploy-truth bug: the fetcher asked Vercel for the newest deploy
  // of ANY target (target="" limit=1, take [0]) and the briefing then
  // rendered it under the literal word "Production." When the newest push
  // was a PR preview, the preview's SHA printed as production. The cure is
  // entirely in WHAT WE ASK: target=production & state=READY. Selection is
  // now server-side, so this query-contract test is the anti-regression
  // guard — revert the params and it fails here, loudly.
  it("queries target=production & state=READY & limit=1 — never any-target recency", () => {
    const url = new URL(buildProductionDeploymentsUrl());
    expect(url.searchParams.get("target")).toBe("production");
    expect(url.searchParams.get("state")).toBe("READY");
    expect(url.searchParams.get("limit")).toBe("1");
    // The bug was target="" (any target). Assert it is NOT that.
    expect(url.searchParams.get("target")).not.toBe("");
  });

  it("carries project + team scoping", () => {
    const url = new URL(buildProductionDeploymentsUrl("prj_abc", "team_xyz"));
    expect(url.searchParams.get("projectId")).toBe("prj_abc");
    expect(url.searchParams.get("teamId")).toBe("team_xyz");
  });

  // Regression fixture mirroring the launch-morning incident. The real
  // production deploy was 468d5f3 (target=production READY, branch main);
  // the newest deploy overall was 684fba4 (a PR-#16 preview, target=null).
  // Because the query now constrains to target=production READY, Vercel
  // returns the prod deploy and summarizeDeployment surfaces 468d5f3 — the
  // preview SHA can no longer reach the "Production deploy" line.
  it("summarizes the real production deploy (468d5f3), not the newer preview (684fba4)", () => {
    const prod = summarizeDeployment({
      uid: "dpl_4JtqYRbCSrLCedrb85GVHLea8jrb",
      url: "coach-pulse.vercel.app",
      state: "READY",
      ready: Date.UTC(2026, 4, 27, 1, 0, 0),
      created: Date.UTC(2026, 4, 27, 0, 58, 0),
      meta: {
        githubCommitSha: "468d5f3aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        githubCommitRef: "main",
      },
    });
    expect(prod.production_deploy_short_sha).toBe("468d5f3");
    expect(prod.production_deploy_branch).toBe("main");
    expect(prod.production_deploy_state).toBe("READY");
    // The preview SHA must never be what we report as production.
    expect(prod.production_deploy_short_sha).not.toBe("684fba4");
  });
});
