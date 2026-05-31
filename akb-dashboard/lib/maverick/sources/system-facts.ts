// Maverick source — System Facts vault.
// @agent: maverick (A1, 2026-05-31)
//
// Reads `akb-dashboard/docs/system/SYSTEM_FACTS.md` — the canonical
// record of load-bearing facts about the AKB Inevitable system —
// and surfaces its contents to every briefing rebuild. The
// aggregator places this FIRST in the structured briefing so the
// synthesizer (and every other reader) anchors on these facts
// before any source-fetched data.
//
// Local disk read, no network, no auth — runs in <5ms in practice.
// Mirrors the candidate-path pattern from `codebase-metadata.ts`
// (`process.cwd()` + `akb-dashboard/` fallback) so the same code
// works whether the lambda's cwd is the repo root or the dashboard
// subdir.
//
// On read failure (file missing, permission denied) returns
// `markdown: null` + a populated `error`; the aggregator promotes
// `error` into `staleness_warnings` so the session sees the gap.
// Never throws.

import { promises as fs } from "node:fs";
import path from "node:path";
import type { SystemFactsSection } from "../briefing";

const RELATIVE_PATH = path.join("docs", "system", "SYSTEM_FACTS.md");

/** Pure: candidate paths the loader will try, in order. Exported for
 *  test inspection — production code shouldn't need to override. */
export function systemFactsCandidatePaths(cwd: string = process.cwd()): string[] {
  return [
    path.join(cwd, RELATIVE_PATH),
    path.join(cwd, "akb-dashboard", RELATIVE_PATH),
  ];
}

/**
 * Read SYSTEM_FACTS.md. Always resolves — failure populates `error`.
 * The aggregator awaits this inline before composing the briefing;
 * the file is tiny and on local disk, so it does not need a timeout
 * or a SourceResult wrapper (no latency/staleness story to tell).
 */
export async function loadSystemFacts(
  cwd: string = process.cwd(),
): Promise<SystemFactsSection> {
  const candidates = systemFactsCandidatePaths(cwd);
  for (const p of candidates) {
    try {
      const text = await fs.readFile(p, "utf-8");
      return { markdown: text, error: null };
    } catch {
      // try next candidate
    }
  }
  return {
    markdown: null,
    error: `SYSTEM_FACTS.md not found at any candidate path (${candidates.join(", ")})`,
  };
}
