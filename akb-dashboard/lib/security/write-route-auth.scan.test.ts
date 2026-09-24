// Fails CI when a write-capable app/api route has no auth check.
//
// Scans every app/api/**/route.ts for:
//   - an exported POST / PUT / PATCH / DELETE handler, or
//   - an exported GET handler whose file references an apply-style query
//     flag (apply=1, dry_run, apply_motivation, confirm — the shapes this
//     codebase actually uses to gate a GET-triggered write; see
//     app/api/admin/seed-sweep, app/api/admin/bulk-dead-stale-texted,
//     app/api/sentinel/classify/[recordId] for the three variants),
// and requires the file to reference the shared auth waterfall
// (lib/send-route-auth.ts's requireSendAuth, or the lower-level
// lib/maverick/oauth/auth-waterfall.ts primitives some cron routes call
// inline) — unless the route's path is in WRITE_ROUTE_ALLOWLIST
// (lib/security/write-route-allowlist.ts), which carries a one-line reason
// for every intentional exception.
//
// This is a static scan, not a runtime check: it proves every write route
// at least REFERENCES the guard, not that the guard is called correctly on
// every code path. lib/send-route-auth.test.ts covers the guard's own
// unauthenticated/authenticated behavior.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  WRITE_ROUTE_ALLOWLIST_PATHS,
} from "./write-route-allowlist";

const APP_API_DIR = join(__dirname, "..", "..", "app", "api");

const WRITE_METHOD_RE =
  /export\s+(?:async\s+)?function\s+(POST|PUT|PATCH|DELETE)\s*\(|export\s+const\s+(POST|PUT|PATCH|DELETE)\s*[:=]/g;

const GET_HANDLER_RE = /export\s+(?:async\s+)?function\s+GET\s*\(|export\s+const\s+GET\s*[:=]/;

// The apply-style query-flag shapes this codebase uses to gate a
// GET-triggered write. See the module comment above for concrete examples.
const APPLY_STYLE_FLAG_RE =
  /searchParams\.get\(\s*["'](apply|dry_run|apply_motivation|confirm)["']\s*\)/;

const AUTH_REFERENCE_RE =
  /requireSendAuth|hasDashboardSession|readAuthEnv|authenticate\(|verifySessionValue/;

function findRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      out.push(...findRouteFiles(full));
    } else if (entry === "route.ts") {
      out.push(full);
    }
  }
  return out;
}

function toRoutePath(file: string): string {
  const rel = relative(APP_API_DIR, file);
  return rel.split(sep).slice(0, -1).join("/"); // drop trailing "route.ts"
}

interface ScanTarget {
  routePath: string;
  file: string;
  writeMethods: string[];
  flaggedGet: boolean;
}

function scan(): ScanTarget[] {
  const targets: ScanTarget[] = [];
  for (const file of findRouteFiles(APP_API_DIR)) {
    const src = readFileSync(file, "utf8");
    const writeMethods = new Set<string>();
    let m: RegExpExecArray | null;
    WRITE_METHOD_RE.lastIndex = 0;
    while ((m = WRITE_METHOD_RE.exec(src))) {
      writeMethods.add(m[1] ?? m[2]);
    }
    const flaggedGet = GET_HANDLER_RE.test(src) && APPLY_STYLE_FLAG_RE.test(src);
    if (writeMethods.size > 0 || flaggedGet) {
      targets.push({
        routePath: toRoutePath(file),
        file,
        writeMethods: [...writeMethods],
        flaggedGet,
      });
    }
  }
  return targets;
}

describe("write route auth scan", () => {
  const targets = scan();

  it("found at least one write route to check (sanity — scanner isn't silently matching nothing)", () => {
    expect(targets.length).toBeGreaterThan(10);
  });

  it("every allowlist entry still names a real app/api route", () => {
    const allRoutePaths = new Set(findRouteFiles(APP_API_DIR).map(toRoutePath));
    for (const path of WRITE_ROUTE_ALLOWLIST_PATHS) {
      expect(allRoutePaths.has(path), `allowlist entry "${path}" has no matching app/api/${path}/route.ts`).toBe(true);
    }
  });

  for (const target of targets) {
    const label = `${target.routePath} (${[...target.writeMethods, target.flaggedGet ? "GET+apply-flag" : null].filter(Boolean).join(", ")})`;

    it(`${label} references the auth waterfall, or is allowlisted`, () => {
      if (WRITE_ROUTE_ALLOWLIST_PATHS.has(target.routePath)) {
        // Explicit, documented exception — see write-route-allowlist.ts.
        return;
      }
      const src = readFileSync(target.file, "utf8");
      expect(
        AUTH_REFERENCE_RE.test(src),
        `${target.file} writes (methods: ${target.writeMethods.join(",") || "none"}; flaggedGet: ${target.flaggedGet}) ` +
          `but does not reference requireSendAuth or the auth-waterfall primitives, and is not in ` +
          `WRITE_ROUTE_ALLOWLIST. Add the guard, or add a documented allowlist entry if this is ` +
          `intentionally public.`,
      ).toBe(true);
    });
  }
});
