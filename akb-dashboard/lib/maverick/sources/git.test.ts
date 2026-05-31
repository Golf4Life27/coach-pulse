// @agent: maverick — git summarizer tests.

import { describe, it, expect } from "vitest";
import { summarizeCommits, buildCommitsUrl } from "./git";

describe("git buildCommitsUrl — branch-truth contract (Spine recwkHvBMTjeMLECp)", () => {
  // The git-source truth bug: ACTIVE_BRANCH defaulted to a now-deleted
  // branch, so /commits?sha=<dead-branch> 404'd → blank git data +
  // branch_resolved:false → behind_head silently null. The fix defaults the
  // sha to `main`. This is the anti-regression guard — revert the default
  // and it fails here. (Tests run with MAVERICK_ACTIVE_BRANCH unset.)
  it("defaults sha to `main` when no branch override is supplied", () => {
    const url = new URL(buildCommitsUrl("2026-05-28T00:00:00.000Z"));
    expect(url.searchParams.get("sha")).toBe("main");
    // The bug was a now-deleted feature branch. Assert it is NOT that.
    expect(url.searchParams.get("sha")).not.toBe("claude/build-akb-inevitable-week1-uG6xD");
  });

  it("carries the since timestamp + per_page, and points at the coach-pulse repo", () => {
    const url = new URL(buildCommitsUrl("2026-05-28T00:00:00.000Z"));
    expect(url.searchParams.get("since")).toBe("2026-05-28T00:00:00.000Z");
    expect(url.searchParams.get("per_page")).toBe("30");
    expect(url.pathname).toBe("/repos/Golf4Life27/coach-pulse/commits");
  });

  it("honors an explicit branch override (the env-driven feature-branch case)", () => {
    const url = new URL(buildCommitsUrl("2026-05-28T00:00:00.000Z", "claude/some-feature"));
    expect(url.searchParams.get("sha")).toBe("claude/some-feature");
  });
});

describe("git summarizeCommits", () => {
  it("maps the GitHub commits response to typed entries with short SHA", () => {
    const r = summarizeCommits("claude/build-akb-inevitable-week1-uG6xD", [
      {
        sha: "a0ea0211b7c234a16b7dca0fb2b35c2ed95a5393",
        commit: {
          message: "feat(d3): widen Layer 1 depth-gate\n\nLong body...",
          author: { name: "Claude", email: "noreply@anthropic.com", date: "2026-05-15T02:37:00Z" },
        },
      },
      {
        sha: "41a2e997cdd9c48ccf5fd126dac09aaf2a79c9b3",
        commit: {
          message: "fix(vercel): relax Path Y cron to daily",
          author: { name: "Claude", date: "2026-05-15T02:20:00Z" },
        },
      },
    ]);
    expect(r.branch).toBe("claude/build-akb-inevitable-week1-uG6xD");
    expect(r.branch_resolved).toBe(true);
    expect(r.commits_since).toHaveLength(2);
    expect(r.commits_since[0]).toMatchObject({
      sha: "a0ea0211b7c234a16b7dca0fb2b35c2ed95a5393",
      short_sha: "a0ea021",
      message: "feat(d3): widen Layer 1 depth-gate",
      author: "Claude",
    });
    expect(r.latest_commit).toEqual(r.commits_since[0]);
  });

  it("collects unique files across all commits when files array is present", () => {
    const r = summarizeCommits("main", [
      {
        sha: "x".repeat(40),
        commit: {
          message: "edit",
          author: { name: "A", date: "2026-05-15T00:00:00Z" },
        },
        files: [{ filename: "lib/foo.ts" }, { filename: "lib/bar.ts" }],
      },
      {
        sha: "y".repeat(40),
        commit: {
          message: "edit",
          author: { name: "A", date: "2026-05-15T01:00:00Z" },
        },
        files: [{ filename: "lib/bar.ts" }, { filename: "lib/baz.ts" }],
      },
    ]);
    expect(r.files_changed_since).toEqual(["lib/bar.ts", "lib/baz.ts", "lib/foo.ts"]);
  });

  it("returns empty-but-resolved state when no commits in the since window", () => {
    const r = summarizeCommits("main", []);
    expect(r).toMatchObject({
      branch: "main",
      branch_resolved: true,
      latest_commit: null,
      commits_since: [],
      files_changed_since: [],
      github_pat_configured: true,
    });
  });

  it("trims commit message to first line only (avoid leaking PR body to briefing)", () => {
    const r = summarizeCommits("main", [
      {
        sha: "z".repeat(40),
        commit: {
          message: "feat: thing\n\nbody line 1\nbody line 2",
          author: { name: "A", date: "2026-05-15T00:00:00Z" },
        },
      },
    ]);
    expect(r.commits_since[0].message).toBe("feat: thing");
  });

  it("falls back to email then '(unknown)' when author name is missing", () => {
    const r = summarizeCommits("main", [
      {
        sha: "a".repeat(40),
        commit: { message: "x", author: { email: "noreply@anthropic.com", date: "2026-05-15T00:00:00Z" } },
      },
      {
        sha: "b".repeat(40),
        commit: { message: "y", author: { date: "2026-05-15T01:00:00Z" } },
      },
    ]);
    expect(r.commits_since[0].author).toBe("noreply@anthropic.com");
    expect(r.commits_since[1].author).toBe("(unknown)");
  });
});
