// @agent: maverick — JSON-RPC protocol primitives tests.

import { describe, it, expect } from "vitest";
import {
  validateJsonRpcRequest,
  buildResult,
  buildError,
  isNotification,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
} from "./protocol";

describe("validateJsonRpcRequest — happy paths", () => {
  it("accepts a well-formed request with id + method + params", () => {
    const r = validateJsonRpcRequest({
      jsonrpc: "2.0",
      id: 42,
      method: "tools/list",
      params: {},
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.req.method).toBe("tools/list");
      expect(r.req.id).toBe(42);
    }
  });

  it("accepts a notification (no id field)", () => {
    const r = validateJsonRpcRequest({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(r.ok).toBe(true);
  });

  it("accepts string id, number id, and null id", () => {
    for (const id of ["abc", 1, null]) {
      const r = validateJsonRpcRequest({ jsonrpc: "2.0", id, method: "x" });
      expect(r.ok).toBe(true);
    }
  });

  it("accepts missing params (defaulted to undefined by spec)", () => {
    const r = validateJsonRpcRequest({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(r.ok).toBe(true);
  });
});

describe("validateJsonRpcRequest — rejections", () => {
  it("rejects non-object body with -32600", () => {
    const r = validateJsonRpcRequest("not an object");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.error.code).toBe(JSON_RPC_INVALID_REQUEST);
  });

  it("rejects null body with -32600", () => {
    const r = validateJsonRpcRequest(null);
    expect(r.ok).toBe(false);
  });

  it("rejects missing jsonrpc field", () => {
    const r = validateJsonRpcRequest({ id: 1, method: "x" });
    expect(r.ok).toBe(false);
  });

  it("rejects wrong jsonrpc version", () => {
    const r = validateJsonRpcRequest({ jsonrpc: "1.0", id: 1, method: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.error.message).toMatch(/2\.0/);
  });

  it("rejects missing method", () => {
    const r = validateJsonRpcRequest({ jsonrpc: "2.0", id: 1 });
    expect(r.ok).toBe(false);
  });

  it("rejects empty-string method", () => {
    const r = validateJsonRpcRequest({ jsonrpc: "2.0", id: 1, method: "" });
    expect(r.ok).toBe(false);
  });

  it("rejects invalid id types (object, array, boolean)", () => {
    for (const id of [{}, [], true]) {
      const r = validateJsonRpcRequest({ jsonrpc: "2.0", id, method: "x" });
      expect(r.ok).toBe(false);
    }
  });

  it("preserves request id in error response when valid", () => {
    const r = validateJsonRpcRequest({ jsonrpc: "1.0", id: 99, method: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.id).toBe(99);
  });
});

describe("isNotification", () => {
  it("returns true for requests without id", () => {
    expect(isNotification({ jsonrpc: "2.0", method: "x" })).toBe(true);
  });

  it("returns false for requests with id (including null)", () => {
    expect(isNotification({ jsonrpc: "2.0", id: 1, method: "x" })).toBe(false);
    expect(isNotification({ jsonrpc: "2.0", id: null, method: "x" })).toBe(false);
    expect(isNotification({ jsonrpc: "2.0", id: "abc", method: "x" })).toBe(false);
  });
});

describe("buildResult / buildError", () => {
  it("builds a success response with the requested id + result", () => {
    const r = buildResult(7, { tools: [] });
    expect(r).toEqual({ jsonrpc: "2.0", id: 7, result: { tools: [] } });
  });

  it("builds an error response with code + message + optional data", () => {
    const r = buildError(8, JSON_RPC_METHOD_NOT_FOUND, "method not found: foo", { foo: 1 });
    expect(r.error.code).toBe(JSON_RPC_METHOD_NOT_FOUND);
    expect(r.error.message).toBe("method not found: foo");
    expect(r.error.data).toEqual({ foo: 1 });
  });

  it("omits data field when not provided", () => {
    const r = buildError(null, JSON_RPC_METHOD_NOT_FOUND, "missing");
    expect("data" in r.error).toBe(false);
  });

  it("accepts null id for parse errors that occurred before id extraction", () => {
    const r = buildError(null, -32700, "Parse error");
    expect(r.id).toBeNull();
  });
});
