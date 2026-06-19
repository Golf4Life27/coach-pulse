// ARV Comp Engine — Detroit WATCHED RUN (CONVEYOR Milestone 3, deliverable C).
// Runs the engine over the real with-ARV records against the real Detroit
// seeds and prints the decision table for operator review. WATCHED = computes
// + traces, writes NOTHING (proven: zero network during the synchronous run).
// Flip ARV_ENGINE_AUTOCOMPLETE_LIVE=true only after reviewing this.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateArvFromSeed, isArvEngineAutocompleteLive, type ArvSubject } from "./arv-comp-engine";
import type { ZipArvSeed } from "@/lib/zip-arv-seed-store";
import { proveNoNetwork } from "./dry-run-trace";

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = new Date("2026-06-16T12:00:00.000Z");

function loadSeeds(): Map<string, ZipArvSeed> {
  const raw = JSON.parse(readFileSync(join(HERE, "__fixtures__", "arv-engine", "detroit-seeds.json"), "utf8")).seeds;
  const m = new Map<string, ZipArvSeed>();
  for (const s of raw) {
    m.set(s.zip, { zip: s.zip, renovatedPerSqft: s.renovatedPerSqft, arvLowPerSqft: s.arvLowPerSqft, compCount: s.compCount, confidence: s.confidence, dontPrice: s.dontPrice, source: s.source, market: "detroit_mi", state: "MI", fetchedAt: s.fetchedAt, receiptsJson: null, recordId: "seed:" + s.zip });
  }
  return m;
}

// Reuse the M1.5 evidence cohort (real records, zip + sqft). They are the
// SFR-filtered pipeline, so property class = Single Family.
function loadSubjects(): ArvSubject[] {
  const recs = JSON.parse(readFileSync(join(HERE, "..", "..", "lib", "pricing", "__evidence__", "arv-records-2026-06-16.json"), "utf8")).records;
  return recs.map((r: { id: string; f: Record<string, number | string> }) => ({
    recordId: r.id,
    zip: String(r.f["fld9PTaKkgBNtvWbB"] ?? ""),
    sqft: typeof r.f["fld5bKGJLlN7GmiE9"] === "number" ? (r.f["fld5bKGJLlN7GmiE9"] as number) : null,
    propertyType: "Single Family",
  }));
}

describe("ARV engine — Detroit watched run (deliverable C)", () => {
  it("computes a decision per subject and WRITES NOTHING (zero network)", () => {
    const seeds = loadSeeds();
    const subjects = loadSubjects();

    const { value: rows, fetchCalls } = proveNoNetwork(() =>
      subjects.map((s) => evaluateArvFromSeed(s, s.zip ? seeds.get(s.zip) ?? null : null, NOW)),
    );

    // WATCHED MODE PROOF: nothing was written and no network touched.
    expect(fetchCalls).toBe(0);
    expect(isArvEngineAutocompleteLive()).toBe(false);

    const tally = { VALIDATED: 0, ESCALATE: 0, BLOCKED: 0 } as Record<string, number>;
    for (const r of rows) tally[r.decision]++;

    const lines: string[] = [];
    lines.push("\n══════════ ARV ENGINE — DETROIT WATCHED RUN (zero writes) ══════════");
    lines.push(`Subjects: ${rows.length} real records · seeds: 18 Detroit ZIPs · anchor n/a · now ${NOW.toISOString()}`);
    lines.push(`DECISIONS: VALIDATED ${tally.VALIDATED} · ESCALATE ${tally.ESCALATE} · BLOCKED ${tally.BLOCKED}`);
    lines.push("");
    lines.push("  recordId           | zip   | tier       | comps | sqft  | ARV(low-end) | conf | decision");
    for (const r of rows) {
      lines.push(
        `  ${(r.recordId ?? "").padEnd(18)} | ${(r.zip ?? "").padEnd(5)} | ${r.seedTier.padEnd(10)} | ${String(r.compCount ?? "-").padStart(5)} | ${String(r.sqft ?? "-").padStart(5)} | ${String(r.engineArv ?? "-").padStart(12)} | ${(r.confidence ?? "-").padEnd(4)} | ${r.decision}`,
      );
    }
    lines.push("════════════════════════════════════════════════════════════════════\n");
    // eslint-disable-next-line no-console
    console.log(lines.join("\n"));

    expect(tally.VALIDATED + tally.ESCALATE + tally.BLOCKED).toBe(rows.length);
    // The whole point of M3: at least some real records now auto-validate DD-1.
    expect(tally.VALIDATED).toBeGreaterThan(0);
  });
});
