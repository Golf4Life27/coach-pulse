// Maverick MCP — per-method handler dispatch.
// @agent: maverick (Day 3)
//
// Pure-function handlers for each JSON-RPC method. The HTTP route
// validates + routes; this module owns the method-specific logic.
// All buildBriefing access is injected via DI so tests can hit the
// dispatch logic without making real load-state calls.

import {
  buildError,
  buildResult,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_METHOD_NOT_FOUND,
  MCP_TOOL_EXECUTION_ERROR,
  type JsonRpcId,
  type JsonRpcResponse,
} from "./protocol";
import { findTool, MAVERICK_TOOLS } from "./tools";
import type { Briefing } from "../briefing";
import { validateWriteStateArgs, writeState, type WriteStateResult } from "../write-state";
import { validateRecallArgs, recall, type RecallResponse } from "../recall";

// Protocol version we advertise. Anthropic's MCP clients negotiate
// the version on `initialize`; clients pick the highest version both
// sides support. We default to the latest stable.
const SUPPORTED_PROTOCOL_VERSION = "2025-06-18";

const SERVER_INFO = {
  name: "maverick",
  version: "1.0.0",
};

/**
 * Tool-call dependency surface. Production wires this to the real
 * lib/maverick/{aggregator,write-state,recall} implementations.
 * Tests inject stubs.
 */
export interface HandlerDeps {
  buildBriefing: (opts: {
    since?: string | Date;
    skipCache?: boolean;
  }) => Promise<Briefing>;
  writeState: (args: Parameters<typeof writeState>[0]) => Promise<WriteStateResult>;
  recall: (args: Parameters<typeof recall>[0]) => Promise<RecallResponse>;
}

/**
 * Dispatch the validated JSON-RPC request to the right handler.
 * Returns the response payload (or null for notifications, which the
 * HTTP layer turns into 202 with empty body).
 */
export async function dispatch(
  method: string,
  params: unknown,
  id: JsonRpcId,
  deps: HandlerDeps,
): Promise<JsonRpcResponse | null> {
  switch (method) {
    case "initialize":
      return handleInitialize(id, params);
    case "notifications/initialized":
      // Notification — no response per JSON-RPC 2.0. Handler returns
      // null and HTTP layer responds 202.
      return null;
    case "tools/list":
      return handleToolsList(id);
    case "tools/call":
      return handleToolsCall(id, params, deps);
    case "ping":
      // MCP convention — clients ping to verify the server is alive.
      return buildResult(id, {});
    default:
      return buildError(id, JSON_RPC_METHOD_NOT_FOUND, `method not found: ${method}`);
  }
}

/**
 * MCP initialize handshake. Client sends its protocol version +
 * capabilities; we respond with ours.
 */
export function handleInitialize(id: JsonRpcId, params: unknown): JsonRpcResponse {
  // Echo client's protocolVersion when supported; otherwise advertise
  // our latest. Anthropic clients send protocolVersion like
  // "2025-06-18" or "2024-11-05".
  let protocolVersion = SUPPORTED_PROTOCOL_VERSION;
  if (params && typeof params === "object" && "protocolVersion" in params) {
    const requested = (params as { protocolVersion: unknown }).protocolVersion;
    if (typeof requested === "string" && requested.length > 0) {
      // Echo the client's version. Our handlers are tolerant of the
      // narrow MCP-version range Anthropic's clients send; we don't
      // gate on it.
      protocolVersion = requested;
    }
  }
  return buildResult(id, {
    protocolVersion,
    capabilities: {
      // tools is the only capability we expose in v1. Future Pulse
      // (Day 5) may add prompts/resources/sampling.
      tools: {
        listChanged: false,
      },
    },
    serverInfo: SERVER_INFO,
    // Optional instructions field — surfaced to the client model as
    // additional context about how to use this server.
    instructions:
      "Call maverick_load_state at session open to load the AKB Inevitable operational state. The narrative response is in Owner's Rep voice with deterministic facts preserved. Per Inevitable Continuity Layer Spec v1.1.",
  });
}

export function handleToolsList(id: JsonRpcId): JsonRpcResponse {
  return buildResult(id, { tools: MAVERICK_TOOLS });
}

/**
 * tools/call dispatcher. Validates params shape, routes to per-tool
 * handler, wraps result in MCP content shape.
 */
export async function handleToolsCall(
  id: JsonRpcId,
  params: unknown,
  deps: HandlerDeps,
): Promise<JsonRpcResponse> {
  if (typeof params !== "object" || params === null) {
    return buildError(id, JSON_RPC_INVALID_PARAMS, "params must be an object");
  }
  const p = params as Record<string, unknown>;
  if (typeof p.name !== "string") {
    return buildError(id, JSON_RPC_INVALID_PARAMS, "params.name must be a string");
  }
  const tool = findTool(p.name);
  if (!tool) {
    return buildError(id, JSON_RPC_INVALID_PARAMS, `unknown tool: ${p.name}`);
  }
  const args = (p.arguments && typeof p.arguments === "object" ? p.arguments : {}) as Record<
    string,
    unknown
  >;

  switch (p.name) {
    case "maverick_load_state":
      return runLoadState(id, args, deps);
    case "maverick_write_state":
      return runWriteState(id, args, deps);
    case "maverick_recall":
      return runRecall(id, args, deps);
    default:
      // Defensive — findTool returned non-null but the dispatch
      // doesn't know this tool. Indicates tools.ts ↔ handlers.ts
      // drift.
      return buildError(
        id,
        MCP_TOOL_EXECUTION_ERROR,
        `tool ${p.name} is registered but has no handler`,
      );
  }
}

