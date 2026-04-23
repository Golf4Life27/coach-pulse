// POST /api/scaffold-tables — creates Agent_Proposals, ZIP_Intelligence, Confirmed_Flips
export const runtime = "nodejs";
export const maxDuration = 30;

const AIRTABLE_PAT = process.env.AIRTABLE_PAT!;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";

async function createTable(
  name: string,
  fields: Array<{ name: string; type: string; options?: Record<string, unknown> }>
): Promise<{ id: string; name: string }> {
  const res = await fetch(
    `https://api.airtable.com/v0/meta/bases/${BASE_ID}/tables`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AIRTABLE_PAT}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name, fields }),
    }
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to create ${name}: ${res.status} ${errText}`);
  }
  const data = await res.json();
  return { id: data.id, name: data.name };
}

export async function POST() {
  if (!AIRTABLE_PAT) {
    return Response.json({ error: "AIRTABLE_PAT not set" }, { status: 500 });
  }

  const results: Record<string, unknown> = {};

  try {
    results.agent_proposals = await createTable("Agent_Proposals", [
      { name: "Proposal_ID", type: "autoNumber" },
      { name: "Proposal_Type", type: "singleSelect", options: { choices: [
        { name: "follow_up" }, { name: "kill_dead_deal" },
        { name: "suggest_dispo_price" }, { name: "surface_stale" },
        { name: "flag_price_drop" },
      ]}},
      { name: "Record_ID", type: "singleLineText" },
      { name: "Record_Address", type: "singleLineText" },
      { name: "Reasoning", type: "multilineText" },
      { name: "Suggested_Action_Payload", type: "multilineText" },
      { name: "Status", type: "singleSelect", options: { choices: [
        { name: "Pending" }, { name: "Approved" }, { name: "Rejected" },
        { name: "Snoozed" }, { name: "Executed" },
      ]}},
      { name: "Reviewed_At", type: "dateTime", options: { timeZone: "America/Chicago", dateFormat: { name: "us" }, timeFormat: { name: "12hour" } }},
      { name: "Snooze_Until", type: "dateTime", options: { timeZone: "America/Chicago", dateFormat: { name: "us" }, timeFormat: { name: "12hour" } }},
    ]);
  } catch (err) {
    results.agent_proposals = { error: String(err) };
  }

  try {
    results.zip_intelligence = await createTable("ZIP_Intelligence", [
      { name: "ZIP", type: "singleLineText" },
      { name: "City", type: "singleLineText" },
      { name: "State", type: "singleLineText" },
      { name: "Market", type: "singleLineText" },
      { name: "Tier", type: "number", options: { precision: 0 } },
      { name: "Avg_Buy_Price", type: "number", options: { precision: 0 } },
      { name: "Avg_ARV", type: "number", options: { precision: 0 } },
      { name: "Top_Buyer_1", type: "singleLineText" },
      { name: "Top_Buyer_2", type: "singleLineText" },
      { name: "Top_Buyer_3", type: "singleLineText" },
      { name: "Last_Refresh_Date", type: "date", options: { dateFormat: { name: "us" } }},
      { name: "Notes", type: "multilineText" },
    ]);
  } catch (err) {
    results.zip_intelligence = { error: String(err) };
  }

  try {
    results.confirmed_flips = await createTable("Confirmed_Flips", [
      { name: "Property_Address", type: "singleLineText" },
      { name: "Buyer_LLC", type: "singleLineText" },
      { name: "Buyer_Phone", type: "singleLineText" },
      { name: "Buyer_Email", type: "singleLineText" },
      { name: "Buy_Price", type: "number", options: { precision: 0 } },
      { name: "Buy_Date", type: "date", options: { dateFormat: { name: "us" } }},
      { name: "Sell_Price", type: "number", options: { precision: 0 } },
      { name: "Sell_Date", type: "date", options: { dateFormat: { name: "us" } }},
      { name: "Source", type: "singleLineText" },
    ]);
  } catch (err) {
    results.confirmed_flips = { error: String(err) };
  }

  return Response.json({
    message: "Table scaffold complete. Save the table IDs below and set AGENT_PROPOSALS_TABLE_ID as a Vercel env var.",
    results,
  });
}
