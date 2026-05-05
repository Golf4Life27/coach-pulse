import { sendMessage } from "@/lib/quo";
import { updateListingRecord } from "@/lib/airtable";

export const runtime = "nodejs";

const AIRTABLE_PAT = process.env.AIRTABLE_PAT!;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";

function getProposalsTableId(): string | null {
  return process.env.AGENT_PROPOSALS_TABLE_ID ?? null;
}

export async function POST(req: Request) {
  let body: {
    proposalId: string;
    to: string;
    message: string;
    recordId?: string;
  };

  try {
    const text = await req.text();
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { proposalId, to, message, recordId } = body;
  if (!proposalId || !to || !message) {
    return Response.json(
      { error: "Missing proposalId, to, or message" },
      { status: 400 }
    );
  }

  if (!process.env.QUO_API_KEY) {
    return Response.json({ error: "QUO_API_KEY not set" }, { status: 500 });
  }

  try {
    await sendMessage(to, message);
  } catch (err) {
    console.error("[jarvis-send] Quo send failed:", err);
    return Response.json(
      { error: "Failed to send via Quo", detail: String(err) },
      { status: 500 }
    );
  }

  // Mark proposal as Executed
  const proposalsTableId = getProposalsTableId();
  if (proposalsTableId) {
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
              Status: "Executed",
              Reviewed_At: new Date().toISOString(),
            },
            typecast: true,
          }),
        }
      );
    } catch (err) {
      console.error("[jarvis-send] Failed to mark proposal Executed:", err);
    }
  }

  // Stamp Last_Outbound_At on the listing
  if (recordId) {
    try {
      await updateListingRecord(recordId, {
        fldaK4lR5UNvycg11: new Date().toISOString(),
      });
    } catch (err) {
      console.error("[jarvis-send] Failed to stamp Last_Outbound_At:", err);
    }
  }

  return Response.json({ success: true });
}
