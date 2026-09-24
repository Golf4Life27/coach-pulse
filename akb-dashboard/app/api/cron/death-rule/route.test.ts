import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";
import type { Listing } from "@/lib/types";

vi.mock("@/lib/send-route-auth", () => ({
  requireSendAuth: vi.fn(async () => ({ ok: true as const, authKind: "test" })),
}));

let fixtureListings: Listing[] = [];
const getListingsMock = vi.fn(async (..._args: []) => fixtureListings);
const updateListingRecordMock = vi.fn(async (..._args: [string, Record<string, unknown>]) => [] as unknown[]);
const getListingMock = vi.fn(async (..._args: [string]) => null as unknown);

vi.mock("@/lib/airtable", () => ({
  getListings: (...args: []) => getListingsMock(...args),
  updateListingRecord: (...args: [string, Record<string, unknown>]) => updateListingRecordMock(...args),
  getListing: (...args: [string]) => getListingMock(...args),
}));

const upsertOperatorActionsMock = vi.fn(async (_kv: unknown, cards: Array<{ id: string }>) => ({ total: cards.length }));
vi.mock("@/lib/maverick/operator-actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/maverick/operator-actions")>();
  return {
    ...actual,
    upsertOperatorActions: (...args: [unknown, Array<{ id: string }>]) => upsertOperatorActionsMock(...args),
  };
});

vi.mock("@/lib/maverick/oauth/kv", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/maverick/oauth/kv")>();
  return { ...actual, kvConfigured: () => true, kvProd: actual.makeMemoryKv() };
});

vi.mock("@/lib/audit-log", () => ({ audit: vi.fn(async () => {}) }));

import { requireSendAuth } from "@/lib/send-route-auth";

const NOW = new Date("2026-09-24T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

function mkListing(overrides: Partial<Listing> = {}): Listing {
  return {
    id: "recTest0000000001",
    address: "1 Test St",
    city: "Detroit",
    zip: "48201",
    listPrice: null,
    mao: null,
    dom: null,
    offerTier: null,
    liveStatus: null,
    executionPath: null,
    outreachStatus: "Negotiating",
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
    yearBuilt: null,
    portfolioDetected: false,
    stageCalc: null,
    approvedForOutreach: true,
    flipScore: null,
    offMarketOverride: false,
    restrictionText: null,
    ddChecklist: null,
    doNotText: false,
    state: "MI",
    sourceVersion: null,
    actionHoldUntil: null,
    actionCardState: null,
    lastInboundAt: null,
    lastOutboundAt: null,
    contractExecutedAt: null,
    ...overrides,
  } as Listing;
}

describe("GET/POST /api/cron/death-rule", () => {
  beforeEach(() => {
    vi.mocked(requireSendAuth).mockResolvedValue({ ok: true, authKind: "test" });
    getListingsMock.mockClear();
    updateListingRecordMock.mockClear();
    getListingMock.mockClear();
    upsertOperatorActionsMock.mockClear();
    fixtureListings = [];
  });

  it("401s when the auth waterfall refuses", async () => {
    vi.mocked(requireSendAuth).mockResolvedValueOnce({
      ok: false,
      response: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    });
    const { GET } = await import("./route");
    const res = await GET(new Request("https://x/api/cron/death-rule"));
    expect(res.status).toBe(401);
    expect(getListingsMock).not.toHaveBeenCalled();
  });

  it("dry run (no apply param) reports the would-kill list and writes nothing", async () => {
    fixtureListings = [
      mkListing({ id: "recDead1", address: "10 Silent Ave", lastInboundAt: daysAgo(20) }),
      mkListing({ id: "recAlive1", address: "20 Fresh Ave", lastInboundAt: daysAgo(2) }),
      mkListing({
        id: "recExec1",
        address: "30 Signed Ave",
        lastInboundAt: daysAgo(40),
        contractExecutedAt: "2026-08-01",
      }),
    ];
    const { GET } = await import("./route");
    const res = await GET(new Request("https://x/api/cron/death-rule"));
    const body = await res.json();

    expect(body.apply).toBe(false);
    expect(body.would_kill).toBe(1);
    expect(body.would_kill_records[0]).toMatchObject({ id: "recDead1", address: "10 Silent Ave" });
    expect(body.executed_needs_termination_card).toBe(1);
    expect(body.counterparty_contact_last_14_days).toBe(1); // only recAlive1 (2d ago)

    // Nothing was written.
    expect(updateListingRecordMock).not.toHaveBeenCalled();
    expect(upsertOperatorActionsMock).not.toHaveBeenCalled();
  });

  it("?dry_run=1 behaves exactly like the bare default — still writes nothing", async () => {
    fixtureListings = [mkListing({ id: "recDead2", lastInboundAt: daysAgo(15) })];
    const { GET } = await import("./route");
    const res = await GET(new Request("https://x/api/cron/death-rule?dry_run=1"));
    const body = await res.json();
    expect(body.apply).toBe(false);
    expect(body.would_kill).toBe(1);
    expect(updateListingRecordMock).not.toHaveBeenCalled();
  });

  it("?apply=1 kills via the helper and upserts one termination card per executed record", async () => {
    fixtureListings = [
      mkListing({ id: "recDead3", address: "40 Silent Ave", notes: "old note", lastInboundAt: daysAgo(20) }),
      mkListing({
        id: "recExec2",
        address: "50 Signed Ave",
        lastInboundAt: daysAgo(40),
        contractExecutedAt: "2026-08-01",
      }),
    ];
    const { GET } = await import("./route");
    const res = await GET(new Request("https://x/api/cron/death-rule?apply=1"));
    const body = await res.json();

    expect(body.apply).toBe(true);
    expect(body.killed).toBe(1);
    expect(updateListingRecordMock).toHaveBeenCalledTimes(1);
    expect(updateListingRecordMock.mock.calls[0]![0]).toBe("recDead3");
    expect(updateListingRecordMock.mock.calls[0]![1]).toMatchObject({ Outreach_Status: "Dead" });

    expect(upsertOperatorActionsMock).toHaveBeenCalledTimes(1);
    const cards = upsertOperatorActionsMock.mock.calls[0]![1];
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe("termination-recExec2");
    expect(body.termination_cards_upserted).toBe(1);
  });

  it("?apply=1 never writes for an already-Dead or never-engaged record", async () => {
    fixtureListings = [
      mkListing({ id: "recAlreadyDead", outreachStatus: "Dead", lastInboundAt: daysAgo(90) }),
      mkListing({ id: "recColdRecord", outreachStatus: "Texted", lastInboundAt: null }),
    ];
    const { GET } = await import("./route");
    const res = await GET(new Request("https://x/api/cron/death-rule?apply=1"));
    const body = await res.json();
    expect(body.would_kill).toBe(0);
    expect(body.killed).toBe(0);
    expect(updateListingRecordMock).not.toHaveBeenCalled();
  });
});
