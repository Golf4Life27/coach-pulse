// Server-side operator last-seen ping (silver-platter cockpit).
//
// POST — the cockpit shell pings on mount + when the tab regains focus
//        (dashboard session required). Stores `operator:last_seen` in KV.
// GET  — the escalation cron reads it to decide whether the operator is
//        "in the cockpit" (no text needed) or away (text the phone).
//
// The old signal was localStorage-only — invisible to the server, so
// escalation could never know he hadn't logged in. This is the durable ping.

import { NextResponse } from "next/server";
import { hasDashboardSession } from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import { OPERATOR_LAST_SEEN_KEY } from "@/lib/escalation";

export const runtime = "nodejs";
export const maxDuration = 10;

const TTL_S = 90 * 86_400;

export async function POST(req: Request) {
  if (!hasDashboardSession(req.headers.get("cookie"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!kvConfigured()) return NextResponse.json({ ok: false, kv: false });
  const iso = new Date().toISOString();
  try {
    await kvProd.setEx(OPERATOR_LAST_SEEN_KEY, iso, TTL_S);
    return NextResponse.json({ ok: true, last_seen: iso });
  } catch {
    return NextResponse.json({ ok: false, kv: true }, { status: 502 });
  }
}

export async function GET() {
  if (!kvConfigured()) return NextResponse.json({ last_seen: null, kv: false });
  try {
    const iso = await kvProd.get(OPERATOR_LAST_SEEN_KEY);
    return NextResponse.json({ last_seen: iso ?? null, kv: true });
  } catch {
    return NextResponse.json({ last_seen: null, kv: true }, { status: 502 });
  }
}
