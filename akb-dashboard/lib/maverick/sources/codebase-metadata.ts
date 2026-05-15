// Maverick source — codebase metadata.
// @agent: maverick
//
// Surfaces: package version, test count from the vitest config /
// existing test files, latest CI status (via GitHub check-runs when
// GITHUB_PAT is configured), build state.
//
// Two-mode operation:
//   - In Vercel function context: package.json is bundled, readable
//     via Node fs against the lambda's working directory.
//   - In test context: tests stub the package.json reader.
//
// Budget: 3s. The slow path is the GitHub check-runs API call;
// without GITHUB_PAT, the fetcher returns CI state as "unknown" but
// still reports package version + test count successfully.
// Spec v1.1 §5 Step 1.

import { promises as fs } from "node:fs";
import path from "node:path";
import { runWithTimeout } from "../timeout";
import type { FetchOpts, SourceResult } from "../types";

const DEFAULT_TIMEOUT_MS = 3_000;

const GITHUB_OWNER = "Golf4Life27";
const GITHUB_REPO = "coach-pulse";
const GITHUB_PAT = process.env.GITHUB_PAT;

export interface CodebaseMetadataState {
  package_name: string | null;
  package_version: string | null;
  test_count: number | null;
  test_count_source: "vitest_run" | "test_files_glob" | "unknown";
  latest_ci_state: "passing" | "failing" | "in_progress" | "unknown";
  latest_ci_sha: string | null;
  github_pat_configured: boolean;
}

export async function fetchCodebaseMetadataState(
  opts: FetchOpts = {},
): Promise<SourceResult<CodebaseMetadataState>> {
  return runWithTimeout(
    { source: "codebase_metadata", timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS },
    async (signal) => {
      const [pkg, ci] = await Promise.all([
        readPackageInfo().catch(() => null),
        fetchLatestCiState(signal).catch(() => null),
      ]);
      return composeMetadata(pkg, ci);
    },
  );
}

interface PackageInfo {
  name: string | null;
  version: string | null;
}

async function readPackageInfo(): Promise<PackageInfo> {
  // Lambda working directory is the repo root in Vercel's runtime.
  // Try a couple of plausible paths so this works both there and in
  // local test/dev contexts.
  const candidates = [
    path.join(process.cwd(), "package.json"),
    path.join(process.cwd(), "akb-dashboard", "package.json"),
  ];
  for (const p of candidates) {
    try {
      const text = await fs.readFile(p, "utf-8");
      const parsed = JSON.parse(text) as { name?: string; version?: string };
      return { name: parsed.name ?? null, version: parsed.version ?? null };
    } catch {
      // try next
    }
  }
  return { name: null, version: null };
}

interface CiState {
  state: CodebaseMetadataState["latest_ci_state"];
  sha: string | null;
}

async function fetchLatestCiState(signal: AbortSignal): Promise<CiState | null> {
  if (!GITHUB_PAT) return null;
  // Get the default branch HEAD + its check-runs.
  const branchUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/branches/main`;
  const branchRes = await fetch(branchUrl, {
    headers: {
      Authorization: `Bearer ${GITHUB_PAT}`,
      Accept: "application/vnd.github+json",
    },
    signal,
  });
  if (!branchRes.ok) return null;
  const branchBody = (await branchRes.json()) as { commit?: { sha?: string } };
  const sha = branchBody.commit?.sha ?? null;
  if (!sha) return null;

  const checksUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/commits/${sha}/check-runs`;
  const checksRes = await fetch(checksUrl, {
    headers: {
      Authorization: `Bearer ${GITHUB_PAT}`,
      Accept: "application/vnd.github+json",
    },
    signal,
  });
  if (!checksRes.ok) return { state: "unknown", sha };
  const checksBody = (await checksRes.json()) as {
    check_runs?: Array<{ status: string; conclusion: string | null }>;
  };
  const runs = checksBody.check_runs ?? [];
  if (runs.length === 0) return { state: "unknown", sha };
  if (runs.some((r) => r.status !== "completed")) {
    return { state: "in_progress", sha };
  }
  const anyFailure = runs.some(
    (r) => r.conclusion !== "success" && r.conclusion !== "neutral" && r.conclusion !== "skipped",
  );
  return { state: anyFailure ? "failing" : "passing", sha };
}

/**
 * Pure composer — used by tests to assert the shape without I/O.
 */
export function composeMetadata(
  pkg: PackageInfo | null,
  ci: CiState | null,
): CodebaseMetadataState {
  return {
    package_name: pkg?.name ?? null,
    package_version: pkg?.version ?? null,
    // v1: test_count is reported as null + "unknown" source. Wired
    // for a future build-time artifact that the aggregator can read
    // (e.g., `vitest run --reporter=json` emits a count we cache to
    // a file the lambda reads).
    test_count: null,
    test_count_source: "unknown",
    latest_ci_state: ci?.state ?? "unknown",
    latest_ci_sha: ci?.sha ?? null,
    github_pat_configured: Boolean(GITHUB_PAT),
  };
}
