// SEV1-B remediation (pre-merge gate, adjudication recXJrM7EYK3pEFmF):
// the three send-capable routes (jarvis-send, dd-volley-send,
// buyers/fire-blast) shipped with NO auth — publicly POSTable SMS/email
// dispatch on the prod alias. This is the shared guard: the same
// dashboard-cookie / CRON_SECRET / OAuth waterfall every other guarded
// route uses. Dashboard UI calls carry the cookie on same-origin fetch,
// so the operator flow is unchanged; anonymous internet POSTs get 401.

import { NextResponse } from "next/server";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";

export type SendRouteAuth =
  | { ok: true; authKind: string }
  | { ok: false; response: NextResponse };

export async function requireSendAuth(req: Request): Promise<SendRouteAuth> {
  const cookieHeader = req.headers.get("cookie");
  if (hasDashboardSession(cookieHeader)) return { ok: true, authKind: "dashboard_session" };
  const env = readAuthEnv();
  const headers = readAuthHeaders(req);
  const authRequired = kvConfigured() || env.cronSecret !== null || env.bearerDevToken !== null;
  if (!authRequired) return { ok: true, authKind: "none_configured" };
  const auth = await authenticate(headers, env, kvProd);
  if (!auth.ok) {
    return {
      ok: false,
      response: NextResponse.json({ error: "unauthorized", reason: auth.reason }, { status: 401 }),
    };
  }
  return { ok: true, authKind: auth.kind };
}
