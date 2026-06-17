// CONVEYOR Milestone 5 — Buyer Intelligence ingestion + Buyer_Median.
//
// NOTE ON DATA: the 4 real InvestorBase CSV exports (704 rows) were NOT
// available in this environment (no CSV anywhere on disk; only the directive
// .md files). So the documented real-fixture assertions (landlord-acq ≈ $46k,
// flipper-acq ≈ $47k, flipper-resale ≈ $122.75k aggregate, and per-ZIP medians)
// are proven here on a SYNTHETIC dataset DESIGNED to reproduce the documented
// shapes + per-ZIP example numbers (48205 ≈ $42.5k, 48219 ≈ $62k). When the
// real CSVs are dropped in, parseInvestorBaseCsv ingests the 30-col schema and
// the same engine runs unchanged.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseInvestorBaseCsv,
  rowToTransaction,
  acquisitionPriceOf,
  parsePrice,
  type BuyerTransaction,
} from "./csv-parse";
import {
  computeBuyerMedian,
  computeResaleMedian,
  naiveMostRecentMedianAllRows,
  perZipMedianTable,
  BUYER_MEDIAN_MIN_N,
} from "./buyer-median";
import { mergeTransactions, ingestInvestorBaseCsv } from "./ingest";
import { evaluatePreEmdGate } from "@/lib/orchestrator/pre-emd-gate";
import { proveNoNetwork } from "@/lib/orchestrator/dry-run-trace";

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE = readFileSync(join(HERE, "__fixtures__", "investorbase-sample.csv"), "utf8");

// ── Synthetic dataset designed to match the documented per-ZIP numbers ──
function symmetricOdd(median: number, n: number, step = 1000): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(median + (i - (n - 1) / 2) * step);
  return out;
}
function mkRow(entity: string, type: string, zip: string, mostRecent: number | "", prior: number | "", addr: string): Record<string, unknown> {
  return {
    "Entity Name": entity, "Buyer Type": type, "Zip": zip, "Address": addr,
    "Most Recent Sale Price": mostRecent === "" ? "" : `$${mostRecent.toLocaleString()}`,
    "Prior Sale Price": prior === "" ? "" : `$${prior.toLocaleString()}`,
    "Most Recent Sale Date": "2026-05-01",
  };
}
function synthetic(): BuyerTransaction[] {
  const rows: Record<string, unknown>[] = [];
  // 48205 landlord acquisitions median $42,500 (Most Recent), n=21.
  symmetricOdd(42500, 21).forEach((p, i) => rows.push(mkRow(`L205_${i}`, "Landlord", "48205", p, 25000, `${i} A St`)));
  // 48205 flipper acq (Prior) median $47,100; resale (Most Recent) median $122,750, n=21.
  symmetricOdd(47100, 21).forEach((acq, i) => rows.push(mkRow(`F205_${i}`, "Flipper", "48205", symmetricOdd(122750, 21)[i], acq, `${i} B St`)));
  // 48219 landlord acquisitions median $62,000, n=21.
  symmetricOdd(62000, 21).forEach((p, i) => rows.push(mkRow(`L219_${i}`, "Landlord", "48219", p, 30000, `${i} C St`)));
  // 48999 — thin: only 5 landlord rows → INSUFFICIENT.
  symmetricOdd(46000, 5).forEach((p, i) => rows.push(mkRow(`L999_${i}`, "Landlord", "48999", p, 20000, `${i} D St`)));
  return rows.map(rowToTransaction);
}

describe("M5 Part 1 — InvestorBase CSV parse + the acquisition rule (the trap)", () => {
  const txns = parseInvestorBaseCsv(SAMPLE);

  it("parses the 30-column schema; excludes untracked + no-price rows", () => {
    // 8 data rows; the iBuyer row (untracked) and the no-price landlord row are
    // present as transactions but carry no acquisition price.
    expect(txns.length).toBeGreaterThanOrEqual(6);
    expect(txns.find((t) => t.entityName === "SYNTHETIC IBUYER INC")?.buyerType).toBeNull();
  });

  it("landlord acquisition = Most Recent; flipper acquisition = Prior; flipper resale = Most Recent", () => {
    const landlord = txns.find((t) => t.entityName === "SYNTHETIC HOLDINGS LLC")!;
    expect(landlord.buyerType).toBe("landlord");
    expect(landlord.acquisitionPrice).toBe(42500); // Most Recent
    expect(landlord.resalePrice).toBeNull();

    const flipper = txns.find((t) => t.entityName === "SYNTHETIC FLIP2 LLC")!;
    expect(flipper.buyerType).toBe("flipper");
    expect(flipper.acquisitionPrice).toBe(46000); // Prior ("$46,000" parsed)
    expect(flipper.resalePrice).toBe(125000); // Most Recent = resale, NEVER an acquisition
  });

  it("a no-price row yields NO acquisition (excluded, never zero-filled)", () => {
    const noPrice = txns.find((t) => t.entityName === "SYNTHETIC NOPRICE LLC")!;
    expect(noPrice.acquisitionPrice).toBeNull();
    expect(parsePrice("")).toBeNull();
    expect(parsePrice("-")).toBeNull();
    expect(parsePrice("$0")).toBeNull();
    // the rule itself: flipper Most Recent is never the acquisition.
    expect(acquisitionPriceOf("flipper", 120000, 47000)).toBe(47000);
    expect(acquisitionPriceOf("landlord", 42500, 30000)).toBe(42500);
  });
});

