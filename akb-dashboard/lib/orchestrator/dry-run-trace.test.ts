// Smoke test + trace runner for the single-property dry-run harness
// (CONVEYOR Milestone 1). This is the "is the pipeline alive" seed check:
// future changes that silently break the trace must fail here.
//
// It asserts, against THREE committed real-record fixtures:
//   - ZERO external API calls (globalThis.fetch is stubbed to THROW; the
//     harness must never reach it), ZERO Airtable writes, ZERO sends.
//   - all five gates evaluate, each with per-item decisions present;
//   - an opener amount is computed with a basis;
//   - a one-line verdict renders.
// It also pins a handful of known decisions (drift guard) and prints each
// formatted trace so `npm test` doubles as the on-demand eyeball.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { traceListing, type DryRunTrace } from "./dry-run-trace";
import { formatTrace } from "./dry-run-format";
import type { Listing } from "@/lib/types";

const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
// Pin the clock so the freshness-age check (PO-02) is deterministic.
const FIXED_NOW = new Date("2026-06-16T12:00:00.000Z");

interface Fixture {
  recordId: string;
  listing: Listing;
  storedOpener: { roughOpenerAmount: number | null; openerBasis: string | null };
}

function loadFixtures(): Fixture[] {
  return readdirSync(FIX_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const j = JSON.parse(readFileSync(join(FIX_DIR, f), "utf8"));
      return { recordId: j.recordId, listing: j.listing as Listing, storedOpener: j.storedOpener };
    })
    .sort((a, b) => a.recordId.localeCompare(b.recordId));
}

describe("dry-run-trace harness (CONVEYOR Milestone 1)", () => {
  const fixtures = loadFixtures();
  let fetchSpy: ReturnType<typeof vi.fn>;
  let origFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    // Any network attempt during a dry-run is a bug — make it explode.
    origFetch = globalThis.fetch;
    fetchSpy = vi.fn(() => {
      throw new Error("NETWORK BLOCKED: the dry-run harness must make zero external calls");
    });
    (globalThis as { fetch?: unknown }).fetch = fetchSpy;
  });

  afterEach(() => {
    (globalThis as { fetch?: unknown }).fetch = origFetch;
    vi.useRealTimers();
  });

  it("loads at least three real-record fixtures", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(3);
  });

  for (const fx of fixtures) {
    it(`${fx.recordId}: zero external calls / writes / sends, gates + opener present`, () => {
      const trace: DryRunTrace = traceListing({
        recordId: fx.recordId,
        listing: fx.listing,
        now: FIXED_NOW,
      });

      // ── PROOF OF SAFETY ──────────────────────────────────────────────
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(trace.safety.fetch_calls_during_trace).toBe(0);
      expect(trace.safety.airtable_writes).toBe(0);
      expect(trace.safety.sends).toBe(0);

      // ── Gate decisions present, in order ─────────────────────────────
      expect(trace.gates).toHaveLength(5);
      expect(trace.gates.map((g) => g.gate_id)).toEqual([
        "pre_outreach",
        "pre_send",
        "pre_negotiation",
        "pre_contract",
        "pre_emd",
      ]);
      for (const g of trace.gates) {
        expect(g.items.length).toBeGreaterThan(0);
        for (const item of g.items) {
          expect(["pass", "fail", "data_missing", "warning"]).toContain(item.status);
        }
      }

      // ── Opener computed ──────────────────────────────────────────────
      expect(typeof trace.opener.recomputed.opener).toBe("number");
      expect(trace.opener.recomputed.basisLabel.length).toBeGreaterThan(0);
      expect(trace.opener.inputs.seed).toContain("MOCKED");

      // ── Verdict + readable render ────────────────────────────────────
      expect(trace.verdict.length).toBeGreaterThan(0);
      const text = formatTrace(trace);
      expect(text).toContain("DRY-RUN TRACE");
      expect(text).toContain("VERDICT");
      // Surface the trace in test output (the on-demand eyeball).
      // eslint-disable-next-line no-console
      console.log("\n" + text + "\n");
    });
  }

  it("drift guard — pins known gate + opener decisions for the three records", () => {
    const byId = Object.fromEntries(
      fixtures.map((f) => [f.recordId, traceListing({ recordId: f.recordId, listing: f.listing, now: FIXED_NOW })]),
    ) as Record<string, DryRunTrace>;

    // rec00 — San Antonio TX, missing Live_Status/MLS_Status. Pre-Outreach
    // blocks on PO-01 (MLS_Status unset). No ARV → flat 65% of list.
    const r00 = byId["rec00IPPd92pEKnbl"];
    expect(r00.gates[0].overall_status).toBe("fail");
    expect(r00.gates[0].stopped_by?.item_id).toBe("PO-01");
    expect(r00.opener.recomputed.basisLabel).toBe("list_fraction_65");
    expect(r00.opener.recomputed.opener).toBe(Math.round(179000 * 0.65)); // 116350

    // rec02 — Detroit, Real_ARV_Median 83,975 < list 99,900 → ARV-sanity
    // gate distrusts it and drops to flat 65%.
    const r02 = byId["rec02SiPx4WVUOrgW"];
    expect(r02.opener.recomputed.arvDistrusted).toBe(true);
    expect(r02.opener.recomputed.basisLabel).toBe("list_fraction_65");
    expect(r02.opener.recomputed.opener).toBe(Math.round(99900 * 0.65)); // 64935

    // rec07 — Detroit, fresh verify + MLS ACTIVE → clears Pre-Outreach and
    // reaches Pre-Send, where it stops on PS-01 (ARV_Validated_At unset).
    // ARV 99,672 > list 79,000 is sane, but the buy-box ceiling pencils below
    // the low-opener floor → routed to flat 65% ($51,350).
    const r07 = byId["rec07YAC9KOwr6iZv"];
    expect(r07.gates[0].overall_status).toBe("pass");
    expect(r07.gates[1].gate_id).toBe("pre_send");
    expect(r07.gates[1].reached).toBe(true);
    expect(r07.gates[1].overall_status).toBe("fail");
    expect(r07.gates[1].stopped_by?.item_id).toBe("PS-01");
    expect(r07.opener.recomputed.flooredToFallback).toBe(true);
    expect(r07.opener.recomputed.opener).toBe(Math.round(79000 * 0.65)); // 51350
  });
});
