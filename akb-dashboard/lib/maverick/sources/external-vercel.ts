// Maverick source — Vercel PRODUCTION deploy state.
// @agent: maverick
//
// What is *actually serving production* — SHA, state, ready time —
// queried by target, never by recency. Lets the briefing surface
// "production is N commits behind HEAD" when code is merged to main
// but not yet live.
//
// HISTORY (Spine recwkHvBMTjeMLECp): this previously queried
// `target=""` (any target) limit=1 and took [0] — the single most
// recent deployment of ANY branch/target. When the newest push was a
// PR preview, that preview leaked into the briefing under the literal
// label "Production deploy" (template.ts). The fix asks Vercel the
// right question: target=production & state=READY. The old code also
// carried a comment claiming a client-side branch filter that was
// never implemented; it is gone.
//
// Budget: 3s. One Vercel REST GET.
// Spec v1.1 §5 Step 1.

import { runWithTimeout } from "../timeout";
import type { FetchOpts, SourceResult } from "../types";

const DEFAULT_TIMEOUT_MS = 3_000;

const VERCEL_API_TOKEN = process.env.VERCEL_API_TOKEN;
const VERCEL_PROJECT_ID = process.env.VERCEL_PROJECT_ID || "prj_X1pCuqzRml74iOKfNhTo4ZMG9K87";
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID || "team_zwFAlAQ8CyjGYcxyk7Sn6ww0";
// Production is served from main. Surfaced via the (currently unread)
// active_branch_observed field only — the production query below is by
// target, not branch, so this no longer gates selection.
const ACTIVE_BRANCH = process.env.MAVERICK_ACTIVE_BRANCH || "main";

export type DeployState = "READY" | "BUILDING" | "ERROR" | "CANCELED" | "QUEUED" | "INITIALIZING" | "UNKNOWN";

export interface VercelDeployState {
  api_token_configured: boolean;
  production_deploy_id: string | null;
  production_deploy_url: string | null;
  production_deploy_state: DeployState;
  production_deploy_sha: string | null;
  production_deploy_short_sha: string | null;
  production_deploy_branch: string | null;
  production_deploy_ready_at: string | null;
  production_deploy_created_at: string | null;
  // For the briefing's "production is N behind HEAD" signal.
  // Computed by the aggregator against git source's latest SHA; the
  // fetcher surfaces only the deploy-side data.
  active_branch_observed: string;
}

/**
 * Pure: build the Vercel deployments query URL for the CURRENT
 * production deployment. The `target=production` + `state=READY`
 * constraint is the heart of the deploy-truth fix — it makes Vercel
 * return only live production deploys, so [0] can never be a preview.
 * Exported so the contract is unit-tested without network or env.
 */
export function buildProductionDeploymentsUrl(
  projectId: string = VERCEL_PROJECT_ID,
  teamId: string = VERCEL_TEAM_ID,
): string {
  const url = new URL("https://api.vercel.com/v6/deployments");
  url.searchParams.set("projectId", projectId);
  url.searchParams.set("teamId", teamId);
  url.searchParams.set("limit", "1");
  url.searchParams.set("target", "production");
  url.searchParams.set("state", "READY");
  return url.toString();
}

function emptyState(apiConfigured: boolean): VercelDeployState {
  return {
    api_token_configured: apiConfigured,
    production_deploy_id: null,
    production_deploy_url: null,
    production_deploy_state: "UNKNOWN",
    production_deploy_sha: null,
    production_deploy_short_sha: null,
    production_deploy_branch: null,
    production_deploy_ready_at: null,
    production_deploy_created_at: null,
    active_branch_observed: ACTIVE_BRANCH,
  };
}

export async function fetchExternalVercelState(
  opts: FetchOpts = {},
): Promise<SourceResult<VercelDeployState>> {
  return runWithTimeout(
    { source: "external_vercel", timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS },
    async (signal) => {
      if (!VERCEL_API_TOKEN) {
        return emptyState(false);
      }

      const res = await fetch(buildProductionDeploymentsUrl(), {
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
 * Pure summarizer. Maps a single Vercel deployment record (already
 * constrained to target=production READY by the query) into the
 * production-deploy state surfaced to the briefing.
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
    return emptyState(true);
  }
  const sha = deploy.meta?.githubCommitSha ?? null;
  return {
    api_token_configured: true,
    production_deploy_id: deploy.uid ?? null,
    production_deploy_url: deploy.url ?? null,
    production_deploy_state: normalizeState(deploy.state),
    production_deploy_sha: sha,
    production_deploy_short_sha: sha ? sha.slice(0, 7) : null,
    production_deploy_branch: deploy.meta?.githubCommitRef ?? null,
    production_deploy_ready_at: deploy.ready ? new Date(deploy.ready).toISOString() : null,
    production_deploy_created_at: deploy.created ? new Date(deploy.created).toISOString() : null,
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