describe("M5 Part 2 — Buyer_Median per ZIP/track, the trap, min-n, fail-closed", () => {
  const txns = synthetic();

  it("per-ZIP/track ACQUISITION medians (synthetic, matching the documented examples)", () => {
    expect(computeBuyerMedian(txns, "48205", "landlord").median).toBe(42500); // ≈ doc $42.5k
    expect(computeBuyerMedian(txns, "48219", "landlord").median).toBe(62000); // ≈ doc $62k
    expect(computeBuyerMedian(txns, "48205", "flipper").median).toBe(47100); // ≈ doc flipper-acq $47k
    expect(computeResaleMedian(txns, "48205").median).toBe(122750); // ≈ doc flipper-resale $122.75k
  });

  it("THE TRAP: the naive all-rows Most Recent median is NEVER what DD-3 consumes", () => {
    const naive = naiveMostRecentMedianAllRows(txns); // the blended (wrong) number
    expect(naive).not.toBeNull();
    // the engine's per-track acquisition medians are the DD-3 inputs — and none
    // of them is the naive blend.
    expect(computeBuyerMedian(txns, "48205", "landlord").median).not.toBe(naive);
    expect(computeBuyerMedian(txns, "48205", "flipper").median).not.toBe(naive);
    expect(computeBuyerMedian(txns, "48219", "landlord").median).not.toBe(naive);
    // flipper resale (Most Recent) is the only thing that COULD equal the blend
    // for an all-flipper ZIP — but it is kept as resale, never an acquisition.
    expect(computeResaleMedian(txns, "48205").median).not.toBe(computeBuyerMedian(txns, "48205", "flipper").median);
  });

  it("min-n gate: a thin ZIP/track (n<20) → INSUFFICIENT, never a median", () => {
    const r = computeBuyerMedian(txns, "48999", "landlord");
    expect(r.status).toBe("INSUFFICIENT");
    expect(r.median).toBeNull();
    expect(r.n).toBe(5);
    expect(BUYER_MEDIAN_MIN_N).toBe(20);
    // a ZIP with no data at all → INSUFFICIENT (fail-closed).
    expect(computeBuyerMedian(txns, "00000", "landlord").status).toBe("INSUFFICIENT");
  });
});

describe("M5 Part 1 — idempotent ingest (dedup on entity+address+date)", () => {
  it("re-ingesting the same export does not double-count", () => {
    const first = parseInvestorBaseCsv(SAMPLE);
    const remerge = mergeTransactions(first, parseInvestorBaseCsv(SAMPLE));
    expect(remerge.added).toBe(0); // every row already present
    expect(remerge.merged.length).toBe(first.length);
    // ingest summary in watched mode writes nothing.
    const { summary } = ingestInvestorBaseCsv(SAMPLE);
    expect(summary.written).toBe(0);
    expect(summary.watched).toBe(true);
  });
});

describe("M5 Part 3 — DD-3 consumes Buyer_Median; INSUFFICIENT → BLOCKED", () => {
  it("INSUFFICIENT (n<20) → DD-3 BLOCKED with the manual-review reason", () => {
    const r = evaluatePreEmdGate({ recordId: "r", buyerMedianStatus: "INSUFFICIENT", buyerMedianN: 7 });
    const dd3 = r.checks.find((c) => c.id === "DD-3")!;
    expect(dd3.status).toBe("BLOCKED");
    expect(dd3.reason).toMatch(/insufficient.*manual review/i);
    expect(r.blocked).toContain("DD-3");
  });

  it("a real median (OK) → DD-3 passes", () => {
    const r = evaluatePreEmdGate({ recordId: "r", buyerMedian: 62000, buyerMedianStatus: "OK", buyerMedianN: 21 });
    expect(r.checks.find((c) => c.id === "DD-3")!.status).toBe("pass");
  });
});

describe("M5 — watched run (per-ZIP median table, zero writes)", () => {
  it("computes a per-ZIP/track table and writes nothing", () => {
    const txns = synthetic();
    const { value: table, fetchCalls } = proveNoNetwork(() => perZipMedianTable(txns));
    expect(fetchCalls).toBe(0);

    const lines = ["\n──── BUYER_MEDIAN WATCHED RUN (synthetic; zero writes) ────",
      "  zip   | landlord(acq)        | flipper(acq)         | resale(ARV)"];
    for (const row of table) {
      const f = (r: { status: string; median: number | null; n: number }) =>
        (r.status === "OK" ? `$${r.median!.toLocaleString()} (n=${r.n})` : `INSUFFICIENT (n=${r.n})`).padEnd(20);
      lines.push(`  ${row.zip} | ${f(row.landlord)} | ${f(row.flipper)} | ${f(row.resale)}`);
    }
    // eslint-disable-next-line no-console
    console.log(lines.join("\n") + "\n");

    expect(table.find((r) => r.zip === "48205")!.landlord.median).toBe(42500);
    expect(table.find((r) => r.zip === "48999")!.landlord.status).toBe("INSUFFICIENT");
  });
});
