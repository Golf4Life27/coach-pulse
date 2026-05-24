// Maverick — generates lib/maverick/data/test-counts.json at build time.
// @agent: maverick (Day 2 / Finding 2 — codebase-metadata test_count wiring)
//
// Counts `it(...)` and `test(...)` declarations across every *.test.ts
// file under lib/ + app/. Runs as `prebuild` so Vercel always bundles
// a fresh count into the lambda. ~100ms for the current repo.
//
// Why a grep-counter and not `vitest run --reporter=json`:
//   - The grep counter doesn't require tests to actually pass to
//     produce a count. If CI is red, the briefing should still say
//     "53 tests in suite" not "(unknown)".
//   - Doesn't double build time.
//   - Same accuracy: declaration count == test count for the way
//     this repo writes tests (no dynamic test generation).

import { readFile, readdir, writeFile, mkdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const SCAN_DIRS = ["lib", "app"];
const SKIP_DIRS = new Set(["node_modules", ".next", "out", "build", "coverage", ".vercel"]);

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walk(full);
    } else if (e.isFile() && e.name.endsWith(".test.ts")) {
      yield full;
    }
  }
}

const t0 = Date.now();
let totalTests = 0;
const fileEntries = [];

for (const sub of SCAN_DIRS) {
  for await (const file of walk(join(repoRoot, sub))) {
    const text = await readFile(file, "utf-8");
    // Match `it("...` and `test("...` declarations at the start of
    // a line (modulo whitespace). Avoids false positives in describe
    // bodies that mention "test" or "it" in code comments.
    const itMatches = text.match(/^\s*it\s*\(/gm) ?? [];
    const testMatches = text.match(/^\s*test\s*\(/gm) ?? [];
    const count = itMatches.length + testMatches.length;
    totalTests += count;
    fileEntries.push({ path: relative(repoRoot, file), count });
  }
}

const outDir = join(repoRoot, "lib", "maverick", "data");
await mkdir(outDir, { recursive: true });
const outFile = join(outDir, "test-counts.json");

const payload = {
  count: totalTests,
  test_files: fileEntries.length,
  generated_at: new Date().toISOString(),
  by_file: fileEntries.sort((a, b) => a.path.localeCompare(b.path)),
};

await writeFile(outFile, JSON.stringify(payload, null, 2) + "\n");

const ms = Date.now() - t0;
console.log(
  `[gen-test-count] ${totalTests} tests across ${fileEntries.length} files → ${relative(repoRoot, outFile)} (${ms}ms)`,
);
