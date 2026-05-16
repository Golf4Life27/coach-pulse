// @deprecated Legacy send endpoint. Audit attribution updated to
// `crier` per Phase 9.3 (was `quo`). Phase 9.11 deprecation tag; URL
// kept live since this is an active send path. Future renaming to
// `/api/crier/send` deferred to a post-Phase-9 cleanup commit so the
// rename doesn't ride the dashboard rework's UI risk surface.
//
// POST /api/jarvis-send
//
// Hands a message to OpenPhone and returns the queued message id. PER
// THE POSITIVE CONFIRMATION PRINCIPLE this route does NOT claim success
// when the POST returns 202 — that just means OpenPhone accepted the
// payload. The client must poll GET /api/quo-message-status/{id} to
// confirm sent/delivered before treating the send as successful.
//
// Response shape:
//   { quoMessageId, quoStatus, accepted, isTerminal, isSuccess }
//     quoMessageId — null if OpenPhone didn't return one (still 2xx)
//     quoStatus    — "queued" | "sending" | "sent" | "delivered" | ...
//     accepted     — true if OpenPhone returned 2xx (NOT delivery proof)
//     isTerminal   — true if the queued status is already terminal
//     isSuccess    — true ONLY if status is "delivered" or "sent" (rare
//                    on initial POST — usually requires polling)
//
// Audit: emits ONE entry per call. Terminal-success on POST → confirmed_success.
// Terminal-failure on POST throw → confirmed_failure. Anything else
// (the typical 202+queued path) → uncertain. The polling route closes
// the loop on uncertain entries.

import { NextResponse } from "next/server";
import { sendMessageWithId } from "@/lib/quo";
import { updateListingRecord } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";

export const runtime = "nodejs";

const AIRTABLE_PAT = process.env.AIRTABLE_PAT!;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";

function getProposalsTableId(): string | null {
  return process.env.AGENT_PROPOSALS_TABLE_ID ?? null;
}

function maskPhone(p: string): string {
  if (!p) return "";
  const digits = p.replace(/\D/g, "");
  if (digits.length < 4) return "***";
  return `***${digits.slice(-4)}`;
}

export async function POST(req: Request) {
  const t0 = Date.now();
  let body: {
    proposalId: string;
    to: string;
    message: string;
    recordId?: string;
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { proposalId, to, message, recordId } = body;
  if (!proposalId || !to || !message) {
    return NextResponse.json(
      { error: "Missing proposalId, to, or message" },
      { status: 400 },
    );
  }

  if (!process.env.QUO_API_KEY) {
    await audit({
      agent: "crier",
      event: "send_attempt",
      status: "confirmed_failure",
      recordId,
      inputSummary: { to: maskPhone(to), proposalId, msg_len: message.length },
      error: "QUO_API_KEY not set",
      ms: Date.now() - t0,
    });
    return NextResponse.json({ error: "QUO_API_KEY not set" }, { status: 500 });
  }

  // ── Send ────────────────────────────────────────────────────────────
  let sendResult;
  try {
    sendResult = await sendMessageWithId(to, message);
  } catch (err) {
    console.error("[jarvis-send] Quo send failed:", err);
    await audit({
      agent: "crier",
      event: "send_attempt",
      status: "confirmed_failure",
      recordId,
      inputSummary: { to: maskPhone(to), proposalId, msg_len: message.length },
      error: String(err),
      ms: Date.now() - t0,
    });
    return NextResponse.json(
      { error: "Failed to send via Quo", detail: String(err) },
      { status: 502 },
    );
  }

  const accepted = sendResult.httpStatus >= 200 && sendResult.httpStatus < 300;
  const isSuccess =
    sendResult.status === "delivered" || sendResult.status === "sent";
  const isTerminalFailure =
    sendResult.status === "failed" || sendResult.status === "undelivered";
  const auditStatus = isSuccess
    ? "confirmed_success"
    : isTerminalFailure
      ? "confirmed_failure"
      : "uncertain";

  await audit({
    agent: "crier",
    event: "send_attempt",
    status: auditStatus,
    recordId,
    externalId: sendResult.id ?? undefined,
    inputSummary: {
      to: maskPhone(to),
      proposalId,
      msg_len: message.length,
    },
    outputSummary: {
      quo_message_id: sendResult.id,
      quo_status: sendResult.status,
      http: sendResult.httpStatus,
    },
    decision: sendResult.status,
    ms: Date.now() - t0,
  });

  // ── Side-effects ────────────────────────────────────────────────────
  // PER THE PRINCIPLE: do NOT mark the proposal Executed on uncertain.
  // We only mark Executed when the queued send is already confirmed_success
  // (rare on POST). The polling route does the late update; for now we
  // mark a softer "Sent_Pending_Confirmation" status if the table allows.
  const proposalsTableId = getProposalsTableId();
  if (proposalsTableId && (isSuccess || auditStatus === "uncertain")) {
    const proposalStatus = isSuccess
      ? "Executed"
      : "Sent_Pending_Confirmation";
    try {
      await fetch(
        `https://api.airtable.com/v0/${BASE_ID}/${proposalsTableId}/${proposalId}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${AIRTABLE_PAT}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            fields: {
              Status: proposalStatus,
              Reviewed_At: new Date().toISOString(),
              Quo_Message_ID: sendResult.id ?? "",
            },
            typecast: true,
          }),
        },
      );
    } catch (err) {
      console.error("[jarvis-send] proposal patch failed:", err);
      // Non-fatal: the send already happened (or queued). Surface in audit.
      await audit({
        agent: "crier",
        event: "proposal_patch_failed",
        status: "confirmed_failure",
        recordId,
        externalId: sendResult.id ?? undefined,
        error: String(err),
      });
    }
  }

  // Stamp Last_Outbound_At only when we have positive confirmation.
  // Uncertain sends do NOT update outreach state — Principle §Rule 4.
  if (recordId && isSuccess) {
    try {
      await updateListingRecord(recordId, {
        fldaK4lR5UNvycg11: new Date().toISOString(),
      });
    } catch (err) {
      console.error("[jarvis-send] Last_Outbound_At stamp failed:", err);
    }
  }

  return NextResponse.json({
    quoMessageId: sendResult.id,
    quoStatus: sendResult.status,
    accepted,
    isTerminal: isSuccess || isTerminalFailure,
    isSuccess,
  });
}
