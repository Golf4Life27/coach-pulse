// Table-driven check, per newly-guarded write route (security sweep
// 2026-09-24, execution agenda P0-21, spine recYbAYqkguZSOTeF): calling the
// exported handler with the shared auth helper mocked to REFUSE returns
// 401, and mocked to ALLOW does not return 401.
//
// This intentionally mocks lib/send-route-auth's requireSendAuth rather
// than exercising the real waterfall (that's lib/send-route-auth.test.ts)
// — the point here is narrower: prove every one of these route files
// actually WIRED the guard into its handler and RESPECTS its result,
// rather than merely importing it (lib/security/write-route-auth.scan.test.ts
// checks the "merely importing it" floor statically).
//
// The "allowed" case can fall through into real business logic (Airtable,
// Anthropic, etc.) that has no credentials in this test process. That's
// fine — a thrown error or a non-401 error response both prove the AUTH
// GATE isn't what blocked the call, which is the only thing under test
// here. A short per-call timeout keeps a hung fetch from stalling the
// suite; racing it out counts as "did not 401" too.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

vi.mock("@/lib/send-route-auth", () => ({
  requireSendAuth: vi.fn(),
}));

import { requireSendAuth } from "@/lib/send-route-auth";

const mockRequireSendAuth = vi.mocked(requireSendAuth);

const UNAUTHENTICATED = {
  ok: false as const,
  response: NextResponse.json({ error: "unauthorized", reason: "no_credential_matched" }, { status: 401 }),
};
const AUTHENTICATED = { ok: true as const, authKind: "test" };

type Ctx = { params: Promise<Record<string, string>> };

interface RouteCase {
  name: string;
  importPath: string;
  method: "GET" | "POST" | "PATCH";
  params?: Record<string, string>;
}

