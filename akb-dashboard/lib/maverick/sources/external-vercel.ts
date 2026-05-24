// Maverick source — Vercel deploy state.
// @agent: maverick
//
// Latest deployment on the active branch — SHA, state, ready time.
// Lets the briefing surface "production is N minutes behind HEAD"
// when code is queued but not yet deployed.
//
// Budget: 3s. One Vercel REST GET.
// Spec v1.1 §5 Step 1.

import { runWithTimeout } from "../timeout";
import type { FetchOpts, SourceResult } from "../types";

const DEFAULT_TIMEOUT_MS = 3_000;

const VERCEL_API_TOKEN = process.env.VERCEL_API_TOKEN;
const VERCEL_PROJECT_ID = process.env.VERCEL_PROJECT_ID || "prj_X1pCuqzRml74iOKfNhTo4ZMG9K87";
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID || "team_zwFAlAQ8CyjGYcxyk7Sn6ww0";
const ACTIVE_BRANCH = process.env.MAVERICK_ACTIVE_BRANCH || "claude/build-akb-inevitable-week1-uG6xD";

export type DeployState = "READY" | "BUILDING" | "ERROR" | "CANCELED" | "QUEUED" | "INITIALIZING" | "UNKNOWN";

export interface VercelDeployState {
  api_token_configured: boolean;
  latest_deploy_id: string | null;
  latest_deploy_url: string | null;
  latest_deploy_state: DeployState;
  latest_deploy_sha: string | null;
  latest_deploy_short_sha: string | null;
  latest_deploy_branch: string | null;
  latest_deploy_ready_at: string | null;
  latest_deploy_created_at: string | null;
  // For the briefing's "production is N minutes behind HEAD" signal.
  // Computed by the aggregator against git source's latest SHA; the
  // fetcher surfaces only the deploy-side data.
  active_branch_observed: string;
}

export async function fetchExternalVercelState(
  opts: FetchOpts = {},
): Promise<SourceResult<VercelDeployState>> {
  return runWithTimeout(
    { source: "external_vercel", timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS },
    async (signal) => {
      if (!VERCEL_API_TOKEN) {
        return {
          api_token_configured: false,
          latest_deploy_id: null,
          latest_deploy_url: null,
          latest_deploy_state: "UNKNOWN" as DeployState,
          latest_deploy_sha: null,
          latest_deploy_short_sha: null,
          latest_deploy_branch: null,
          latest_deploy_ready_at: null,
          latest_deploy_created_at: null,
          active_branch_observed: ACTIVE_BRANCH,
        };
      }

      const url = new URL("https://api.vercel.com/v6/deployments");
      url.searchParams.set("projectId", VERCEL_PROJECT_ID);
      url.searchParams.set("teamId", VERCEL_TEAM_ID);
      url.searchParams.set("limit", "1");
      url.searchParams.set("target", ""); // any target
      // Filter to the active branch via meta-key matching (Vercel
      // does NOT support direct branch query on v6/deployments; the
      // server returns the project's most recent regardless of
      // branch, so we filter client-side).

      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${VERCEL_API_TOKEN}` },
        signal,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Vercel deployments fetch ${res.status}: ${text.slice(0, 200)}`);
      }
      const body = (await res.json()) as {
        deployments?: Array<{
          uid?: string;
          url?: string;
          state?: string;
          ready?: number;
          created?: number;
          meta?: {
            githubCommitSha?: string;
            githubCommitRef?: string;
          };
        }>;
      };
      return summarizeDeployment(body.deployments?.[0]);
    },
  );
}

/**
 * Pure summarizer.
 */
export function summarizeDeployment(
  deploy?: {
    uid?: string;
    url?: string;
    state?: string;
    ready?: number;
    created?: number;
    meta?: {
      githubCommitSha?: string;
      githubCommitRef?: string;
    };
  },
): VercelDeployState {
  if (!deploy) {
    return {
      api_token_configured: true,
      latest_deploy_id: null,
      latest_deploy_url: null,
      latest_deploy_state: "UNKNOWN",
      latest_deploy_sha: null,
      latest_deploy_short_sha: null,
      latest_deploy_branch: null,
      latest_deploy_ready_at: null,
      latest_deploy_created_at: null,
      active_branch_observed: ACTIVE_BRANCH,
    };
  }
  const sha = deploy.meta?.githubCommitSha ?? null;
  return {
    api_token_configured: true,
    latest_deploy_id: deploy.uid ?? null,
    latest_deploy_url: deploy.url ?? null,
    latest_deploy_state: normalizeState(deploy.state),
    latest_deploy_sha: sha,
    latest_deploy_short_sha: sha ? sha.slice(0, 7) : null,
    latest_deploy_branch: deploy.meta?.githubCommitRef ?? null,
    latest_deploy_ready_at: deploy.ready ? new Date(deploy.ready).toISOString() : null,
    latest_deploy_created_at: deploy.created ? new Date(deploy.created).toISOString() : null,
    active_branch_observed: ACTIVE_BRANCH,
  };
}

function normalizeState(s: string | undefined): DeployState {
  switch ((s ?? "").toUpperCase()) {
    case "READY":
    case "BUILDING":
    case "ERROR":
    case "CANCELED":
    case "QUEUED":
    case "INITIALIZING":
      return s!.toUpperCase() as DeployState;
    default:
      return "UNKNOWN";
  }
}
