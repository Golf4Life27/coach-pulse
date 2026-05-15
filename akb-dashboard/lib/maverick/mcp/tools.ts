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
  {
    name: "maverick_write_state",
    description:
      "Persist a decision, principle amendment, build event, or deal-state change to Maverick's durable state (Spine_Decision_Log + audit_log). Append-only — corrections to prior writes are themselves new writes that reference the prior via related_spine_decision. Per Spec v1.1 §5 Step 4 + amendment 6.4. Use this whenever a session produces a decision worth surviving past session close: a build choice, an amended principle, a recorded deal-state transition, anything Alex would otherwise have to remember manually.",
    inputSchema: {
      type: "object",
      properties: {
        event_type: {
          type: "string",
          enum: ["decision", "principle_amendment", "build_event", "deal_state_change"],
          description:
            "decision = a one-off operational choice. principle_amendment = a rule change that supersedes a prior rule (use related_spine_decision to point at the prior). build_event = a shipped change to the codebase / infra. deal_state_change = a pipeline transition worth surfacing in future briefings.",
        },
        title: {
          type: "string",
          description: "Human-readable one-line summary. Surfaces as the Spine row's Decision_Title.",
        },
        description: {
          type: "string",
          description:
            "Full detail of what happened. Multi-paragraph welcome. Surfaces in future maverick_load_state briefings + maverick_recall searches.",
        },
        reasoning: {
          type: "string",
          description:
            "Why this decision was made. Stored as Spine.Why. Optional but strongly recommended — the recall path searches this field, and future Claude sessions need the rationale, not just the outcome.",
        },
        related_spine_decision: {
          type: "string",
          description:
            "Airtable record ID (rec + 14 chars) of a prior Spine row this entry references — most often used by principle_amendment to point at what's being superseded.",
        },
        related_listing: {
          type: "string",
          description:
            "Airtable record ID of a Listings_V1 row this entry references — used by deal_state_change and decisions about a specific deal.",
        },
        attribution_agent: {
          type: "string",
          enum: ["maverick", "sentinel", "appraiser", "forge", "crier", "sentry", "scribe", "scout", "pulse", "ledger"],
          description:
            "Named-agent attribution per Spec v1.1 §6. Defaults to 'maverick' when omitted. Override when the decision belongs to a specific domain agent (e.g., 'crier' for a cadence template change, 'sentry' for a gate amendment).",
        },
      },
      required: ["event_type", "title", "description"],
      additionalProperties: false,
    },
  },
  {
    name: "maverick_recall",
    description:
      "Query Maverick's durable state across spine (Spine_Decision_Log) + audit (KV audit_log) + listings (Listings_V1) + deals (Deals). Free-text substring match across the queryable fields of each source, optionally filtered by date range. Use this to find prior decisions, recall what was said about a specific deal, locate a particular audit event, or trace a principle's history. Per Spec v1.1 §5 Step 2.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Free-text substring (case-insensitive). Matches across Decision_Title + Description + Why + Trigger_Event + Implication for spine, event/agent/recordId/summaries for audit, address/agent/notes for listings, address/seller/buyer/status for deals.",
        },
        since: {
          type: "string",
          description: "ISO 8601 lower bound on the match window. Optional.",
        },
        until: {
          type: "string",
          description: "ISO 8601 upper bound on the match window. Optional.",
        },
        sources: {
          type: "array",
          items: {
            type: "string",
            enum: ["spine", "audit", "listings", "deals"],
          },
          description:
            "Which sources to query. Defaults to ['spine', 'audit'] — the two highest-signal recall surfaces. Add 'listings' or 'deals' when looking for a specific property or deal context.",
        },
      },
      required: ["query"],
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