const CASES: RouteCase[] = [
  { name: "admin/dispose-listing GET", importPath: "@/app/api/admin/dispose-listing/route", method: "GET" },
  { name: "admin/dispose-listing POST", importPath: "@/app/api/admin/dispose-listing/route", method: "POST" },
  { name: "admin/migrate-dd-checklist POST", importPath: "@/app/api/admin/migrate-dd-checklist/route", method: "POST" },
  { name: "admin/appraiser-backfill GET", importPath: "@/app/api/admin/appraiser-backfill/route", method: "GET" },
  { name: "admin/auto-run-engaged-backfill GET", importPath: "@/app/api/admin/auto-run-engaged-backfill/route", method: "GET" },
  { name: "admin/d3-backfill-offer-fields GET", importPath: "@/app/api/admin/d3-backfill-offer-fields/route", method: "GET" },
  { name: "admin/d3-scrub GET", importPath: "@/app/api/admin/d3-scrub/route", method: "GET" },
  { name: "admin/proposals-bulk-archive GET", importPath: "@/app/api/admin/proposals-bulk-archive/route", method: "GET" },
  { name: "admin/seed-sweep GET", importPath: "@/app/api/admin/seed-sweep/route", method: "GET" },
  { name: "admin/url-backfill GET", importPath: "@/app/api/admin/url-backfill/route", method: "GET" },
  { name: "admin/bulk-dead-stale-texted GET", importPath: "@/app/api/admin/bulk-dead-stale-texted/route", method: "GET" },
  { name: "admin/recompute-agent-prior-counts GET", importPath: "@/app/api/admin/recompute-agent-prior-counts/route", method: "GET" },
  { name: "cron/purge-capped-to-list GET", importPath: "@/app/api/cron/purge-capped-to-list/route", method: "GET" },
  { name: "cron/sqft-backfill GET", importPath: "@/app/api/cron/sqft-backfill/route", method: "GET" },
  { name: "cron/scan-comms GET", importPath: "@/app/api/cron/scan-comms/route", method: "GET" },
  { name: "cron/propose-actions GET", importPath: "@/app/api/cron/propose-actions/route", method: "GET" },
  { name: "cron/propose-actions POST", importPath: "@/app/api/cron/propose-actions/route", method: "POST" },
  { name: "scan-replies GET", importPath: "@/app/api/scan-replies/route", method: "GET" },
  { name: "scan-replies POST", importPath: "@/app/api/scan-replies/route", method: "POST" },
  { name: "scaffold-tables POST", importPath: "@/app/api/scaffold-tables/route", method: "POST" },
  { name: "buyers/import-csv POST", importPath: "@/app/api/buyers/import-csv/route", method: "POST" },
  { name: "buyers/draft-outreach POST", importPath: "@/app/api/buyers/draft-outreach/route", method: "POST" },
  { name: "claude/command POST", importPath: "@/app/api/claude/command/route", method: "POST" },
  { name: "claude/draft-followup POST", importPath: "@/app/api/claude/draft-followup/route", method: "POST" },
  { name: "jarvis-audit POST", importPath: "@/app/api/jarvis-audit/route", method: "POST" },
  { name: "jarvis-chat POST", importPath: "@/app/api/jarvis-chat/route", method: "POST" },
  { name: "kill-buyer POST", importPath: "@/app/api/kill-buyer/route", method: "POST" },
  { name: "mark-buyer-emailed POST", importPath: "@/app/api/mark-buyer-emailed/route", method: "POST" },
  { name: "mark-dead POST", importPath: "@/app/api/mark-dead/route", method: "POST" },
  { name: "mark-texted POST", importPath: "@/app/api/mark-texted/route", method: "POST" },
  { name: "zip-registry/decision POST", importPath: "@/app/api/zip-registry/decision/route", method: "POST" },
  { name: "process-intake POST", importPath: "@/app/api/process-intake/route", method: "POST" },
  { name: "verify-listing POST", importPath: "@/app/api/verify-listing/route", method: "POST" },
  { name: "operator-actions PATCH", importPath: "@/app/api/operator-actions/route", method: "PATCH" },
  { name: "proposals PATCH", importPath: "@/app/api/proposals/route", method: "PATCH" },
  { name: "orchestrator/advance-stage GET", importPath: "@/app/api/orchestrator/advance-stage/route", method: "GET" },
  { name: "orchestrator/advance-stage POST", importPath: "@/app/api/orchestrator/advance-stage/route", method: "POST" },
  { name: "outreach-safety-check POST", importPath: "@/app/api/outreach-safety-check/route", method: "POST" },
  { name: "rehab-calibration POST", importPath: "@/app/api/rehab-calibration/route", method: "POST" },
  {
    name: "buyers/match-to-deal/[recordId] POST",
    importPath: "@/app/api/buyers/match-to-deal/[recordId]/route",
    method: "POST",
    params: { recordId: "recTEST00000000001" },
  },
  {
    name: "deal-action/[id] POST",
    importPath: "@/app/api/deal-action/[id]/route",
    method: "POST",
    params: { id: "recTEST00000000001" },
  },
  {
    name: "pre-offer-screen/[recordId] POST",
    importPath: "@/app/api/pre-offer-screen/[recordId]/route",
    method: "POST",
    params: { recordId: "recTEST00000000001" },
  },
  {
    name: "pre-contract-gate/[recordId] PATCH",
    importPath: "@/app/api/pre-contract-gate/[recordId]/route",
    method: "PATCH",
    params: { recordId: "recTEST00000000001" },
  },
  {
    name: "sentinel/classify/[recordId] GET",
    importPath: "@/app/api/sentinel/classify/[recordId]/route",
    method: "GET",
    params: { recordId: "recTEST00000000001" },
  },
  {
    name: "sentinel/classify/[recordId] POST",
    importPath: "@/app/api/sentinel/classify/[recordId]/route",
    method: "POST",
    params: { recordId: "recTEST00000000001" },
  },
  {
    name: "sentinel/draft/[recordId] GET",
    importPath: "@/app/api/sentinel/draft/[recordId]/route",
    method: "GET",
    params: { recordId: "recTEST00000000001" },
  },
  {
    name: "sentinel/draft/[recordId] POST",
    importPath: "@/app/api/sentinel/draft/[recordId]/route",
    method: "POST",
    params: { recordId: "recTEST00000000001" },
  },
];

function makeRequest(method: string): Request {
  return new Request("https://dashboard.example/api/whatever?apply=1&apply_motivation=1&confirm=dead", {
    method,
    headers: method === "GET" ? undefined : { "content-type": "application/json" },
    body: method === "GET" ? undefined : "{}",
  });
}

async function callHandler(c: RouteCase): Promise<Response | null> {
  const mod = (await import(/* @vite-ignore */ c.importPath)) as Record<string, unknown>;
  const handler = mod[c.method] as (req: Request, ctx?: Ctx) => Promise<Response>;
  const req = makeRequest(c.method);
  const ctx: Ctx | undefined = c.params ? { params: Promise.resolve(c.params) } : undefined;
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000));
  try {
    return await Promise.race([handler(req, ctx), timeout]);
  } catch {
    return null; // threw downstream — not a 401, which is all this test cares about
  }
}

describe("write route guard wiring (requireSendAuth mocked)", () => {
  beforeEach(() => {
    mockRequireSendAuth.mockReset();
  });

  for (const c of CASES) {
    it(`${c.name} → 401 when requireSendAuth refuses`, async () => {
      mockRequireSendAuth.mockResolvedValue(UNAUTHENTICATED);
      const res = await callHandler(c);
      expect(res).not.toBeNull();
      expect(res!.status).toBe(401);
    });

    it(`${c.name} → not 401 when requireSendAuth allows`, async () => {
      mockRequireSendAuth.mockResolvedValue(AUTHENTICATED);
      const res = await callHandler(c);
      // null = threw or timed out downstream; either way the auth gate
      // itself did not produce a 401.
      if (res === null) return;
      expect(res.status).not.toBe(401);
    }, 8000);
  }
});
