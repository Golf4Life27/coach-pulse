// OPENER RECEIPT PARITY (2026-08-14, the 1708 Cardinal reverse-engineering).
//
// lib/pricing/opener-derivation.ts was built by the 2026-08-06 audit so that a
// priced record carries the ARITHMETIC, not just the answer — the operator had
// asked what the MAO was on 8235 Prest St and no record could tell him.
//
// The module shipped. Its only CALLER was the intake cron.
//
// So every record priced anywhere else — which is most of the live pipeline,
// because the send path re-prices at send time — kept storing the answer alone.
// 1708 Cardinal Dr texted $63,000 against a $229,900 list, the seller countered
// "165k no more ridiculous offers please", and answering "where did $63,000
// come from?" took four queries and still ended in reverse-engineering: the
// exact failure the receipt field exists to prevent. Pricing doctrine standard
// 1 (recompute-and-match before queueing) is likewise unenforceable against a
// record that kept only the number.
//
// The bug was not the arithmetic. It was that a WRITE SITE could be added
// without the receipt and nothing objected. This test is the objection: any
// file that persists Rough_Opener_Amount must persist Opener_Derivation_JSON
// in the same file. It is deliberately structural rather than behavioral —
// the failure mode is a new call site, not a wrong branch.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const API_ROOT = join(__dirname, "..", "app", "api");

/** Every route.ts under app/api, recursively. */
function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/** A WRITE of the field, not a read.
 *  Matches `Rough_Opener_Amount: x` and `sentFields.Rough_Opener_Amount = x`.
 *  Does NOT match `r.fields["Rough_Opener_Amount"]` or a `"Rough_Opener_Amount",`
 *  entry in a field-name array — both are reads. */
const writesField = (src: string, field: string) =>
  new RegExp(`${field}\\s*[:=]`).test(src);

describe("opener receipt parity — a number is never persisted without its arithmetic", () => {
  const files = routeFiles(API_ROOT);

  it("finds the API routes at all (guards against a silently-empty sweep)", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("every route that writes Rough_Opener_Amount also writes Opener_Derivation_JSON", () => {
    const offenders = files
      .map((f) => ({ f, src: readFileSync(f, "utf8") }))
      .filter(({ src }) => writesField(src, "Rough_Opener_Amount"))
      .filter(({ src }) => !writesField(src, "Opener_Derivation_JSON"))
      .map(({ f }) => f.slice(f.indexOf("app/api")));

    expect(
      offenders,
      `These routes persist an opener with no derivation receipt, so the number ` +
        `cannot be recomputed cold — the 1708 Cardinal failure. Serialize the ` +
        `pricer's derivation (serializeDerivation(pw.derivation)) into ` +
        `Opener_Derivation_JSON in the same write.`,
    ).toEqual([]);
  });

  it("the intake path — the original and formerly ONLY caller — still writes it", () => {
    // Guards the regression in the other direction: this test would pass
    // vacuously if every write site disappeared.
    const intake = files.find((f) => f.includes(join("cron", "listings-intake")));
    expect(intake, "listings-intake route not found").toBeTruthy();
    expect(readFileSync(intake!, "utf8")).toContain("serializeDerivation");
  });

  it("at least three distinct routes now carry the receipt (intake was alone before this fix)", () => {
    const carriers = files.filter((f) =>
      readFileSync(f, "utf8").includes("serializeDerivation"),
    );
    expect(carriers.length).toBeGreaterThanOrEqual(3);
  });
});
