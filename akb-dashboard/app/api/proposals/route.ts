import { getListing, updateListingRecord } from "@/lib/airtable";
import { parseSendEmailPayload, parseSendSmsPayload, sendApprovedReply } from "@/lib/approve-send";
import { parseFrontierRetirePayload } from "@/lib/crawler/frontier-governor";
import { retireZip } from "@/lib/zip-registry";
import { audit } from "@/lib/audit-log";
import { sendEmail } from "@/lib/gmail";
import { parseDraftMeta } from "@/lib/recommended-reply";

/** RECOMMENDED-REPLIES mirror: flip the listing's Draft_Reply_Meta state
 *  when its queued draft is sent or dismissed through this rail. Matched by
 *  proposal_id so a newer draft is never clobbered by an older proposal's
 *  outcome. `proposalIds` carries BOTH id namespaces (Airtable rec… id and
 *  the human Proposal_ID string) — the meta stores whichever its writer had
 *  (sync crons stamp the human id; the deal page passes the rec id), and the
 *  mirror must match either. Best-effort — the proposal is dispatch truth. */
async function mirrorDraftState(
  recordId: string | null | undefined,
  proposalIds: Array<string | null | undefined>,
  state: "sent" | "dismissed",
  sentAt?: string,
): Promise<void> {
  if (!recordId) return;
  try {
    const candidates = new Set(proposalIds.filter((p): p is string => Boolean(p)));
    const listing = await getListing(recordId);
    const meta = parseDraftMeta((listing as { draftReplyMeta?: string | null })?.draftReplyMeta);
    if (!meta || !meta.proposal_id || !candidates.has(meta.proposal_id) || meta.state === "sent") return;
    await updateListingRecord(recordId, {
      Draft_Reply_Meta: JSON.stringify({ ...meta, state, sent_at: sentAt }),
    });
  } catch (err) {
    console.error("[proposals] draft-state mirror failed:", err);
  }
}

/** Resolve a caller-supplied proposal reference to the Airtable RECORD id.
 *  Two id namespaces reach this rail (2026-07-13 Act Now 404): the deal page
 *  passes rec… ids from GET /api/proposals, but the Live Deals strip passes
 *  Draft_Reply_Meta.proposal_id — the HUMAN Proposal_ID string the sync crons
 *  stamp ("jarvis_reply-<ts>-…"). Using that string as a record id 404s at
 *  Airtable ("proposal fetch failed (404)"). Non-rec refs resolve via a
 *  {Proposal_ID} lookup; null when nothing matches. */
