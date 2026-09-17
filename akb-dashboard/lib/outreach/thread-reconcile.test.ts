// Thread-reconcile — the manual-Quo-outbound-to-notes writer. Pure function
// coverage only; I/O lives in app/api/admin/thread-reconcile/route.ts.

import { describe, it, expect } from "vitest";
import type { QuoMessage } from "@/lib/quo";
import { buildReconcileBlock, prependReconcileBlock } from "./thread-reconcile";

const msg = (over: Partial<QuoMessage>): QuoMessage => ({
  id: "ACAAAA000000000000000000000000AA",
  from: "+18155569965",
  to: "+17347093339",
  body: "hi",
  direction: "outgoing",
  createdAt: "2026-09-17T12:00:00.000Z",
  ...over,
});

const NOW = new Date("2026-09-17T18:30:00.000Z");

const KNOWN_NOTES = "[H2 sent 2026-09-01] Quo msg AC08a9a32420364cb28fd69ce6d2db20: hello there";

describe("buildReconcileBlock", () => {
  it("skips ids already present in notes, case-insensitively", () => {
    const thread = [msg({ id: "AC08A9A32420364CB28FD69CE6D2DB20" })];
    const r = buildReconcileBlock(thread, KNOWN_NOTES, NOW);
    expect(r.unrecorded).toHaveLength(0);
    expect(r.block).toBe("");
  });

  it("collects unrecorded outbound only — ignores inbound and recorded outbound", () => {
    const thread = [
      msg({ id: "AC08A9A32420364CB28FD69CE6D2DB20" }), // recorded
      msg({ id: "ACINBOUND00000000000000000000AB", direction: "incoming" }),
      msg({ id: "ACMANUAL0000000000000000000000CC", body: "call me back" }),
    ];
    const r = buildReconcileBlock(thread, KNOWN_NOTES, NOW);
    expect(r.unrecorded).toHaveLength(1);
    expect(r.unrecorded[0].id).toBe("ACMANUAL0000000000000000000000CC");
  });

  it("collapses embedded newlines to spaces and truncates the body at 200 chars", () => {
    const longBody = "line one\nline two\nline three " + "x".repeat(250);
    const thread = [msg({ id: "ACMANUAL0000000000000000000000CC", body: longBody })];
    const r = buildReconcileBlock(thread, null, NOW);
    expect(r.block).not.toContain("\n\n"); // no blank lines inside a message line
    const line = r.block.split("\n").find((l) => l.startsWith("Quo msg ACMANUAL"))!;
    expect(line).not.toMatch(/line one\nline two/);
    expect(line).toContain("line one line two line three");
    const bodyPart = line.split(": ").slice(1).join(": ");
    expect(bodyPart.length).toBeLessThanOrEqual(200);
  });

  it("orders unrecorded messages oldest first regardless of input order", () => {
    const thread = [
      msg({ id: "ACNEW0000000000000000000000000A", createdAt: "2026-09-17T15:00:00.000Z" }),
      msg({ id: "ACOLD0000000000000000000000000B", createdAt: "2026-09-17T10:00:00.000Z" }),
    ];
    const r = buildReconcileBlock(thread, null, NOW);
    expect(r.unrecorded.map((m) => m.id)).toEqual([
      "ACOLD0000000000000000000000000B",
      "ACNEW0000000000000000000000000A",
    ]);
    const idxOld = r.block.indexOf("ACOLD0000000000000000000000000B");
    const idxNew = r.block.indexOf("ACNEW0000000000000000000000000A");
    expect(idxOld).toBeGreaterThan(-1);
    expect(idxOld).toBeLessThan(idxNew);
  });

  it("returns an empty block and empty unrecorded list when nothing is unrecorded", () => {
    const r = buildReconcileBlock([], null, NOW);
    expect(r.unrecorded).toEqual([]);
    expect(r.block).toBe("");
  });

  it("header carries the reconciled timestamp and count", () => {
    const thread = [
      msg({ id: "ACA0000000000000000000000000000" }),
      msg({ id: "ACB0000000000000000000000000000" }),
    ];
    const r = buildReconcileBlock(thread, null, NOW);
    expect(r.block.startsWith(`[Manual Quo outbound reconciled ${NOW.toISOString()}] 2 operator text(s)`)).toBe(true);
  });
});

describe("prependReconcileBlock", () => {
  it("prepends the block above existing notes with a blank line between", () => {
    const out = prependReconcileBlock("BLOCK", "existing notes");
    expect(out).toBe("BLOCK\n\nexisting notes");
  });

  it("leaves existing notes untouched byte-for-byte below the block", () => {
    const existing = "line a\nline b\n\nline c";
    const out = prependReconcileBlock("BLOCK", existing);
    expect(out.endsWith(existing)).toBe(true);
  });

  it("empty block is a no-op — returns existing notes unchanged", () => {
    expect(prependReconcileBlock("", "existing notes")).toBe("existing notes");
    expect(prependReconcileBlock("", null)).toBe("");
  });

  it("no existing notes → block alone, nothing appended", () => {
    expect(prependReconcileBlock("BLOCK", null)).toBe("BLOCK");
    expect(prependReconcileBlock("BLOCK", "")).toBe("BLOCK");
  });
});
