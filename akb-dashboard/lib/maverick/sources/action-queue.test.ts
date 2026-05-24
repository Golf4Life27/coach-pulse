// @agent: maverick — action-queue summarizer tests.

import { describe, it, expect } from "vitest";
import { summarizeQueue } from "./action-queue";

describe("action-queue summarizeQueue", () => {
  it("maps D3_Manual_Fix_Queue records to typed items via field-IDs", () => {
    const r = summarizeQueue([
      {
        id: "recFIX001",
        fields: {
          fldFG1tMNsEJFXHnK: "123 Test St",
          fldkjCt4GnSglzE1H: { id: "selA", name: "invalid_phone_format", color: "x" },
          fld4DZKhLnrVdW1td: "2026-05-14",
          fldFy8mcpW4pxOwPc: { id: "selB", name: "D3 Phase 0a", color: "x" },
          fldJAbPKbOUc6NbYa: "713-555-0100",
          fldznkl2bDfD3wfrC: "Sarah",
        },
      },
    ]);
    expect(r.d3_manual_fix_queue_pending_count).toBe(1);
    expect(r.d3_manual_fix_queue_pending_sample[0]).toMatchObject({
      id: "recFIX001",
      address: "123 Test St",
      issue_category: "invalid_phone_format",
      detected_date: "2026-05-14",
      detected_by: "D3 Phase 0a",
      agent_phone_raw: "713-555-0100",
      agent_first_name: "Sarah",
    });
  });

  it("caps the sample at 10 even when more records come back", () => {
    const records = Array.from({ length: 25 }, (_, i) => ({
      id: `recFIX${String(i).padStart(3, "0")}`,
      fields: {
        fldFG1tMNsEJFXHnK: `Address ${i}`,
        fldkjCt4GnSglzE1H: "invalid_phone_format",
      },
    }));
    const r = summarizeQueue(records);
    expect(r.d3_manual_fix_queue_pending_count).toBe(25);
    expect(r.d3_manual_fix_queue_pending_sample).toHaveLength(10);
  });

  it("falls back to '(no address)' when address field is missing", () => {
    const r = summarizeQueue([{ id: "recA", fields: {} }]);
    expect(r.d3_manual_fix_queue_pending_sample[0].address).toBe("(no address)");
  });

  it("reports Cadence_Queue placeholder as 0/[] until Tier B builds it", () => {
    const r = summarizeQueue([]);
    expect(r.cadence_queue_pending_count).toBe(0);
    expect(r.cadence_queue_pending_sample).toEqual([]);
  });

  it("handles empty input cleanly", () => {
    const r = summarizeQueue([]);
    expect(r.d3_manual_fix_queue_pending_count).toBe(0);
    expect(r.d3_manual_fix_queue_pending_sample).toEqual([]);
  });
});
