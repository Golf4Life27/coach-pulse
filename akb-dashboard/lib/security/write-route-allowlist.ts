// Public-write-route allowlist — the single source of truth for every
// app/api route that writes (or can write) WITHOUT going through the
// shared dashboard-cookie / CRON_SECRET / OAuth waterfall
// (lib/send-route-auth.ts's requireSendAuth).
//
// Security sweep 2026-09-24 (execution agenda P0-21, spine
// recYbAYqkguZSOTeF): the repo is public and Vercel deployment protection
// is off, so every route NOT gated by requireSendAuth (or in this list) is
// reachable, unauthenticated, by anyone on the internet. Every write route
// was either put behind requireSendAuth or added here with a reason. This
// list is read by lib/security/write-route-auth.scan.test.ts, which fails
// CI if a new write route appears without either.
//
// Paths are relative to app/api, with no leading/trailing slash and no
// `/route.ts` suffix (e.g. "buyers/intake" for app/api/buyers/intake/route.ts).

export interface WriteRouteAllowlistEntry {
  path: string;
  reason: string;
}

export const WRITE_ROUTE_ALLOWLIST: WriteRouteAllowlistEntry[] = [
  {
    path: "auth",
    reason:
      "The login route itself — verifies DASHBOARD_PASSWORD and mints the " +
      "session cookie the waterfall checks elsewhere. Must be reachable " +
      "pre-auth or nobody could ever log in.",
  },
  {
    path: "buyers/intake",
    reason:
      "The public buyer-intake form (app/buyer-intake and app/d/[recordId]) " +
      "— intentionally the one public write path. Hardened separately: 8KB " +
      "body cap, honeypot field, field validation, and a per-IP KV rate " +
      "limit (see the route's own header comment).",
  },
  {
    path: "webhooks/quo-inbound",
    reason:
      "Inbound SMS webhook from Quo/OpenPhone — verifies its own shared " +
      "secret (QUO_WEBHOOK_SECRET via x-webhook-secret header or ?secret=) " +
      "and fails closed on live writes when that secret is unconfigured.",
  },
  {
    path: "maverick/act",
    reason:
      "Decision-card action endpoint. The single-use token in the request " +
      "body IS the credential (see lib/maverick/decision-card.ts) — it is " +
      "redeemed server-side against the stored card and can only execute " +
      "the action already declared there. Its caller is an SMS link tap, " +
      "not a dashboard session or a cron; the waterfall cannot authenticate " +
      "that caller.",
  },
  {
    path: "maverick/oauth/authorize",
    reason:
      "OAuth authorization endpoint (RFC 6749) — public by protocol design; " +
      "it is the front door to the very credential the waterfall checks.",
  },
  {
    path: "maverick/oauth/register",
    reason:
      "OAuth dynamic client registration (RFC 7591) — public by protocol " +
      "design, same as any OAuth server's registration endpoint.",
  },
  {
    path: "maverick/oauth/token",
    reason:
      "OAuth token exchange — self-authenticates via the authorization " +
      "code / refresh token / PKCE verifier the caller must already hold; " +
      "gating it behind the waterfall would be circular (this route is how " +
      "a caller gets the waterfall's OAuth credential in the first place).",
  },
  {
    path: "maverick/oauth/revoke",
    reason:
      "OAuth revoke (RFC 7009) — self-authenticates via the token being " +
      "revoked (the caller must already possess it); per spec this always " +
      "returns 200 to avoid token-existence enumeration.",
  },
  {
    path: "orchestrator/run-gate",
    reason:
      "Diagnostic only — runGate() audit-logs the result and never writes " +
      "Pipeline_Stage or any listing field (that happens only in the " +
      "separate orchestrator/advance-stage route, which IS guarded). The " +
      "GET form exists specifically for the Vercel MCP web_fetch_vercel_url " +
      "tool, which only issues unauthenticated GETs.",
  },
  {
    path: "outreach-fire",
    reason:
      "Retired sender (operator 2026-07-22) — POST unconditionally returns " +
      "410 and never touches Airtable; the badge-count GET does not write " +
      "either. No live write path remains to guard.",
  },
  {
    path: "admin/outreach-batch",
    reason:
      "Retired sender (operator 2026-07-28) — GET and POST both " +
      "unconditionally return 410 and never touch Airtable. No live write " +
      "path remains to guard.",
  },
  {
    path: "admin/drift-test",
    reason:
      "Deliberate-drift validator, invoked from outside the sandbox via " +
      "the Vercel MCP web_fetch_vercel_url tool (unauthenticated GET only) " +
      "— the waterfall cannot authenticate that caller. Blast radius is " +
      "fixed to one hardcoded, non-production test record " +
      "(ALLOWED_TEST_RECORD_IDS); every other recordId gets 403.",
  },
  {
    path: "admin/remove-singleselect-choice",
    reason:
      "One-shot Airtable schema cleanup, same Vercel MCP " +
      "web_fetch_vercel_url (unauthenticated GET only) caller as " +
      "drift-test. Blast radius is fixed to one hardcoded, pre-approved " +
      "{tableId, fieldId, choiceName} removal (ALLOWED_REMOVALS); anything " +
      "else gets 403.",
  },
  {
    path: "public/deal/[recordId]",
    reason:
      "Public deal page data (app/d/[recordId]) — GET-only, read-only, no " +
      "write handler exists.",
  },
];

export const WRITE_ROUTE_ALLOWLIST_PATHS: ReadonlySet<string> = new Set(
  WRITE_ROUTE_ALLOWLIST.map((e) => e.path),
);
