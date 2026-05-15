// Maverick MCP — JSON-RPC 2.0 protocol primitives.
// @agent: maverick (Day 3)
//
// Pure types + builders for JSON-RPC 2.0 over HTTP, scoped to what
// MCP needs. The HTTP handler in app/api/maverick/mcp/route.ts owns
// transport; this module owns the wire-shape correctness.
//
// MCP transport reference: Streamable HTTP — POST per request, JSON
// body in + JSON body out. SSE streaming reserved for future
// long-running tools; v1 maverick_load_state completes in <30s so
// we serve plain JSON responses.

// Standard JSON-RPC 2.0 error codes.
export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_INTERNAL_ERROR = -32603;
// MCP-server-defined codes use the -32000 to -32099 reserved range.
export const MCP_UNAUTHORIZED = -32000;
export const MCP_TOOL_EXECUTION_ERROR = -32001;

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId; // notifications omit id
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

/**
 * True for notifications (no id) — MCP spec says servers MUST NOT
 * respond to notifications. The handler returns 202 with empty body
 * in that case.
 */
export function isNotification(req: JsonRpcRequest): boolean {
  return !("id" in req) || req.id === undefined;
}

/**
 * Validate the minimal JSON-RPC 2.0 shape. Returns null when valid,
 * or an error response when not.
 */
export function validateJsonRpcRequest(
  body: unknown,
): { ok: true; req: JsonRpcRequest } | { ok: false; error: JsonRpcErrorResponse } {
  if (typeof body !== "object" || body === null) {
    return {
      ok: false,
      error: buildError(null, JSON_RPC_INVALID_REQUEST, "Request must be a JSON object"),
    };
  }
  const o = body as Record<string, unknown>;
  if (o.jsonrpc !== "2.0") {
    return {
      ok: false,
      error: buildError(
        (o.id as JsonRpcId) ?? null,
        JSON_RPC_INVALID_REQUEST,
        "jsonrpc field must be '2.0'",
      ),
    };
  }
  if (typeof o.method !== "string" || o.method.length === 0) {
    return {
      ok: false,
      error: buildError(
        (o.id as JsonRpcId) ?? null,
        JSON_RPC_INVALID_REQUEST,
        "method field is required and must be a non-empty string",
      ),
    };
  }
  // id, if present, must be string | number | null. Notifications omit it.
  if ("id" in o && !isValidId(o.id)) {
    return {
      ok: false,
      error: buildError(null, JSON_RPC_INVALID_REQUEST, "id must be string, number, or null"),
    };
  }
  return { ok: true, req: o as unknown as JsonRpcRequest };
}

function isValidId(v: unknown): boolean {
  return typeof v === "string" || typeof v === "number" || v === null;
}

export function buildResult(id: JsonRpcId, result: unknown): JsonRpcSuccessResponse {
  return { jsonrpc: "2.0", id, result };
}

export function buildError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  const err: JsonRpcErrorResponse["error"] = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: "2.0", id, error: err };
}
