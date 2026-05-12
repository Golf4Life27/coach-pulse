// Polling endpoint for OpenPhone message status. The dashboard hits this
// after POST /api/jarvis-send returns a queued message id. Per the
// Positive Confirmation Principle (Rule 1), a 202+queued is NOT proof of
// delivery — clients must poll until status is terminal.
//
// GET /api/quo-message-status/[messageId]
// → { status, isTerminal, isSuccess, httpStatus }
//
// Every transition (uncertain → confirmed_success / confirmed_failure)
// is appended to the audit log so the Orchestrator can surface stragglers.

import { NextResponse } from "next/server";
import { getMessageStatus } from "@/lib/quo";
import { audit } from "@/lib/audit-log";

export const runtime = "nodejs";
export const maxDuration = 15;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ messageId: string }> },
) {
  const t0 = Date.now();
  const { messageId } = await params;
  if (!messageId) {
    return NextResponse.json({ error: "messageId required" }, { status: 400 });
  }
  if (!process.env.QUO_API_KEY) {
    return NextResponse.json({ error: "QUO_API_KEY not set" }, { status: 500 });
  }

  try {
    const result = await getMessageStatus(messageId);

    // Only audit the final transition. Mid-poll "still queued" entries
    // would spam the ring buffer; the originating /api/jarvis-send call
    // already logged the uncertain state.
    if (result.isTerminal) {
      await audit({
        agent: "quo",
        event: "message_status_resolved",
        status: result.isSuccess ? "confirmed_success" : "confirmed_failure",
        externalId: messageId,
        outputSummary: { quo_status: result.status, http: result.httpStatus },
        decision: result.status,
        ms: Date.now() - t0,
      });
    }

    return NextResponse.json(result);
  } catch (err) {
    await audit({
      agent: "quo",
      event: "message_status_error",
      status: "confirmed_failure",
      externalId: messageId,
      error: String(err),
      ms: Date.now() - t0,
    });
    return NextResponse.json(
      { error: "Status lookup failed", detail: String(err) },
      { status: 502 },
    );
  }
}
