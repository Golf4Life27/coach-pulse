// @agent: maverick — tool catalog tests.

import { describe, it, expect } from "vitest";
import { MAVERICK_TOOLS, findTool } from "./tools";

describe("MAVERICK_TOOLS catalog", () => {
  it("exposes three tools in v1 (Day 4 scope): load_state, write_state, recall", () => {
    expect(MAVERICK_TOOLS).toHaveLength(3);
    const names = MAVERICK_TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(["maverick_load_state", "maverick_recall", "maverick_write_state"]);
  });

  it("orders load_state first (canonical session-open entry point)", () => {
    expect(MAVERICK_TOOLS[0].name).toBe("maverick_load_state");
  });

  it("every tool has name + description + inputSchema", () => {
    for (const t of MAVERICK_TOOLS) {
      expect(typeof t.name).toBe("string");
      expect(t.name.length).toBeGreaterThan(0);
      expect(typeof t.description).toBe("string");
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.inputSchema.type).toBe("object");
      expect(typeof t.inputSchema.properties).toBe("object");
    }
  });

  it("maverick_load_state schema declares since/format/skip_cache and forbids extra props", () => {
    const tool = MAVERICK_TOOLS[0];
    expect(tool.inputSchema.properties).toHaveProperty("since");
    expect(tool.inputSchema.properties).toHaveProperty("format");
    expect(tool.inputSchema.properties).toHaveProperty("skip_cache");
    expect(tool.inputSchema.additionalProperties).toBe(false);
  });

  it("maverick_load_state.format enumerates exactly narrative/structured/both", () => {
    const tool = MAVERICK_TOOLS[0];
    const format = tool.inputSchema.properties.format as { enum?: string[] };
    expect(format.enum).toEqual(["narrative", "structured", "both"]);
  });

  it("description references the Continuity Layer Spec for traceability", () => {
    const desc = MAVERICK_TOOLS[0].description;
    expect(desc).toMatch(/Spec v1\.1/);
    expect(desc).toMatch(/Owner's Rep/);
  });
});

describe("maverick_write_state schema", () => {
  function writeStateTool() {
    return MAVERICK_TOOLS.find((t) => t.name === "maverick_write_state");
  }

  it("declares required: event_type + title + description", () => {
    const tool = writeStateTool();
    expect(tool?.inputSchema.required).toEqual(["event_type", "title", "description"]);
  });

  it("event_type enumerates the four canonical types", () => {
    const tool = writeStateTool();
    const ev = tool!.inputSchema.properties.event_type as { enum?: string[] };
    expect(ev.enum).toEqual(["decision", "principle_amendment", "build_event", "deal_state_change"]);
  });

  it("attribution_agent enumerates the full named-agent roster", () => {
    const tool = writeStateTool();
    const a = tool!.inputSchema.properties.attribution_agent as { enum?: string[] };
    expect(a.enum).toContain("maverick");
    expect(a.enum).toContain("sentry");
    expect(a.enum).toContain("crier");
    expect(a.enum?.length).toBe(10);
  });

  it("forbids additionalProperties so malformed calls are rejected client-side", () => {
    expect(writeStateTool()?.inputSchema.additionalProperties).toBe(false);
  });
});

describe("maverick_recall schema", () => {
  function recallTool() {
    return MAVERICK_TOOLS.find((t) => t.name === "maverick_recall");
  }

  it("declares required: query", () => {
    expect(recallTool()?.inputSchema.required).toEqual(["query"]);
  });

  it("sources items enumerate the four queryable surfaces", () => {
    const tool = recallTool();
    const s = tool!.inputSchema.properties.sources as { items?: { enum?: string[] } };
    expect(s.items?.enum).toEqual(["spine", "audit", "listings", "deals"]);
  });

  it("description names default sources (spine + audit) for caller clarity", () => {
    const tool = recallTool();
    expect(tool!.description).toMatch(/spine.*audit/i);
  });
});

describe("findTool", () => {
  it("returns the tool definition for a known name", () => {
    expect(findTool("maverick_load_state")).not.toBeNull();
    expect(findTool("maverick_write_state")).not.toBeNull();
    expect(findTool("maverick_recall")).not.toBeNull();
  });

  it("returns null for unknown names", () => {
    expect(findTool("maverick_unknown_tool")).toBeNull();
    expect(findTool("")).toBeNull();
  });
});
