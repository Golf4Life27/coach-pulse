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
// Active build branch — overridable via env for future Maverick
// branches (e.g., claude/maverick-aggregator).
const ACTIVE_BRANCH = process.env.MAVERICK_ACTIVE_BRANCH || "claude/build-akb-inevitable-week1-uG6xD";

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

      const commitsUrl = new URL(
        `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/commits`,
      );
      commitsUrl.searchParams.set("sha", ACTIVE_BRANCH);
      commitsUrl.searchParams.set("since", sinceIso);
      commitsUrl.searchParams.set("per_page", "30");

      const res = await fetch(commitsUrl.toString(), {
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
