// @agent: maverick — System Facts loader tests (A1, 2026-05-31).
//
// The vault is the load-bearing source of truth for every session
// briefing; the loader must read it reliably from both candidate
// cwd layouts (repo root + akb-dashboard subdir) and must NEVER
// throw — read failures populate `error` so the aggregator can
// surface them as a staleness warning without dropping the rest of
// the briefing.

import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadSystemFacts, systemFactsCandidatePaths } from "./system-facts";

describe("systemFactsCandidatePaths", () => {
  it("checks both repo-root and akb-dashboard-subdir paths in order", () => {
    const paths = systemFactsCandidatePaths("/tmp/repo");
    expect(paths).toEqual([
      "/tmp/repo/docs/system/SYSTEM_FACTS.md",
      "/tmp/repo/akb-dashboard/docs/system/SYSTEM_FACTS.md",
    ]);
  });
});

describe("loadSystemFacts", () => {
  it("reads the file verbatim when cwd is the akb-dashboard subdir layout", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "akb-sys-facts-"));
    const subdir = path.join(dir, "akb-dashboard", "docs", "system");
    await mkdir(subdir, { recursive: true });
    const body = "# System Facts\n\nVercel plan: Pro\n";
    await writeFile(path.join(subdir, "SYSTEM_FACTS.md"), body, "utf-8");

    const result = await loadSystemFacts(dir);
    expect(result.error).toBeNull();
    expect(result.markdown).toBe(body);
  });

  it("reads the file when cwd is the dashboard directory itself", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "akb-sys-facts-cwd-"));
    const subdir = path.join(dir, "docs", "system");
    await mkdir(subdir, { recursive: true });
    const body = "Vercel team: team_zwFAlAQ8CyjGYcxyk7Sn6ww0\n";
    await writeFile(path.join(subdir, "SYSTEM_FACTS.md"), body, "utf-8");

    const result = await loadSystemFacts(dir);
    expect(result.markdown).toBe(body);
  });

  it("returns error (not throw) when the file is missing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "akb-sys-facts-missing-"));
    const result = await loadSystemFacts(dir);
    expect(result.markdown).toBeNull();
    expect(result.error).toMatch(/SYSTEM_FACTS\.md not found/);
  });

  it("default cwd reads the real vault file shipped with the repo", async () => {
    // Smoke: when run from the dashboard's own cwd (vitest's default),
    // the loader resolves the committed file. Guards against accidental
    // deletion / rename of the vault.
    const result = await loadSystemFacts();
    expect(result.error).toBeNull();
    expect(result.markdown).toContain("# System Facts");
    // Anchored fact — settling this was the whole point of A1.
    expect(result.markdown).toContain("Pro");
  });
});
