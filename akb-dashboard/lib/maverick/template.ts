// Maverick — pure-template narrative renderer.
// @agent: maverick (Day 2)
//
// Deterministic Markdown rendering of a StructuredBriefing. ~50ms
// target; pure string concatenation, no expensive formatting. Used
// in two places:
//   1. As the FALLBACK narrative when the Claude synthesizer
//      exceeds its 12s budget or errors out.
//   2. As the BASELINE narrative that the Claude synthesizer
//      paraphrases into the Owner's Rep voice (so the synthesizer
//      can never substitute for the deterministic facts).
//
// Pure function. No I/O. No side effects.

import type { StructuredBriefing } from "./briefing";

/**
 * Render the structured briefing into a Markdown narrative.
 */
export function renderTemplate(b: StructuredBriefing): string {
  const sections: string[] = [];

  // Opening — anchored on the since-window so Claude or the reader
  // knows the time scope.
  const hoursSince = hoursAgoOf(b.since, b.generated_at);
  sections.push(
    `Welcome back. Last session window: last ${hoursSince}h (since ${b.since.slice(0, 16).replace("T", " ")}Z).`,
  );

  // CURRENT BUILD STATE
  const bs = b.build_state;
  const buildLines = [
    "## CURRENT BUILD STATE",
    `  Branch: ${bs.branch}`,
  ];
  if (bs.latest_commit) {
    buildLines.push(
      `  Latest commit: ${bs.latest_commit.short_sha} — ${truncate(bs.latest_commit.message, 80)}`,
    );
  } else {
    buildLines.push(`  Latest commit: (none in window)`);
  }
  if (bs.commits_since_count > 0) {
    buildLines.push(`  Commits since window start: ${bs.commits_since_count}`);
  }
  if (bs.tests.count != null) {
    buildLines.push(
      `  Tests: ${bs.tests.count} in suite — CI ${bs.tests.ci_state}`,
    );
  } else {
    buildLines.push(`  Tests: (count unavailable) — CI ${bs.tests.ci_state}`);
  }
  if (bs.deploy.id) {
    const deployLine = `  Production deploy: ${bs.deploy.state}${bs.deploy.short_sha ? ` (${bs.deploy.short_sha})` : ""}${bs.deploy.behind_head === true ? " — BEHIND HEAD" : ""}`;
    buildLines.push(deployLine);
  } else {
    buildLines.push(`  Production deploy: (unknown)`);
  }
  sections.push(buildLines.join("\n"));

  // ACTIVE DEALS
  if (b.active_deals.length === 0) {
    sections.push(`## ACTIVE DEALS (0)\n  (no active negotiations)`);
  } else {
    const lines = [`## ACTIVE DEALS (${b.active_deals.length})`];
    for (const d of b.active_deals.slice(0, 10)) {
      const price = d.stored_offer_price != null ? `$${d.stored_offer_price.toLocaleString()}` : "(no offer)";
      const lastTouch =
        d.days_since_inbound != null
          ? `last inbound ${d.days_since_inbound}d ago`
          : d.days_since_send != null
            ? `last send ${d.days_since_send}d ago`
            : "no activity";
      lines.push(
        `  ${d.address}${d.city ? `, ${d.city}` : ""} — ${d.status} at ${price}. ${lastTouch}.`,
      );
    }
    if (b.active_deals.length > 10) {
      lines.push(`  ... ${b.active_deals.length - 10} more`);
    }
    sections.push(lines.join("\n"));
  }

  // PIPELINE SNAPSHOT
  const pipelineEntries = Object.entries(b.pipeline_counts)
    .filter(([, count]) => count > 0)
    .sort((a, b2) => b2[1] - a[1]);
  if (pipelineEntries.length > 0) {
    sections.push(
      `## PIPELINE SNAPSHOT\n${pipelineEntries.map(([s, c]) => `  ${s}: ${c}`).join("\n")}`,
    );
  }

  // OPEN DECISIONS (D3_Manual_Fix_Queue pending)
  if (b.open_decisions.length === 0) {
    sections.push(`## OPEN DECISIONS (0)\n  (nothing waiting in the manual-fix queue)`);
  } else {
    const lines = [`## OPEN DECISIONS (${b.open_decisions.length})`];
    for (const d of b.open_decisions.slice(0, 10)) {
      const issue = d.issue_category ?? "(unknown issue)";
      lines.push(
        `  ${d.address} — ${issue}${d.detected_date ? ` (detected ${d.detected_date})` : ""}`,
      );
    }
    if (b.open_decisions.length > 10) {
      lines.push(`  ... ${b.open_decisions.length - 10} more`);
    }
    sections.push(lines.join("\n"));
  }

  // RECENT KEY DECISIONS (Spine entries)
  if (b.recent_key_decisions.length > 0) {
    const lines = [`## RECENT KEY DECISIONS`];
    for (const d of b.recent_key_decisions.slice(0, 8)) {
      const date = d.decision_date ?? "(undated)";
      lines.push(`  ${date} — ${d.decision_title}`);
    }
    sections.push(lines.join("\n"));
  }

  // AUDIT SUMMARY (Vercel KV)
  const auditEntries = Object.entries(b.audit_summary.by_agent)
    .filter(([, count]) => count > 0)
    .sort((a, b2) => b2[1] - a[1])
    .slice(0, 10);
  const lat = b.audit_summary.mcp_call_latency;
  if (
    auditEntries.length > 0 ||
    b.audit_summary.recent_failures.length > 0 ||
    lat.samples > 0
  ) {
    const lines = [`## AUDIT SUMMARY (${b.audit_summary.total_events_since} events)`];
    if (auditEntries.length > 0) {
      lines.push(`  By agent:`);
      for (const [a, c] of auditEntries) lines.push(`    ${a}: ${c}`);
    }
    if (lat.samples > 0) {
      const overTarget =
        lat.over_target_count > 0
          ? ` — ${lat.over_target_count} above ${(lat.p95_target_ms / 1000).toFixed(0)}s target`
          : "";
      lines.push(
        `  MCP latency (${lat.samples} calls): P50 ${fmtMs(lat.p50_ms)}, P95 ${fmtMs(lat.p95_ms)}, P99 ${fmtMs(lat.p99_ms)}${overTarget}`,
      );
      const toolEntries = Object.entries(lat.by_tool)
        .filter(([, t]) => t.samples > 0)
        .sort((x, y) => y[1].samples - x[1].samples);
      for (const [tool, t] of toolEntries) {
        lines.push(`    ${tool}: ${t.samples} calls, P50 ${fmtMs(t.p50_ms)}, P95 ${fmtMs(t.p95_ms)}`);
      }
    }
    if (b.audit_summary.recent_failures.length > 0) {
      lines.push(`  Recent failures (${b.audit_summary.recent_failures.length}):`);
      for (const f of b.audit_summary.recent_failures.slice(0, 5)) {
        lines.push(
          `    ${f.agent}/${f.event}${f.recordId ? ` (${f.recordId})` : ""}: ${truncate(f.error ?? "", 60)}`,
        );
      }
    }
    sections.push(lines.join("\n"));
  }

  // EXTERNAL SIGNALS
  const ext = b.external_signals;
  const extLines = [`## EXTERNAL SIGNALS`];
  extLines.push(
    `  RentCast: ${ext.rentcast.api_responsive ? "up" : "down"}, cap ${ext.rentcast.monthly_cap}, est ${ext.rentcast.burn_rate.estimated_calls_remaining} remaining, burn ${ext.rentcast.burn_rate.burn_rate_per_day}/day${ext.rentcast.burn_rate.days_until_exhaustion_estimate != null ? ` (~${ext.rentcast.burn_rate.days_until_exhaustion_estimate}d until exhaustion)` : ""}`,
  );
  extLines.push(
    `  Quo: ${ext.quo.api_responsive ? "up" : "down"}, ${ext.quo.messages_last_24h} messages in window`,
  );
  extLines.push(
    `  Vercel: latest deploy ${ext.vercel.latest_deploy_state}${ext.vercel.latest_deploy_short_sha ? ` (${ext.vercel.latest_deploy_short_sha})` : ""}${ext.vercel.latest_deploy_branch ? ` on ${ext.vercel.latest_deploy_branch}` : ""}`,
  );
  sections.push(extLines.join("\n"));

  // STALENESS WARNINGS
  if (b.staleness_warnings.length > 0) {
    sections.push(
      `## ⚠ STALENESS WARNINGS\n${b.staleness_warnings.map((w) => `  ${w}`).join("\n")}`,
    );
  }

  sections.push(`---\nGenerated in ${b.duration_ms}ms. What do you want to work on?`);

  return sections.join("\n\n");
}

function fmtMs(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function hoursAgoOf(sinceIso: string, nowIso: string): number {
  const since = new Date(sinceIso).getTime();
  const now = new Date(nowIso).getTime();
  if (isNaN(since) || isNaN(now)) return 24;
  return Math.max(1, Math.round((now - since) / (60 * 60_000)));
}
