import Anthropic from "@anthropic-ai/sdk";

export const runtime = "nodejs";
export const maxDuration = 60;

const AIRTABLE_PAT = process.env.AIRTABLE_PAT!;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
const LISTINGS_TABLE = "tbldMjKBgPiq45Jjs";

function getProposalsTableId(): string | null {
  return process.env.AGENT_PROPOSALS_TABLE_ID ?? null;
}

interface ListingRecord {
  id: string;
  address: string;
  outreachStatus: string;
  lastContacted: string | null;
  notes: string;
  agentName: string;
  listPrice: number;
}

async function fetchListings(): Promise<ListingRecord[]> {
  const fieldIds = [
    "fldwvp72hKTfiHHjj", // address
    "fldGIgqwyCJg4uFyv", // outreachStatus
    "fldbRrOW3IEoLtnFE", // lastContacted
    "fldwKGxZly6O8qyPu", // notes
    "fld69oB0no6tfguom", // agentName
    "fld9J3Vi9fTq3zzMU", // listPrice
  ];

  const params = new URLSearchParams();
  fieldIds.forEach((f) => params.append("fields[]", f));
  params.set("returnFieldsByFieldId", "true");

  const allRecords: ListingRecord[] = [];
  let offset: string | undefined;

  do {
    const p = new URLSearchParams(params);
    if (offset) p.set("offset", offset);

    const res = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/${LISTINGS_TABLE}?${p.toString()}`,
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
      allRecords.push({
        id: rec.id,
        address: (f.fldwvp72hKTfiHHjj as string) ?? "",
        outreachStatus: (f.fldGIgqwyCJg4uFyv as string) ?? "",
        lastContacted: (f.fldbRrOW3IEoLtnFE as string) ?? null,
        notes: (f.fldwKGxZly6O8qyPu as string) ?? "",
        agentName: (f.fld69oB0no6tfguom as string) ?? "",
        listPrice: (f.fld9J3Vi9fTq3zzMU as number) ?? 0,
      });
    }
    offset = data.offset;
  } while (offset);

  return allRecords;
}

async function fetchExistingPendingProposals(
  tableId: string
): Promise<Set<string>> {
  const pending = new Set<string>();
  let offset: string | undefined;

  do {
    const params = new URLSearchParams();
    params.set(
      "filterByFormula",
      '{Status}="Pending"'
    );
    params.set("fields[]", "Record_ID");
    params.append("fields[]", "Proposal_Type");
    if (offset) params.set("offset", offset);

    const res = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/${tableId}?${params.toString()}`,
      {
        headers: { Authorization: `Bearer ${AIRTABLE_PAT}` },
        cache: "no-store",
      }
    );

    if (!res.ok) break;

    const data = await res.json();
    for (const rec of data.records) {
      const f = rec.fields as Record<string, unknown>;
      const key = `${f.Record_ID}:${f.Proposal_Type}`;
      pending.add(key);
    }
    offset = data.offset;
  } while (offset);

  return pending;
}

function daysSince(dateStr: string | null): number {
  if (!dateStr) return 999;
  return Math.floor(
    (Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24)
  );
}

function hoursSince(dateStr: string | null): number {
  if (!dateStr) return 9999;
  return Math.floor(
    (Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60)
  );
}

interface ProposalCandidate {
  recordId: string;
  address: string;
  proposalType: string;
  context: string;
}

function findCandidates(listings: ListingRecord[]): ProposalCandidate[] {
  const candidates: ProposalCandidate[] = [];

  for (const l of listings) {
    // draft_followup: Negotiating AND last contact > 3 days
    if (l.outreachStatus === "Negotiating" && daysSince(l.lastContacted) >= 3) {
      candidates.push({
        recordId: l.id,
        address: l.address,
        proposalType: "follow_up",
        context: `${l.address} — Negotiating, ${daysSince(l.lastContacted)} days silent. Agent: ${l.agentName}. List: $${l.listPrice.toLocaleString()}.`,
      });
    }

    // mark_dead: Texted AND last contact > 14 days AND no response in notes
    if (
      l.outreachStatus === "Texted" &&
      daysSince(l.lastContacted) >= 14 &&
      !l.notes.toLowerCase().includes("response") &&
      !l.notes.toLowerCase().includes("replied")
    ) {
      candidates.push({
        recordId: l.id,
        address: l.address,
        proposalType: "kill_dead_deal",
        context: `${l.address} — Texted ${daysSince(l.lastContacted)} days ago, no response logged.`,
      });
    }

    // send_buyer_nudge: Offer Accepted AND last contact > 48 hours
    if (
      l.outreachStatus === "Offer Accepted" &&
      hoursSince(l.lastContacted) >= 48
    ) {
      candidates.push({
        recordId: l.id,
        address: l.address,
        proposalType: "surface_stale",
        context: `${l.address} — Offer Accepted, ${hoursSince(l.lastContacted)} hours since last contact. Agent: ${l.agentName}.`,
      });
    }
  }

  return candidates;
}