/**
 * Pure shape for the maverick_load_state call. Extracted so tests
 * can inject deps and assert content shape without standing up the
 * full HTTP machinery.
 */
export async function runLoadState(
  id: JsonRpcId,
  args: Record<string, unknown>,
  deps: HandlerDeps,
): Promise<JsonRpcResponse> {
  const format = typeof args.format === "string" ? args.format : "narrative";
  const since = typeof args.since === "string" ? args.since : undefined;
  const skipCache = args.skip_cache === true;

  if (!["narrative", "structured", "both"].includes(format)) {
    return buildError(
      id,
      JSON_RPC_INVALID_PARAMS,
      `format must be one of: narrative, structured, both`,
    );
  }

  let briefing: Briefing;
  try {
    briefing = await deps.buildBriefing({ since, skipCache });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return buildError(id, MCP_TOOL_EXECUTION_ERROR, `buildBriefing failed: ${msg}`);
  }

  // MCP tools/call response shape: content is an array of content
  // blocks. Each block has a `type` discriminator. We use "text" for
  // the narrative + a structured-content payload (the spec allows
  // `structuredContent` alongside text for richer client rendering).
  const textPayload = format === "structured" ? "" : briefing.narrative;
  const content: Array<{ type: "text"; text: string }> = [];
  if (textPayload) {
    content.push({ type: "text", text: textPayload });
  }

  // structuredContent surfaces the JSON shape — Anthropic clients
  // that support it render it as a structured panel; others see only
  // the text. v1 always includes it for diagnostic value when format
  // is "structured" or "both".
  const result: Record<string, unknown> = { content };
  if (format !== "narrative") {
    result.structuredContent = {
      generated_at: briefing.generated_at,
      duration_ms: briefing.duration_ms,
      narrative_synthesized: briefing.narrative_synthesized,
      narrative_error: briefing.narrative_error,
      structured: briefing.structured,
      source_health: briefing.source_health,
    };
  }
  // isError: true marks the tool call as a failure-with-data. We use
  // it when the briefing succeeded structurally but had source-side
  // problems serious enough to flag (e.g., synthesis fallback +
  // multiple sources down). Default false.
  const synthesisFailed = !briefing.narrative_synthesized;
  const failedSourceCount = Object.values(briefing.source_health).filter((h) => !h.ok).length;
  if (synthesisFailed && failedSourceCount > 3) {
    result.isError = true;
  }

  return buildResult(id, result);
}

/**
 * maverick_write_state — validate + dispatch to lib/maverick/write-state.
 * Per Spec v1.1 §5 Step 4 + amendment 6.4: append-only writes,
 * corrections are themselves new writes referencing prior via
 * related_spine_decision.
 */
export async function runWriteState(
  id: JsonRpcId,
  args: Record<string, unknown>,
  deps: HandlerDeps,
): Promise<JsonRpcResponse> {
  const validated = validateWriteStateArgs(args);
  if (!validated.ok) {
    return buildError(id, JSON_RPC_INVALID_PARAMS, validated.error);
  }

  let result: WriteStateResult;
  try {
    result = await deps.writeState(validated.args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return buildError(id, MCP_TOOL_EXECUTION_ERROR, `writeState failed: ${msg}`);
  }

  // MCP tools/call response: human-readable text content + the raw
  // result as structuredContent so the calling Claude session can
  // both read the confirmation AND reference the IDs programmatically.
  const text = `Wrote ${validated.args.event_type} "${validated.args.title}" to Spine_Decision_Log as ${result.spine_record_id}. Audit event ts: ${result.audit_event_id}.`;
  return buildResult(id, {
    content: [{ type: "text", text }],
    structuredContent: result,
  });
}

/**
 * maverick_recall — validate + dispatch to lib/maverick/recall.
 * Returns a top-N truncated, source-interleaved result set so
 * callers see a diverse mix rather than one source dominating.
 */
export async function runRecall(
  id: JsonRpcId,
  args: Record<string, unknown>,
  deps: HandlerDeps,
): Promise<JsonRpcResponse> {
  const validated = validateRecallArgs(args);
  if (!validated.ok) {
    return buildError(id, JSON_RPC_INVALID_PARAMS, validated.error);
  }

  let result: RecallResponse;
  try {
    result = await deps.recall(validated.args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return buildError(id, MCP_TOOL_EXECUTION_ERROR, `recall failed: ${msg}`);
  }

  // Render a compact one-line-per-result text block for the calling
  // model's narrative consumption, plus structuredContent for
  // programmatic access.
  const lines: string[] = [];
  lines.push(
    `Found ${result.results.length} match(es) across [${result.searched_sources.join(", ")}]${
      result.truncated_to_n > 0 ? ` (+${result.truncated_to_n} more truncated)` : ""
    }:`,
  );
  for (const r of result.results) {
    lines.push(`  [${r.source}/${r.record_id}] ${r.summary}`);
  }

  return buildResult(id, {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: result,
  });
}