async function resolveProposalRecordId(tableId: string, ref: string): Promise<string | null> {
  if (ref.startsWith("rec")) return ref;
  const params = new URLSearchParams();
  params.set("filterByFormula", `{Proposal_ID}="${ref.replace(/"/g, '\\"')}"`);
  params.set("maxRecords", "1");
  const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${tableId}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${AIRTABLE_PAT}` },
    cache: "no-store",
  });
  if (!res.ok) return null;
  const data = await res.json();
  const rec = data.records?.[0];
  return rec?.id ?? null;
}

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

  // Resolve to the Airtable record id — callers legitimately pass either
  // namespace (see resolveProposalRecordId). All Airtable ops below use the
  // record id; the mirror matches on both.
  let proposalRecId: string;
  try {
    const resolved = await resolveProposalRecordId(tableId, proposalId);
    if (!resolved) {
      return Response.json(
        { success: false, skipReason: `proposal not found for ref ${proposalId}` },
        { status: 404 }
      );
    }
    proposalRecId = resolved;
  } catch (err) {
    return Response.json({ error: "proposal lookup failed", detail: String(err) }, { status: 502 });
  }

  // ── Wire 2: Approve & Send — dispatch the operator-approved draft ──
  if (action === "approve" && dispatch === true) {
    try {
      // Fresh-fetch the proposal: payload + status are the send inputs, and a
      // non-Pending proposal must never dispatch (second idempotency belt on
      // top of the KV claim).
      const res = await fetch(
        `https://api.airtable.com/v0/${BASE_ID}/${tableId}/${proposalRecId}`,
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

      // ── send_email dispatch (recommended-replies email lane, 2026-07-12).
      // Same idempotency shell as SMS: Pending-only, edited body wins, notes
      // stamped, listing draft mirror flipped to sent.
      const emailPayload = parseSendEmailPayload(f.Suggested_Action_Payload as string);
      if (emailPayload) {
        const recordId = (f.Record_ID as string) || emailPayload.recordId || "";
        const finalBody = (editedBody ?? "").trim() || emailPayload.draftBody;
        const send = await sendEmail({
          to: emailPayload.to,
          subject: emailPayload.subject,
          body: finalBody,
          listingRecordId: recordId || undefined,
        });
        if (!send.success) {
          return Response.json(
            { success: false, skipReason: send.error ?? "email_send_failed" },
            { status: 409 }
          );
        }
        const iso = new Date().toISOString();
        await patchProposal(tableId, proposalRecId, {
          Status: "Approved",
          Reviewed_At: iso,
          Suggested_Action_Payload: JSON.stringify({
            ...JSON.parse((f.Suggested_Action_Payload as string) ?? "{}"),
            sentBody: finalBody,
            gmailMessageId: send.messageId ?? null,
            sentAt: iso,
          }),
        });
        if (recordId) {
          try {
            const listing = await getListing(recordId);
            const line = `[operator email sent ${iso}] ${emailPayload.subject} — ${finalBody.slice(0, 400)} [gmail ${send.messageId ?? "?"}]`;
            await updateListingRecord(recordId, {
              Last_Outbound_At: iso,
              Verification_Notes: listing?.notes ? `${listing.notes}\n\n${line}` : line,
            });
          } catch (err) {
            console.error("[proposals] email listing write-back failed:", err);
          }
          await mirrorDraftState(recordId, [proposalId, proposalRecId, f.Proposal_ID as string], "sent", iso);
        }
        return Response.json({ success: true, action, sent: true, gmailMessageId: send.messageId ?? null });
      }

      const payload = parseSendSmsPayload(f.Suggested_Action_Payload as string);
      if (!payload) {
        return Response.json(
          { success: false, skipReason: "not_dispatchable: payload is not a send_sms or send_email action" },
          { status: 422 }
        );
      }

      const recordId = (f.Record_ID as string) || payload.recordId || "";
      const listing = recordId ? await getListing(recordId) : null;
      const finalBody = (editedBody ?? "").trim() || payload.draftBody;

      const result = await sendApprovedReply({
        proposalId: proposalRecId,
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
      await patchProposal(tableId, proposalRecId, {
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
        await mirrorDraftState(recordId, [proposalId, proposalRecId, f.Proposal_ID as string], "sent", iso);
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
        `https://api.airtable.com/v0/${BASE_ID}/${tableId}/${proposalRecId}`,
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
          await patchProposal(tableId, proposalRecId, {
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
    await patchProposal(tableId, proposalRecId, fields);
    // Rejecting a reply draft dismisses its listing mirror so the Live Deals
    // strip stops showing it. Record_ID lookup is best-effort.
    if (action === "reject") {
      try {
        const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${tableId}/${proposalRecId}`, {
          headers: { Authorization: `Bearer ${AIRTABLE_PAT}` },
          cache: "no-store",
        });
        if (res.ok) {
          const rec = await res.json();
          await mirrorDraftState((rec.fields?.Record_ID as string) ?? null, [proposalId, proposalRecId, rec.fields?.Proposal_ID as string], "dismissed");
        }
      } catch {
        /* mirror is cosmetic on reject */
      }
    }
    return Response.json({ success: true, action });
  } catch (err) {
    console.error("[proposals] PATCH error:", err);
    return Response.json(
      { error: "Failed to update proposal", detail: String(err) },
      { status: 500 }
    );
  }
}
