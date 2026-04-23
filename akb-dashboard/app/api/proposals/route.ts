const AIRTABLE_PAT = process.env.AIRTABLE_PAT!;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";

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
        });
      }
      offset = data.offset;
    } while (offset);

    return Response.json(allProposals);
  } catch (err) {
    console.error("[proposals] Error:", err);
    return Response.json(
      { error: "Failed to fetch proposals", detail: String(err) },
      { status: 500 }
    );
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

  let body: { proposalId: string; action: "approve" | "reject" | "snooze"; reason?: string };
  try {
    const text = await req.text();
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { proposalId, action, reason } = body;
  if (!proposalId || !action) {
    return Response.json(
      { error: "Missing proposalId or action" },
      { status: 400 }
    );
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

    return Response.json({ success: true, action });
  } catch (err) {
    console.error("[proposals] PATCH error:", err);
    return Response.json(
      { error: "Failed to update proposal", detail: String(err) },
      { status: 500 }
    );
  }
}
