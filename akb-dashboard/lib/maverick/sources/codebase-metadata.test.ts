// @agent: maverick — codebase-metadata composer tests.

import { describe, it, expect } from "vitest";
import { composeMetadata } from "./codebase-metadata";

describe("codebase-metadata composeMetadata", () => {
  it("merges package + CI state into the shared shape", () => {
    const r = composeMetadata(
      { name: "akb-dashboard", version: "0.1.0" },
      { state: "passing", sha: "abcdef1234" },
    );
    expect(r).toMatchObject({
      package_name: "akb-dashboard",
      package_version: "0.1.0",
      latest_ci_state: "passing",
      latest_ci_sha: "abcdef1234",
    });
    expect(r.test_count).toBeNull();
    expect(r.test_count_source).toBe("unknown");
  });

  it("returns 'unknown' CI state when ci probe returned null (e.g., no GITHUB_PAT)", () => {
    const r = composeMetadata({ name: "x", version: "1.0.0" }, null);
    expect(r.latest_ci_state).toBe("unknown");
    expect(r.latest_ci_sha).toBeNull();
  });

  it("returns null package fields when readPackageInfo couldn't resolve the file", () => {
    const r = composeMetadata(null, null);
    expect(r.package_name).toBeNull();
    expect(r.package_version).toBeNull();
  });

  it("reflects github_pat_configured flag from env state", () => {
    // The flag is read at module init; just assert the field exists
    // and is boolean. Per-env-state assertion lives in integration
    // tests once Day 2 lands.
    const r = composeMetadata(null, null);
    expect(typeof r.github_pat_configured).toBe("boolean");
  });

  it("reports test_count from the prebuild artifact when present", () => {
    const r = composeMetadata(null, null, {
      count: 101,
      test_files: 13,
      generated_at: "2026-05-15T05:00:00Z",
    });
    expect(r.test_count).toBe(101);
    expect(r.test_count_source).toBe("prebuild_artifact");
  });

  it("reports test_count as null / 'unknown' when artifact is absent (graceful degrade)", () => {
    const r = composeMetadata(null, null, null);
    expect(r.test_count).toBeNull();
    expect(r.test_count_source).toBe("unknown");
  });
});
