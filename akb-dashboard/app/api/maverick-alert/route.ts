// POST /api/maverick-alert
//
// WHY THIS EXISTS. Routine Claude sessions (hourly triage, Engine Driver)
// text the operator through the claude.ai Quo connector, whose credential
// dies after roughly 4 hours; on 2026-09-14 five alerts failed to reach the
// operator's phone because of exactly that. The app's own Quo key (Vercel
// env) never dies. POST /api/jarvis-send already solved this for
// agent-facing sends; this is the operator-facing sibling: a CRON_SECRET
// -gated route that sends a short plain-text alert FROM the Maverick line
// (ALERT_FROM) TO the operator's cell, dispatchable from a GitHub Actions
// workflow (.github/workflows/maverick-alert.yml) so a session needs only
// GitHub, never Quo.
//
// The 200-on-policy-refusal below is deliberate: a workflow dispatch must
// not fail just because it is 10pm or the alert is a duplicate. The caller
// reads `sent` and `reason` in the body instead of the HTTP status for
// those cases; only a hard operational failure (misconfiguration, Quo
// itself erroring) is a non-2xx.

import { NextResponse } from "next/server";
import { requireSendAuth } from "@/lib/send-route-auth";
import { sendOperatorAlert } from "@/lib/maverick/operator-alert";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const auth = await requireSendAuth(req);
  if (!auth.ok) return auth.response;

  let body: {
    message?: unknown;
    key?: unknown;
    recordId?: unknown;
    source?: unknown;
    urgent?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof body.message !== "string" || body.message.length === 0) {
    return NextResponse.json({ error: "Missing or invalid message" }, { status: 400 });
  }

  const result = await sendOperatorAlert({
    message: body.message,
    key: typeof body.key === "string" ? body.key : null,
    recordId: typeof body.recordId === "string" ? body.recordId : null,
    source: typeof body.source === "string" ? body.source : null,
    urgent: body.urgent === true,
  });

  if (result.reason === "alert_from_not_set") {
    return NextResponse.json(result, { status: 500 });
  }
  if (result.reason === "quo_error") {
    return NextResponse.json(result, { status: 502 });
  }
  // sent, outside_window, duplicate, daily_cap, empty_body - all 200. A
  // workflow dispatch must not fail just because it's 10pm; the caller
  // reads `sent` / `reason`.
  return NextResponse.json(result);
}
