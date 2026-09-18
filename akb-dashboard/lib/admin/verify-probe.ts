// Pure response shaping for GET /api/admin/verify-probe (2026-09-18).
// @agent: scout
//
// WHY: the Sold/Pending detector shipped 2026-09-17 against curl-stripped
// HTML, not the real production Firecrawl markdown, and its first live pass
// mislabeled 27 listings Off Market. Nobody could see what buildResolvedResult
// actually scans. This shapes that view: the SAME scoped text
// (scopeStatusText) production checks, plus the raw markdown underneath it,
// truncated to something a human can read in one response.

import { scopeStatusText, stripCompsSection } from "@/lib/crawler/sources/listing-text-scope";
import { detectBareStatusLines } from "@/lib/crawler/sources/firecrawl";

const MAX_LINE_CHARS = 200;
const STATUS_SCOPE_LINES = 60;
const RAW_HEAD_LINES = 120;

/** Pure: truncate one line to MAX_LINE_CHARS. */
function truncateLine(line: string): string {
  return line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) : line;
}

export interface VerifyProbeDiagnostic {
  bare_status_lines: string[];
  status_scope: { chars: number; first_lines: string[] };
  raw: { chars: number; head: string[] };
  comps_header_found: boolean;
}

/** Pure: shape one scraped listing's raw Firecrawl markdown into the
 *  diagnostic view — production's own scoped status text
 *  (scopeStatusText), the bare-status-line detector's output on it
 *  (diagnostic only — NOT wired into production, see firecrawl.ts
 *  detectInactiveMarkers), and the raw markdown head. */
export function buildVerifyProbeDiagnostic(markdown: string): VerifyProbeDiagnostic {
  const statusScope = scopeStatusText(markdown);
  const stripped = stripCompsSection(markdown);
  return {
    bare_status_lines: detectBareStatusLines(statusScope),
    status_scope: {
      chars: statusScope.length,
      first_lines: statusScope.split("\n").slice(0, STATUS_SCOPE_LINES).map(truncateLine),
    },
    raw: {
      chars: markdown.length,
      head: markdown.split("\n").slice(0, RAW_HEAD_LINES).map(truncateLine),
    },
    comps_header_found: stripped.length !== markdown.length,
  };
}
