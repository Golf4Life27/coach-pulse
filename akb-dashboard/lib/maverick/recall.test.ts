// @agent: maverick — recall pure-function tests.
//
// Per-source filters, match primitives, date-range bounds, response
// composition with source-interleaving + truncation. I/O wrappers
// are exercised against the deployed endpoint.

import { describe, it, expect, vi } from "vitest";
import {
  validateRecallArgs,
  matchesQuery,
  withinDateRange,
  filterSpine,
  filterAudit,
  filterListings,
  filterDeals,
  composeRecallResponse,
  recall,
  type RecallDeps,
  type RecallResult,
} from "./recall";
import type { AuditEntry } from "@/lib/audit-log";
import type { Listing, Deal } from "@/lib/types";

// ────────────── validateRecallArgs ──────────────

describe("validateRecallArgs", () => {
  it("accepts a query-only call", () => {
    const r = validateRecallArgs({ query: "65% rule" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args.query).toBe("65% rule");
  });

  it("trims whitespace on query", () => {
    const r = validateRecallArgs({ query: "  spaced  " });
    if (!r.ok) throw new Error("expected ok");
    expect(r.args.query).toBe("spaced");
  });

  it("accepts since + until ISO strings", () => {
    const r = validateRecallArgs({
      query: "x",
      since: "2026-05-01T00:00:00Z",
      until: "2026-05-15T23:59:59Z",
    });
    expect(r.ok).toBe(true);
  });

  it("accepts a sources subset + dedupes", () => {
    const r = validateRecallArgs({
      query: "x",
      sources: ["spine", "audit", "spine"], // duplicate intentional
    });
    if (!r.ok) throw new Error("expected ok");
    expect(r.args.sources).toEqual(["spine", "audit"]);
  });

  it("rejects empty query", () => {
    expect(validateRecallArgs({ query: "" }).ok).toBe(false);
    expect(validateRecallArgs({ query: "   " }).ok).toBe(false);
  });

  it("rejects malformed since/until", () => {
    expect(validateRecallArgs({ query: "x", since: "yesterday" }).ok).toBe(false);
    expect(validateRecallArgs({ query: "x", until: "tomorrow" }).ok).toBe(false);
  });

  it("rejects unknown source name", () => {
    expect(validateRecallArgs({ query: "x", sources: ["spine", "ledger"] }).ok).toBe(false);
  });

  it("rejects empty sources array", () => {
    expect(validateRecallArgs({ query: "x", sources: [] }).ok).toBe(false);
  });

  it("rejects non-array sources", () => {
    expect(validateRecallArgs({ query: "x", sources: "spine" }).ok).toBe(false);
  });
});

// ────────────── matchesQuery ──────────────

describe("matchesQuery", () => {
  it("returns true when any field contains the query (case-insensitive)", () => {
    expect(matchesQuery("MAVERICK", ["the maverick speaks", null])).toBe(true);
    expect(matchesQuery("crier", ["Crier dispatches", null])).toBe(true);
  });

  it("returns false when no field matches", () => {
    expect(matchesQuery("appraiser", ["sentinel", "forge"])).toBe(false);
  });

  it("skips null/undefined fields cleanly", () => {
    expect(matchesQuery("x", [null, undefined, null])).toBe(false);
    expect(matchesQuery("x", [null, "x", undefined])).toBe(true);
  });

  it("returns true on empty query (match-all sentinel)", () => {
    expect(matchesQuery("", ["anything"])).toBe(true);
  });
});

// ────────────── withinDateRange ──────────────

describe("withinDateRange", () => {
  it("returns true within both bounds", () => {
    expect(withinDateRange("2026-05-15T12:00:00Z", "2026-05-14T00:00:00Z", "2026-05-16T00:00:00Z")).toBe(true);
  });

  it("returns false before since", () => {
    expect(withinDateRange("2026-05-13T12:00:00Z", "2026-05-14T00:00:00Z", undefined)).toBe(false);
  });

  it("returns false after until", () => {
    expect(withinDateRange("2026-05-17T12:00:00Z", undefined, "2026-05-16T00:00:00Z")).toBe(false);
  });

  it("returns true when neither bound is set", () => {
    expect(withinDateRange("2026-01-01T00:00:00Z", undefined, undefined)).toBe(true);
  });

  it("excludes records with no timestamp when a bound is set", () => {
    expect(withinDateRange(null, "2026-05-01T00:00:00Z", undefined)).toBe(false);
    expect(withinDateRange(null, undefined, "2026-05-16T00:00:00Z")).toBe(false);
  });

  it("passes records with no timestamp when neither bound is set", () => {
    expect(withinDateRange(null, undefined, undefined)).toBe(true);
  });
});

// ────────────── filterSpine ──────────────

describe("filterSpine", () => {
  function spineRow(over: Partial<Record<string, unknown>>) {
    return {
      id: over.id as string ?? "recSPINE001",
      fields: {
        fldkeMrHBhx4X8aml: over.title ?? "Title",
        fld36Jlm4Fo4vLG1L: over.date ?? "2026-05-15",
        fldajtCDNGYjsnGBR: over.description ?? "Description",
        fldYxNN1KLOSLadI4: over.trigger ?? "Trigger",
        fld4IRmHf2h2fiNKX: over.why ?? "Why",
      },
    };
  }

  it("matches query against title/description/trigger/why fields", () => {
    const r = filterSpine(
      [
        spineRow({ id: "recA", title: "65% Rule lockdown" }),
        spineRow({ id: "recB", title: "Other", description: "65% rule clarified" }),
        spineRow({ id: "recC", title: "Unrelated", description: "Different topic" }),
      ],
      { query: "65%" },
    );
    expect(r).toHaveLength(2);
    expect(r.map((x) => x.record_id).sort()).toEqual(["recA", "recB"]);
  });

  it("sorts most-recent-first by Decision_Date", () => {
    const r = filterSpine(
      [
        spineRow({ id: "old", date: "2026-04-01", title: "x" }),
        spineRow({ id: "new", date: "2026-05-15", title: "x" }),
        spineRow({ id: "mid", date: "2026-05-01", title: "x" }),
      ],
      { query: "x" },
    );
    expect(r.map((x) => x.record_id)).toEqual(["new", "mid", "old"]);
  });

  it("source-tags every result as 'spine'", () => {
    const r = filterSpine([spineRow({ title: "x" })], { query: "x" });
    expect(r.every((x) => x.source === "spine")).toBe(true);
  });

  it("summary format: '{date} — {title}'", () => {
    const r = filterSpine([spineRow({ id: "r1", date: "2026-05-15", title: "Hello" })], {
      query: "Hello",
    });
    expect(r[0].summary).toBe("2026-05-15 — Hello");
  });

  it("filters out rows outside the date range", () => {
    const r = filterSpine(
      [
        spineRow({ id: "in", date: "2026-05-10", title: "x" }),
        spineRow({ id: "out", date: "2026-04-01", title: "x" }),
      ],
      { query: "x", since: "2026-05-01T00:00:00Z" },
    );
    expect(r.map((x) => x.record_id)).toEqual(["in"]);
  });
});

// ────────────── filterAudit ──────────────

describe("filterAudit", () => {
  function evt(over: Partial<AuditEntry>): AuditEntry {
    return {
      ts: "2026-05-15T18:00:00Z",
      agent: "maverick",
      event: "load_state",
      status: "confirmed_success",
      ...over,
    } as AuditEntry;
  }

  it("matches query against event/agent/decision/recordId/error", () => {
    const r = filterAudit(
      [
        evt({ ts: "2026-05-15T01:00:00Z", agent: "crier", event: "send" }),
        evt({ ts: "2026-05-15T02:00:00Z", agent: "sentry", event: "gate_run" }),
        evt({ ts: "2026-05-15T03:00:00Z", agent: "crier", event: "drift_check" }),
      ],
      { query: "crier" },
    );
    expect(r).toHaveLength(2);
  });

  it("matches query against JSON-stringified summaries", () => {
    const r = filterAudit(
      [
        evt({
          ts: "2026-05-15T01:00:00Z",
          inputSummary: { stored_offer_price: 61750, listing: "23 Fields" },
        }),
        evt({ ts: "2026-05-15T02:00:00Z", outputSummary: { decision: "fire follow_up_7" } }),
      ],
      { query: "61750" },
    );
    expect(r).toHaveLength(1);
  });

  it("respects date range bounds", () => {
    const r = filterAudit(
      [
        evt({ ts: "2026-05-10T00:00:00Z", agent: "x" }),
        evt({ ts: "2026-05-15T00:00:00Z", agent: "x" }),
      ],
      { query: "x", since: "2026-05-12T00:00:00Z" },
    );
    expect(r).toHaveLength(1);
  });

  it("source-tags every result as 'audit' with ts as record_id", () => {
    const r = filterAudit([evt({ ts: "2026-05-15T12:34:56Z", agent: "maverick" })], { query: "maverick" });
    expect(r[0].source).toBe("audit");
    expect(r[0].record_id).toBe("2026-05-15T12:34:56Z");
  });

  it("summary format: '{date} {time} — {agent}/{event} ({status})'", () => {
    const r = filterAudit(
      [evt({ ts: "2026-05-15T18:00:00Z", agent: "maverick", event: "load_state" })],
      { query: "maverick" },
    );
    expect(r[0].summary).toBe("2026-05-15 18:00:00 — maverick/load_state (confirmed_success)");
  });
});

// ────────────── filterListings + filterDeals ──────────────

describe("filterListings", () => {
  function listing(over: Partial<Listing>): Listing {
    return {
      id: "rec1",
      address: "x",
      city: "x",
      zip: "x",
      listPrice: null,
      mao: null,
      dom: null,
      offerTier: null,
      liveStatus: null,
      executionPath: null,
      outreachStatus: "Texted",
      lastOutreachDate: null,
      agentName: null,
      agentPhone: null,
      agentEmail: null,
      verificationUrl: null,
      notes: null,
      distressScore: null,
      distressBucket: null,
      bedrooms: null,
      bathrooms: null,
      buildingSqFt: null,
      stageCalc: null,
      approvedForOutreach: false,
      flipScore: null,
      offMarketOverride: false,
      restrictionText: null,
      ddChecklist: null,
      doNotText: false,
      state: null,
      actionHoldUntil: null,
      actionCardState: null,
      lastInboundAt: null,
      lastOutboundAt: null,
      ...over,
    };
  }

  it("matches across address + agentName + notes + city + state", () => {
    const r = filterListings(
      [
        listing({ id: "r1", address: "23 Fields Ave", city: "Memphis" }),
        listing({ id: "r2", agentName: "Candice Hardaway" }),
        listing({ id: "r3", notes: "Discussion of Section 16" }),
        listing({ id: "r4", address: "other" }),
      ],
      { query: "candice" },
    );
    expect(r.map((x) => x.record_id)).toEqual(["r2"]);
  });

  it("summary includes address + city + outreach_status", () => {
    const r = filterListings(
      [listing({ id: "r1", address: "23 Fields", city: "Memphis", outreachStatus: "Negotiating" })],
      { query: "Fields" },
    );
    expect(r[0].summary).toBe("23 Fields, Memphis — Negotiating");
  });
});

describe("filterDeals", () => {
  function deal(over: Partial<Deal>): Deal {
    return {
      id: "rec1",
      propertyAddress: "x",
      city: "x",
      state: "x",
      contractPrice: null,
      offerPrice: null,
      assignmentFee: null,
      estimatedRepairs: null,
      arv: null,
      status: "active",
      closingStatus: null,
      dispoReady: false,
      propertyImageUrl: null,
      beds: null,
      baths: null,
      sqft: null,
      buyerBlastStatus: null,
      actionCardState: null,
      actionHoldUntil: null,
      ...over,
    };
  }

  it("matches across propertyAddress + city + state + status", () => {
    const r = filterDeals(
      [
        deal({ id: "r1", propertyAddress: "23 Fields", city: "Memphis", status: "active" }),
        deal({ id: "r2", propertyAddress: "other" }),
      ],
      { query: "Memphis" },
    );
    expect(r.map((x) => x.record_id)).toEqual(["r1"]);
  });
});

// ────────────── composeRecallResponse ──────────────

describe("composeRecallResponse — source interleaving + truncation", () => {
  function result(source: RecallResult["source"], id: string): RecallResult {
    return { source, record_id: id, summary: id, full_data: {} };
  }

  it("interleaves results round-robin from each source", () => {
    const r = composeRecallResponse(
      [
        { source: "spine", results: [result("spine", "s1"), result("spine", "s2"), result("spine", "s3")] },
        { source: "audit", results: [result("audit", "a1"), result("audit", "a2")] },
      ],
      10,
    );
    // Round-robin: s1, a1, s2, a2, s3
    expect(r.results.map((x) => x.record_id)).toEqual(["s1", "a1", "s2", "a2", "s3"]);
  });

  it("truncates at the global limit and reports truncated_to_n", () => {
    const r = composeRecallResponse(
      [
        { source: "spine", results: [result("spine", "s1"), result("spine", "s2"), result("spine", "s3")] },
        { source: "audit", results: [result("audit", "a1"), result("audit", "a2")] },
      ],
      3,
    );
    expect(r.results).toHaveLength(3);
    expect(r.truncated_to_n).toBe(2);
  });

  it("truncated_to_n is 0 when all results fit", () => {
    const r = composeRecallResponse(
      [{ source: "spine", results: [result("spine", "s1")] }],
      10,
    );
    expect(r.truncated_to_n).toBe(0);
  });

  it("searched_sources reports the input sources verbatim", () => {
    const r = composeRecallResponse(
      [
        { source: "spine", results: [] },
        { source: "audit", results: [] },
        { source: "listings", results: [] },
      ],
      10,
    );
    expect(r.searched_sources).toEqual(["spine", "audit", "listings"]);
  });

  it("handles all-empty sources cleanly", () => {
    const r = composeRecallResponse([
      { source: "spine", results: [] },
      { source: "audit", results: [] },
    ]);
    expect(r.results).toEqual([]);
    expect(r.truncated_to_n).toBe(0);
  });
});

// ────────────── recall orchestration ──────────────

describe("recall — orchestration with DI stubs", () => {
  function stubDeps(): RecallDeps {
    return {
      fetchSpineRecords: vi.fn().mockResolvedValue([
        {
          id: "recSPINE1",
          fields: {
            fldkeMrHBhx4X8aml: "Maverick spec amendment",
            fld36Jlm4Fo4vLG1L: "2026-05-15",
            fldajtCDNGYjsnGBR: "Maverick is the orchestrator",
          },
        },
      ]),
      fetchAuditEvents: vi.fn().mockResolvedValue([
        { ts: "2026-05-15T18:00:00Z", agent: "maverick", event: "load_state", status: "confirmed_success" },
      ]),
      fetchListings: vi.fn().mockResolvedValue([]),
      fetchDeals: vi.fn().mockResolvedValue([]),
    };
  }

  it("defaults to ['spine', 'audit'] when sources is omitted", async () => {
    const deps = stubDeps();
    const r = await recall({ query: "maverick" }, deps);
    expect(deps.fetchSpineRecords).toHaveBeenCalledTimes(1);
    expect(deps.fetchAuditEvents).toHaveBeenCalledTimes(1);
    expect(deps.fetchListings).not.toHaveBeenCalled();
    expect(deps.fetchDeals).not.toHaveBeenCalled();
    expect(r.searched_sources).toEqual(["spine", "audit"]);
  });

  it("queries every requested source", async () => {
    const deps = stubDeps();
    await recall({ query: "x", sources: ["spine", "audit", "listings", "deals"] }, deps);
    expect(deps.fetchSpineRecords).toHaveBeenCalled();
    expect(deps.fetchAuditEvents).toHaveBeenCalled();
    expect(deps.fetchListings).toHaveBeenCalled();
    expect(deps.fetchDeals).toHaveBeenCalled();
  });

  it("degrades gracefully when a single source throws", async () => {
    const deps = stubDeps();
    deps.fetchSpineRecords = vi.fn().mockRejectedValue(new Error("Airtable down"));
    const r = await recall({ query: "maverick" }, deps);
    // Audit still returns results; spine returns empty.
    expect(r.results.some((x) => x.source === "audit")).toBe(true);
    expect(r.results.some((x) => x.source === "spine")).toBe(false);
  });

  it("threads since + until to the spine fetcher (server-side date pre-filter)", async () => {
    const deps = stubDeps();
    await recall(
      { query: "x", since: "2026-05-01T00:00:00Z", until: "2026-05-15T00:00:00Z" },
      deps,
    );
    expect(deps.fetchSpineRecords).toHaveBeenCalledWith(
      "2026-05-01T00:00:00Z",
      "2026-05-15T00:00:00Z",
    );
  });
});
