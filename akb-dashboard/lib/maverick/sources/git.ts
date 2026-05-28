// Maverick source — Git state.
// @agent: maverick
//
// Reports the working branch + recent commits + files-changed digest.
// Source: GitHub REST API (server-side; can't use the GitHub MCP from
// a Vercel function). Requires GITHUB_PAT.
//
// Budget: 5s. Two API calls in parallel (branch HEAD + commits since).
// Spec v1.1 §5 Step 1.

import { runWithTimeout } from "../timeout";
import type { FetchOpts, SourceResult } from "../types";

const DEFAULT_TIMEOUT_MS = 5_000;

const GITHUB_OWNER = "Golf4Life27";
const GITHUB_REPO = "coach-pulse";
const GITHUB_PAT = process.env.GITHUB_PAT;
// Branch whose commits Maverick reports as "the build." Defaults to `main`
// — the canonical/production branch — overridable via env for a Maverick
// session working a feature branch.
//
// HISTORY (Spine recwkHvBMTjeMLECp, sibling of the external-vercel deploy-
// truth fix): this defaulted to `claude/build-akb-inevitable-week1-uG6xD`,
// which has since been deleted from origin. Absent the env override, the
// /commits?sha=<dead-branch> call 404s → blank git data + branch_resolved
// false → behind_head silently null. MAVERICK_ACTIVE_BRANCH=main was set in
// prod as interim mitigation; defaulting to `main` removes the dependency
// on that env being present.
const ACTIVE_BRANCH = process.env.MAVERICK_ACTIVE_BRANCH || "main";

/**
 * Pure: build the GitHub /commits query URL for the active branch since a
 * timestamp. The `sha=<branch>` param is what selects the branch — a dead
 * default here is exactly what silently blanked git data (see HISTORY
 * above). Exported so the contract (sha defaults to `main`) is unit-tested
 * without network or env, mirroring external-vercel's buildProductionDeploymentsUrl.
 */
export function buildCommitsUrl(
  sinceIso: string,
  branch: string = ACTIVE_BRANCH,
  owner: string = GITHUB_OWNER,
  repo: string = GITHUB_REPO,
): string {
  const url = new URL(`https://api.github.com/repos/${owner}/${repo}/commits`);
  url.searchParams.set("sha", branch);
  url.searchParams.set("since", sinceIso);
  url.searchParams.set("per_page", "30");
  return url.toString();
}

export interface GitCommit {
  sha: string;
  short_sha: string;
  message: string; // first line only
  author: string;
  date: string;
}

export interface GitState {
  branch: string;
  branch_resolved: boolean; // true if the branch exists on origin
  latest_commit: GitCommit | null;
  commits_since: GitCommit[];
  files_changed_since: string[];
  github_pat_configured: boolean;
}

export async function fetchGitState(
  opts: FetchOpts = {},
): Promise<SourceResult<GitState>> {
  return runWithTimeout(
    { source: "git", timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS },
    async (signal) => {
      if (!GITHUB_PAT) {
        return {
          branch: ACTIVE_BRANCH,
          branch_resolved: false,
          latest_commit: null,
          commits_since: [],
          files_changed_since: [],
          github_pat_configured: false,
        };
      }
      const since = opts.since ?? new Date(Date.now() - 24 * 60 * 60_000);
      const sinceIso = since.toISOString();

      const res = await fetch(buildCommitsUrl(sinceIso), {
        headers: {
          Authorization: `Bearer ${GITHUB_PAT}`,
          Accept: "application/vnd.github+json",
        },
        signal,
      });

      if (res.status === 404) {
        return {
          branch: ACTIVE_BRANCH,
          branch_resolved: false,
          latest_commit: null,
          commits_since: [],
          files_changed_since: [],
          github_pat_configured: true,
        };
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`GitHub commits fetch ${res.status}: ${text.slice(0, 200)}`);
      }

      const body = (await res.json()) as Array<{
        sha: string;
        commit: {
          message: string;
          author: { name?: string; email?: string; date?: string };
        };
        files?: Array<{ filename: string }>;
      }>;

      return summarizeCommits(ACTIVE_BRANCH, body);
    },
  );
}

/**
 * Pure summarizer — accepts the GitHub /commits response body shape
 * and produces the GitState. Note: the GitHub /commits endpoint does
 * NOT include the `files` array by default; for files-changed-since
 * we use the commit SHAs returned here and call a separate
 * /compare endpoint upstream when latency budget allows. v1 ships
 * with files_changed_since[] derived only when individual commits
 * came back with files (which they don't from /commits; this is a
 * known v1.1 enhancement target).
 */
export function summarizeCommits(
  branch: string,
  commits: Array<{
    sha: string;
    commit: {
      message: string;
      author: { name?: string; email?: string; date?: string };
    };
    files?: Array<{ filename: string }>;
  }>,
): GitState {
  if (commits.length === 0) {
    return {
      branch,
      branch_resolved: true,
      latest_commit: null,
      commits_since: [],
      files_changed_since: [],
      github_pat_configured: true,
    };
  }

  const mapped: GitCommit[] = commits.map((c) => ({
    sha: c.sha,
    short_sha: c.sha.slice(0, 7),
    message: (c.commit.message ?? "").split("\n", 1)[0],
    author: c.commit.author?.name ?? c.commit.author?.email ?? "(unknown)",
    date: c.commit.author?.date ?? "",
  }));

  const filesChanged = new Set<string>();
  for (const c of commits) {
    for (const f of c.files ?? []) {
      filesChanged.add(f.filename);
    }
  }

  return {
    branch,
    branch_resolved: true,
    latest_commit: mapped[0],
    commits_since: mapped,
    files_changed_since: [...filesChanged].sort(),
    github_pat_configured: true,
  };
}