async function generateReasoning(
  candidate: ProposalCandidate,
  apiKey: string
): Promise<string> {
  const client = new Anthropic({ apiKey });
  const message = await client.messages.create({
    model: "claude-sonnet-4-5-20250514",
    max_tokens: 256,
    messages: [
      {
        role: "user",
        content: `You are an operations assistant for AKB Solutions wholesale real estate. Generate a 1-2 sentence reasoning for why we should take this action.

Record: ${candidate.context}
Proposed action: ${candidate.proposalType}

Return only the reasoning text, no JSON.`,
      },
    ],
  });
  const textBlock = message.content.find((b) => b.type === "text");
  return textBlock?.type === "text" ? textBlock.text : "Auto-generated proposal.";
}

async function createProposal(
  tableId: string,
  candidate: ProposalCandidate,
  reasoning: string
): Promise<void> {
  const payload: Record<string, unknown> = { recordId: candidate.recordId };
  if (candidate.proposalType === "follow_up") {
    payload.action = "open_draft_modal";
  } else if (candidate.proposalType === "kill_dead_deal") {
    payload.action = "set_outreach_status_dead";
  } else if (candidate.proposalType === "surface_stale") {
    payload.action = "open_draft_modal";
  }

  await fetch(`https://api.airtable.com/v0/${BASE_ID}/${tableId}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${AIRTABLE_PAT}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      fields: {
        Proposal_ID: `${candidate.proposalType}-${Date.now()}`,
        Proposal_Type: candidate.proposalType,
        Record_ID: candidate.recordId,
        Record_Address: candidate.address,
        Reasoning: reasoning,
        Suggested_Action_Payload: JSON.stringify(payload),
        Status: "Pending",
      },
      typecast: true,
    }),
  });
}

export async function GET() {
  return handleCron();
}

export async function POST() {
  return handleCron();
}

async function handleCron() {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  const proposalsTableId = getProposalsTableId();

  if (!AIRTABLE_PAT) {
    return Response.json({ error: "AIRTABLE_PAT not set" }, { status: 500 });
  }
  if (!ANTHROPIC_API_KEY) {
    return Response.json(
      { error: "ANTHROPIC_API_KEY not set" },
      { status: 500 }
    );
  }
  if (!proposalsTableId) {
    return Response.json(
      {
        error:
          "AGENT_PROPOSALS_TABLE_ID not set. Run POST /api/scaffold-tables first, then set the env var.",
      },
      { status: 500 }
    );
  }

  try {
    const listings = await fetchListings();
    const candidates = findCandidates(listings);

    const existingPending =
      await fetchExistingPendingProposals(proposalsTableId);

    const newCandidates = candidates.filter(
      (c) => !existingPending.has(`${c.recordId}:${c.proposalType}`)
    );

    let created = 0;
    for (const candidate of newCandidates) {
      try {
        const reasoning = await generateReasoning(
          candidate,
          ANTHROPIC_API_KEY
        );
        await createProposal(proposalsTableId, candidate, reasoning);
        created++;
      } catch (err) {
        console.error(
          `[propose-actions] Failed for ${candidate.address}:`,
          err
        );
      }
    }

    return Response.json({
      scanned: listings.length,
      candidates: candidates.length,
      deduped: candidates.length - newCandidates.length,
      created,
    });
  } catch (err) {
    console.error("[propose-actions] Error:", err);
    return Response.json(
      { error: "Cron failed", detail: String(err) },
      { status: 500 }
    );
  }
}
