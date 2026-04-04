import { NextResponse } from "next/server";

export async function POST(request: Request) {
  try {
    const { password } = await request.json();
    const correctPassword = process.env.DASHBOARD_PASSWORD;

    if (!correctPassword) {
      return NextResponse.json(
        { error: "Dashboard password not configured" },
        { status: 500 }
      );
    }

    if (password === correctPassword) {
      const response = NextResponse.json({ success: true });
      response.cookies.set("akb-auth", "authenticated", {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        maxAge: 60 * 60 * 24 * 7, // 7 days
      });
      return response;
    }

    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
