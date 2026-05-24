// Phase 13.3 + 13.5 + 13.6 / Q.7 — Sentinel crawler scan endpoint.
//
// GET /api/agents/sentinel/crawler/scan[?source=propstream&limit=N]
//
// Runs the crawler intake pipeline (lib/crawler/pipeline.runCrawlerScan)
// across the requested source adapters, classifies each candidate
// through the intake quality gates (lib/intake/quality-gates), and
// returns the audit-ready result.
//
// **Read-only.** No Airtable writes. Operator reviews the returned
// candidates + manually promotes via the existing /api/process-intake
// route or the deal-detail UI. Apply mode (auto-promote pass-grade
// candidates) lands when live source adapters are credentialed and
// the operator opts in.

import { NextResponse } from "next/server";
import { audit } from "@/lib/audit-log";
import { runCrawlerScan } from "@/lib/crawler/pipeline";
import type { CrawlerSourceId } from "@/lib/crawler/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const ALL_SOURCES: CrawlerSourceId[] = [
  "propstream",
  "probate",
  "tax_delinquency",
  "code_violations",
];

function parseSources(raw: string | null): CrawlerSourceId[] | undefined {
  if (!raw) return undefined;
  const requested = raw.split(",").map((s) => s.trim());
  return requested.filter((s): s is CrawlerSourceId =>
    (ALL_SOURCES as string[]).includes(s),
  );
}

export async function GET(req: Request) {
  const t0 = Date.now();
  const url = new URL(req.url);
  const sources = parseSources(url.searchParams.get("source"));
  const limit = (() => {
    const raw = url.searchParams.get("limit");
    if (!raw) return undefined;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  })();

  const result = await runCrawlerScan({ sources, limit });

  await audit({
    agent: "sentinel",
    event: "crawler_scan",
    status: result.source_scans.some((s) => s.source_health === "down")
      ? "confirmed_failure"
      : "confirmed_success",
    inputSummary: { sources: sources ?? "all", limit },
    outputSummary: {
      total_candidates: result.total_candidates,
      action_counts: result.action_counts,
      source_health: Object.fromEntries(
        result.source_scans.map((s) => [s.source, s.source_health]),
      ),
    },
    decision: "ok",
    ms: Date.now() - t0,
  });

  return NextResponse.json({
    generated_at: new Date().toISOString(),
    elapsed_ms: Date.now() - t0,
    ...result,
  });
}
