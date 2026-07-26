import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Doctrine-wiring integrity test.
//
// The worst recurring bug class in this repo is "doctrine module built and
// tested but never called by live code" — it happened to lib/lowball-eligibility.ts
// and to a renovation-language detector before that. A module can have full
// unit-test coverage and still never fire in production if nothing on a live
// request path imports it (directly or transitively).
//
// This test statically scans the import graph (regex-based, @/ alias aware,
// dependency-free) and fails if a REGISTERED doctrine module is not
// transitively reachable from at least one live app surface — any file under
// app/ that is NOT under app/api/admin/ (admin-only preview/dry-run routes
// don't count as "live").
//
// Honesty rule: if a registered module genuinely isn't wired in today, it
// goes in KNOWN_UNWIRED with a TODO, not silently dropped from the registry.
// That keeps the debt visible while still letting the suite pass, and any
// NEW module that goes unwired will fail this test immediately.
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, "..");
const APP_DIR = path.join(ROOT, "app");
const LIB_DIR = path.join(ROOT, "lib");

// Doctrine modules that must be reachable from live code.
// One line each: path + why it matters.
const REGISTRY: Array<{ modulePath: string; reason: string }> = [
  { modulePath: "lib/lowball-eligibility.ts", reason: "gates lowball opener eligibility before an offer is sent" },
  { modulePath: "lib/outreach/send-gate.ts", reason: "the single choke point every outbound SMS must pass through" },
  { modulePath: "lib/lowball-signals.ts", reason: "shared distress-signal mappers — preview and live must use one implementation" },
  { modulePath: "lib/opener-sanity-gate.ts", reason: "corroborates opener price sanity before it reaches a seller" },
  { modulePath: "lib/markets/actionable.ts", reason: "decides whether a market is actionable/priceable at all" },
  { modulePath: "lib/comp-adjustment.ts", reason: "adjusts comps into the ARV band used for pricing" },
  { modulePath: "lib/conversation-thread.ts", reason: "selects/opens the correct outreach thread for a listing" },
  { modulePath: "lib/per-market-pricer.ts", reason: "computes the market-specific offer floor/ceiling" },
  { modulePath: "lib/rough-opener-ceiling.ts", reason: "caps the rough opener before it's finalized" },
  { modulePath: "lib/pricing/mao-flip.ts", reason: "two-lane MAO flip-offer ceiling under the pricing doctrine" },
];

// Modules known, TODAY, to not be reachable from a live (non-admin) surface.
// Do NOT add to this list to make a failure go away — that defeats the
// purpose of the test. Only add here when the gap is real, tracked, and
// intentionally left visible instead of silently dropped from REGISTRY.
const KNOWN_UNWIRED: Record<string, string> = {
};

const CODE_EXT = [".ts", ".tsx"];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      walk(full, out);
    } else if (CODE_EXT.includes(path.extname(entry.name)) && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".test.tsx")) {
      out.push(full);
    }
  }
  return out;
}

const allFiles = [...walk(APP_DIR), ...walk(LIB_DIR)];

// Resolve an import specifier (relative or @/-aliased) to an absolute file
// path in allFiles, or null if it's an external package / unresolved.
function resolveImport(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".") && !spec.startsWith("@/")) return null; // external package

  let base: string;
  if (spec.startsWith("@/")) {
    base = path.join(ROOT, spec.slice(2));
  } else {
    base = path.resolve(path.dirname(fromFile), spec);
  }

  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
    path.join(base, "route.ts"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

const IMPORT_RE = /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?from\s+)?["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)/g;

function extractImports(file: string): string[] {
  const src = fs.readFileSync(file, "utf8");
  const specs: string[] = [];
  let m: RegExpExecArray | null;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(src))) {
    const spec = m[1] ?? m[2];
    if (spec) specs.push(spec);
  }
  return specs;
}

// Build adjacency: file -> resolved imported files.
const graph = new Map<string, string[]>();
for (const file of allFiles) {
  const resolved = extractImports(file)
    .map((spec) => resolveImport(file, spec))
    .filter((f): f is string => f !== null);
  graph.set(file, resolved);
}

function isLiveAppFile(file: string): boolean {
  const rel = path.relative(APP_DIR, file);
  if (rel.startsWith("..")) return false; // not under app/
  return !rel.startsWith(`api${path.sep}admin${path.sep}`) && rel !== `api${path.sep}admin`;
}

const liveAppFiles = allFiles.filter(isLiveAppFile);

// Reachability: BFS forward from every live app file, collect every file
// reachable via imports.
function reachableFrom(starts: string[]): Set<string> {
  const seen = new Set<string>(starts);
  const queue = [...starts];
  while (queue.length) {
    const cur = queue.pop()!;
    for (const next of graph.get(cur) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

const reachableFromLive = reachableFrom(liveAppFiles);

describe("doctrine-wiring integrity", () => {
  it("sanity: the import graph actually found live app files and lib modules", () => {
    expect(liveAppFiles.length).toBeGreaterThan(0);
    expect(allFiles.length).toBeGreaterThan(50);
  });

  for (const { modulePath, reason } of REGISTRY) {
    const absPath = path.join(ROOT, modulePath);
    const known = KNOWN_UNWIRED[modulePath];

    it(`${modulePath} — ${reason}${known ? " [KNOWN_UNWIRED]" : ""}`, () => {
      expect(fs.existsSync(absPath), `registered doctrine module missing on disk: ${modulePath}`).toBe(true);

      const wired = reachableFromLive.has(absPath);

      if (known) {
        // Debt is visible and tracked — don't let it silently disappear:
        // fail loudly the day it becomes wired so the TODO gets removed,
        // and otherwise just confirm the gap still exists (not masked).
        expect(
          wired,
          `${modulePath} is now reachable from live code — remove it from KNOWN_UNWIRED in doctrine-wiring.test.ts`,
        ).toBe(false);
        return;
      }

      expect(
        wired,
        `${modulePath} (${reason}) is NOT reachable from any live app/ surface (excluding app/api/admin/). ` +
          `Either wire it into a live path, or — only if the gap is real and intentional — add it to ` +
          `KNOWN_UNWIRED with a TODO explaining why.`,
      ).toBe(true);
    });
  }

  it("KNOWN_UNWIRED only lists modules that are actually registered", () => {
    for (const key of Object.keys(KNOWN_UNWIRED)) {
      expect(REGISTRY.some((r) => r.modulePath === key), `KNOWN_UNWIRED entry ${key} is not in REGISTRY`).toBe(true);
    }
  });
});
