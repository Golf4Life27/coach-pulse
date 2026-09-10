import { NextResponse } from "next/server";
import { constantTimeEqual } from "@/lib/maverick/oauth/crypto";
import {
  SESSION_COOKIE_NAME,
  mintSessionValue,
  sessionSecret,
} from "@/lib/auth/session-cookie";

const SESSION_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

export async function POST(request: Request) {
  try {
    const { password } = await request.json();
    const correctPassword = process.env.DASHBOARD_PASSWORD;
    const secret = sessionSecret();

    if (!correctPassword || !secret) {
      return NextResponse.json(
        { error: "Dashboard password not configured" },
        { status: 500 }
      );
    }

    if (
      typeof password === "string" &&
      constantTimeEqual(password, correctPassword)
    ) {
      const response = NextResponse.json({ success: true });
      const expiresAtMs = Date.now() + SESSION_LIFETIME_MS;
      response.cookies.set(
        SESSION_COOKIE_NAME,
        mintSessionValue(expiresAtMs, secret),
        {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          // Was "strict". Strict withholds the cookie on a top-level
          // navigation arriving FROM another site — which is exactly what
          // a link tapped in Messages or email is, so the operator landed
          // logged-out every time he arrived at the dashboard from a text.
          // "lax" still withholds the cookie on cross-site POSTs (a forged
          // <form> on another site can't ride along), so CSRF protection
          // on state-changing requests is unchanged — it only additionally
          // sends the cookie on a plain top-level GET navigation, which is
          // what following a link does.
          sameSite: "lax",
          maxAge: SESSION_LIFETIME_MS / 1000,
        }
      );
      return response;
    }

    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
