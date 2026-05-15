// Maverick MCP — tool catalog.
// @agent: maverick (Day 3)
//
// Single source of truth for the tools Maverick exposes via MCP.
// Day 3 ships maverick_load_state. Day 4 adds maverick_write_state
// and maverick_recall. Day 5 stubs maverick_propose (Pulse layer).
//
// The tools-list handler reads from MAVERICK_TOOLS directly; the
// tools-call dispatcher routes by tool.name to a per-tool handler.

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

/**
 * Tool catalog as exposed to MCP clients. Order matters for
 * tools/list display in some client UIs; load-state first because
 * it's the canonical session-open entry point.
 */
export const MAVERICK_TOOLS: ToolDefinition[] = [
  {
    name: "maverick_load_state",
    description:
      "Load the current operational state of the AKB Inevitable system. Call this at session open. Returns a narrative briefing of current build state, active deals, open decisions, recent key decisions, audit summary, and external signals — synthesized in Owner's Rep voice with deterministic facts preserved. Per Inevitable Continuity Layer Spec v1.1 §5 Step 1. Performance target: P95 ≤ 30s, P50 ≤ 15s. 90s stale-while-revalidate cache.",
    inputSchema: {
      type: "object",
      properties: {
        since: {
          type: "string",
          description:
            "ISO 8601 timestamp anchoring the 'what's new' window. Briefing surfaces deltas since this point. Defaults to 24h ago.",
        },
        format: {
          type: "string",
          enum: ["narrative", "structured", "both"],
          description:
            "narrative = Owner's Rep prose only (default — what session-open uses). structured = JSON only (diagnostic). both = full briefing object.",
        },
        skip_cache: {
          type: "boolean",
          description:
            "Bypass the 90s stale-while-revalidate cache and force a full source-fetch + synthesis. Use only when state is suspected to be stale; default false.",
        },
      },
      additionalProperties: false,
    },
  },
];

/**
 * Pure lookup helper. Returns null when no tool by that name exists.
 */
export function findTool(name: string): ToolDefinition | null {
  return MAVERICK_TOOLS.find((t) => t.name === name) ?? null;
}
