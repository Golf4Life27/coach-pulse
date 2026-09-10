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
//
// SLIDING RENEWAL (session-cookie hardening): a session is minted for 90
// days at login, but the operator hits this route constantly (AuthGate
// calls it on every mount). Rather than let an active session march
// toward that expiry and eventually force a re-login mid-use, an actively
// used session gets re-minted for another fresh 90 days once its
// remaining life drops under 60 — so the cookie keeps sliding forward as
// long as he keeps using the dashboard, and only an abandoned session
// (one that stops being used) actually runs out, within 90 days of the
// last time it was checked. That is the "type it once and stop thinking
// about it" property.

import { NextResponse } from "next/server";
import { hasDashboardSession } from "@/lib/maverick/oauth/auth-waterfall";
import {
  SESSION_COOKIE_NAME,
  mintSessionValue,
  sessionSecret,
  verifySessionValue,
} from "@/lib/auth/session-cookie";

export const runtime = "nodejs";

const SESSION_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const RENEW_UNDER_MS = 60 * 24 * 60 * 60 * 1000; // renew once under 60 days left

function cookieValue(cookieHeader: string | null): string | undefined {
  if (!cookieHeader) return undefined;
  for (const pair of cookieHeader.split(/;\s*/)) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() === SESSION_COOKIE_NAME) {
      return pair.slice(eq + 1).trim();
    }
  }
  return undefined;
}

export async function GET(req: Request) {
  const cookieHeader = req.headers.get("cookie");
  if (!hasDashboardSession(cookieHeader)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });

  const secret = sessionSecret();
  const now = Date.now();
  const result = verifySessionValue(cookieValue(cookieHeader), now, secret);
  if (result.ok && secret && result.expiresAtMs - now < RENEW_UNDER_MS) {
    const expiresAtMs = now + SESSION_LIFETIME_MS;
    response.cookies.set(
      SESSION_COOKIE_NAME,
      mintSessionValue(expiresAtMs, secret),
      {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: SESSION_LIFETIME_MS / 1000,
      }
    );
  }

  return response;
}
