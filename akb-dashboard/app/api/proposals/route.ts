import { getListing, updateListingRecord } from "@/lib/airtable";
import { parseSendSmsPayload, sendApprovedReply } from "@/lib/approve-send";
import { parseFrontierRetirePayload } from "@/lib/crawler/frontier-governor";
import { retireZip } from "@/lib/zip-registry";
import { audit } from "@/lib/audit-log";

const AIRTABLE_PAT = process.env.AIRTABLE_PAT!;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";

export const runtime = "nodejs";
export const maxDuration = 60;

function getTableId(): string | null {
  return process.env.AGENT_PROPOSALS_TABLE_ID ?? null;
}

export interface Proposal {
  id: string;
  proposalType: string;
  recordId: string;
  recordAddress: string;
  reasoning: string;
  actionPayload: string;
  status: string;
  snoozeUntil: string | null;
  /** Airtable record creation time — drives the conveyor's waiting clock. */
  createdTime: string | null;
}

export async function GET() {
  const tableId = getTableId();
  if (!tableId) {
    return Response.json(
      { error: "AGENT_PROPOSALS_TABLE_ID not set" },
      { status: 500 }
    );
  }

  try {
    const now = new Date().toISOString();
    const params = new URLSearchParams();
    params.set("filterByFormula", `{Status}="Pending"`);

    const allProposals: Proposal[] = [];
    let offset: string | undefined;

    do {
      const p = new URLSearchParams(params);
      if (offset) p.set("offset", offset);

      const res = await fetch(
        `https://api.airtable.com/v0/${BASE_ID}/${tableId}?${p.toString()}`,
        {
          headers: { Authorization: `Bearer ${AIRTABLE_PAT}` },
          cache: "no-store",
        }
      );

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Airtable error ${res.status}: ${errText}`);
      }

      const data = await res.json();
      for (const rec of data.records) {
        const f = rec.fields as Record<string, unknown>;
        const snoozeUntil = (f.Snooze_Until as string) ?? null;
        if (snoozeUntil && new Date(snoozeUntil) > new Date(now)) continue;

        allProposals.push({
          id: rec.id,
          proposalType: (f.Proposal_Type as string) ?? "",
          recordId: (f.Record_ID as string) ?? "",
          recordAddress: (f.Record_Address as string) ?? "",
          reasoning: (f.Reasoning as string) ?? "",
          actionPayload: (f.Suggested_Action_Payload as string) ?? "{}",
          status: (f.Status as string) ?? "Pending",
          snoozeUntil,
          createdTime: (rec.createdTime as string) ?? null,
        });
      }
      offset = data.offset;
    } while (offset);

    // jarvis_reply (a live seller waiting on a reply) always outranks
    // housekeeping proposals — the operator's decision surface leads with
    // revenue (operator 2026-07-08 queue-hygiene mandate).
    allProposals.sort((a, b) => {
      const ap = a.proposalType === "jarvis_reply" ? 0 : 1;
      const bp = b.proposalType === "jarvis_reply" ? 0 : 1;
      return ap - bp;
    });

    return Response.json(allProposals);
  } catch (err) {
    console.error("[proposals] Error:", err);
    return Response.json(
      { error: "Failed to fetch proposals", detail: String(err) },
      { status: 500 }
    );
  }
}

async function patchProposal(
  tableId: string,
  proposalId: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(
    `https://api.airtable.com/v0/${BASE_ID}/${tableId}/${proposalId}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${AIRTABLE_PAT}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ fields, typecast: true }),
    }
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Airtable error ${res.status}: ${errText}`);
  }
}

export async function PATCH(req: Request) {
  const tableId = getTableId();
  if (!tableId) {
    return Response.json(
      { error: "AGENT_PROPOSALS_TABLE_ID not set" },
      { status: 500 }
    );
  }

  let body: {
    proposalId: string;
    action: "approve" | "reject" | "snooze";
    reason?: string;
    /** Wire 2 (phase B): approve AND dispatch the drafted SMS. Only the new
     *  /queue UI sets this — legacy approves stay status-only, so historical
     *  pending proposals can never fire a text by accident. */
    dispatch?: boolean;
    /** Operator's edit-before-send body; falls back to the stored draft. */
    editedBody?: string;
  };
  try {
    const text = await req.text();
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { proposalId, action, reason, dispatch, editedBody } = body;
  if (!proposalId || !action) {
    return Response.json(
      { error: "Missing proposalId or action" },
      { status: 400 }
    );
  }

  // ── Wire 2: Approve & Send — dispatch the operator-approved draft ──
  if (action === "approve" && dispatch === true) {
    try {
      // Fresh-fetch the proposal: payload + status are the send inputs, and a
      // non-Pending proposal must never dispatch (second idempotency belt on
      // top of the KV claim).
      const res = await fetch(
        `https://api.airtable.com/v0/${BASE_ID}/${tableId}/${proposalId}`,
        { headers: { Authorization: `Bearer ${AIRTABLE_PAT}` }, cache: "no-store" }
      );
      if (!res.ok) {
        return Response.json({ error: `proposal fetch failed (${res.status})` }, { status: 502 });
      }
      const rec = await res.json();
      const f = (rec.fields ?? {}) as Record<string, unknown>;
      const status = (f.Status as string) ?? "Pending";
      if (status !== "Pending") {
        return Response.json(
          { success: false, skipReason: `proposal is ${status}, not Pending` },
          { status: 409 }
        );
      }

      const payload = parseSendSmsPayload(f.Suggested_Action_Payload as string);
      if (!payload) {
        return Response.json(
          { success: false, skipReason: "not_dispatchable: payload is not a send_sms action" },
          { status: 422 }
        );
      }

      const recordId = (f.Record_ID as string) || payload.recordId || "";
      const listing = recordId ? await getListing(recordId) : null;
      const finalBody = (editedBody ?? "").trim() || payload.draftBody;

      const result = await sendApprovedReply({
        proposalId,
        recordId: recordId || proposalId,
        toE164: payload.to,
        body: finalBody,
        state: listing?.state ?? null,
        doNotText: listing?.doNotText === true,
        address: listing?.address ?? null,
      });

      if (!result.sent) {
        // Leave the proposal PENDING — a quiet-hours or claim skip must stay
        // retryable and must never masquerade as an approved-and-sent reply.
        return Response.json(
          { success: false, skipReason: result.reason },
          { status: 409 }
        );
      }

      const iso = new Date().toISOString();
      await patchProposal(tableId, proposalId, {
        Status: "Approved",
        Reviewed_At: iso,
        Suggested_Action_Payload: JSON.stringify({
          ...JSON.parse((f.Suggested_Action_Payload as string) ?? "{}"),
          sentBody: finalBody,
          quoMessageId: result.quoMessageId,
          sentAt: iso,
        }),
      });

      // Best-effort listing write-back — the SMS is already out, so a failed
      // note write must not fail the response (reconcile repairs status).
      if (recordId && listing) {
        try {
          const line = `[operator reply sent ${iso}] ${finalBody} [quo ${result.quoMessageId ?? "?"}]`;
          await updateListingRecord(recordId, {
            Last_Outbound_At: iso,
            Verification_Notes: listing.notes ? `${listing.notes}\n\n${line}` : line,
          });
        } catch (err) {
          console.error("[proposals] listing write-back failed:", err);
        }
      }

      return Response.json({
        success: true,
        action,
        sent: true,
        quoMessageId: result.quoMessageId,
      });
    } catch (err) {
      console.error("[proposals] dispatch error:", err);
      return Response.json(
        { error: "Dispatch failed", detail: String(err) },
        { status: 500 }
      );
    }
  }

  // ── frontier_retire one-tap (#37, operator 2026-07-11): approving the
  // card EXECUTES the retirement — ZIP_Registry row → paused, stamped —
  // then marks the proposal Approved. Retirement is never autonomous;
  // this tap IS the operator decision. Fail-closed: a malformed payload
  // refuses instead of approving a no-op, and a non-Pending proposal
  // never executes twice.
  if (action === "approve") {
    try {
      const res = await fetch(
        `https://api.airtable.com/v0/${BASE_ID}/${tableId}/${proposalId}`,
        { headers: { Authorization: `Bearer ${AIRTABLE_PAT}` }, cache: "no-store" },
      );
      if (res.ok) {
        const rec = await res.json();
        const f = (rec.fields ?? {}) as Record<string, unknown>;
        if ((f.Proposal_Type as string) === "frontier_retire") {
          if (((f.Status as string) ?? "Pending") !== "Pending") {
            return Response.json(
              { success: false, skipReason: `proposal is ${f.Status}, not Pending` },
              { status: 409 },
            );
          }
          const payload = parseFrontierRetirePayload(f.Suggested_Action_Payload as string);
          if (!payload) {
            return Response.json(
              { success: false, skipReason: "not_dispatchable: payload is not a frontier_retire action" },
              { status: 422 },
            );
          }
          const iso = new Date().toISOString();
          await retireZip(payload.recordId, {
            note: `frontier_retire approved by operator (proposal ${proposalId}): ZIP ${payload.zip} paused — zero-yield snapshot`,
          });
          await patchProposal(tableId, proposalId, {
            Status: "Approved",
            Reviewed_At: iso,
          });
          await audit({
            agent: "scout",
            event: "frontier_retire_executed",
            status: "confirmed_success",
            recordId: payload.recordId,
            inputSummary: { proposal_id: proposalId, zip: payload.zip },
            outputSummary: { market_tier: "paused" },
          });
          return Response.json({ success: true, action, executed: "frontier_retire", zip: payload.zip });
        }
      }
    } catch (err) {
      console.error("[proposals] frontier_retire dispatch error:", err);
      return Response.json(
        { error: "frontier_retire dispatch failed", detail: String(err) },
        { status: 500 },
      );
    }
  }

  const fields: Record<string, unknown> = {};

  if (action === "approve") {
    fields.Status = "Approved";
    fields.Reviewed_At = new Date().toISOString();
  } else if (action === "reject") {
    fields.Status = "Rejected";
    fields.Reviewed_At = new Date().toISOString();
    if (reason) fields.Reasoning = reason;
  } else if (action === "snooze") {
    const tomorrow9am = new Date();
    tomorrow9am.setDate(tomorrow9am.getDate() + 1);
    tomorrow9am.setHours(9, 0, 0, 0);
    fields.Snooze_Until = tomorrow9am.toISOString();
  }

  try {
    await patchProposal(tableId, proposalId, fields);
    return Response.json({ success: true, action });
  } catch (err) {
    console.error("[proposals] PATCH error:", err);
    return Response.json(
      { error: "Failed to update proposal", detail: String(err) },
      { status: 500 }
    );
  }
}
