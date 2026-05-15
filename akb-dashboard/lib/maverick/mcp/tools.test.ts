// @agent: maverick — tool catalog tests.

import { describe, it, expect } from "vitest";
import { MAVERICK_TOOLS, findTool } from "./tools";

describe("MAVERICK_TOOLS catalog", () => {
  it("exposes exactly one tool in v1 (Day 3 scope): maverick_load_state", () => {
    expect(MAVERICK_TOOLS).toHaveLength(1);
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

describe("findTool", () => {
  it("returns the tool definition for a known name", () => {
    expect(findTool("maverick_load_state")).not.toBeNull();
  });

  it("returns null for unknown names", () => {
    expect(findTool("maverick_unknown_tool")).toBeNull();
    expect(findTool("")).toBeNull();
  });
});
