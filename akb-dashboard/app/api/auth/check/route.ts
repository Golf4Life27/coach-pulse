// Server-side auth check (operator 2026-06-10, spine recvp1H5cTGfp1k7T).
// @agent: ops
//
// GET /api/auth/check → 200 { ok: true } when the dashboard session cookie
// is valid, 401 { ok: false } otherwise.
//
// THE BUG IT FIXES (auth-hardening backlog, V1 route): the AuthGate client
// component used to read `document.cookie.includes("akb-auth=authenticated")`
// to decide whether to show the login screen. The cookie is set with
// httpOnly:true (correct, prevents XSS theft) which by design hides it from
// document.cookie. So AuthGate's check ALWAYS returned false, and the only
// reason a session "worked" was the in-memory setAuthenticated(true) call
// after the password submit — which survives SPA navigation but is lost on
// any full page reload (window.location.reload, browser refresh, new tab).
//
// The Appraiser ARV/Rehab panels reloading after a successful run was the
// trigger. AuthGate now calls this endpoint instead — HttpOnly cookies ARE
// sent on same-origin fetches, so the server can authoritatively answer.

import { NextResponse } from "next/server";
import { hasDashboardSession } from "@/lib/maverick/oauth/auth-waterfall";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const cookieHeader = req.headers.get("cookie");
  if (hasDashboardSession(cookieHeader)) {
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ ok: false }, { status: 401 });
}
