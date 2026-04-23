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
    params.set("filterByFormula", '{Status}="Pending"');
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

interface ProposalCandidate {
  recordId: string;
  address: string;
  proposalType: string;
  priority: "HIGH" | "MEDIUM" | "LOW";
  rule: string;
  context: string;
}

interface RuleMatch {
  rule: string;
  total: number;
  passedTimeFilter: number;
}

function findCandidates(listings: ListingRecord[]): {
  candidates: ProposalCandidate[];
  debug: {
    statusCounts: Record<string, number>;
    rules: RuleMatch[];
  };
} {
  const candidates: ProposalCandidate[] = [];
  const statusCounts: Record<string, number> = {};
  const rules: RuleMatch[] = [];

  for (const l of listings) {
    const s = l.outreachStatus || "(empty)";
    statusCounts[s] = (statusCounts[s] || 0) + 1;
  }

  // --- FOLLOW_UP RULES ---

  // Negotiating >= 3 days → HIGH
  const negotiating = listings.filter((l) => l.outreachStatus === "Negotiating");
  const negotiatingFollowUp = negotiating.filter((l) => daysSince(l.lastContacted) >= 3);
  rules.push({ rule: "follow_up: Negotiating >= 3d", total: negotiating.length, passedTimeFilter: negotiatingFollowUp.length });
  for (const l of negotiatingFollowUp) {
    candidates.push({
      recordId: l.id, address: l.address, proposalType: "follow_up", priority: "HIGH",
      rule: "Negotiating >= 3d",
      context: `${l.address} — Negotiating, ${daysSince(l.lastContacted)} days silent. Agent: ${l.agentName}. List: $${l.listPrice.toLocaleString()}.`,
    });
  }

  // Offer Accepted >= 2 days → HIGH
  const offerAccepted = listings.filter((l) => l.outreachStatus === "Offer Accepted");
  const oaFollowUp = offerAccepted.filter((l) => daysSince(l.lastContacted) >= 2);
  rules.push({ rule: "follow_up: Offer Accepted >= 2d", total: offerAccepted.length, passedTimeFilter: oaFollowUp.length });
  for (const l of oaFollowUp) {
    candidates.push({
      recordId: l.id, address: l.address, proposalType: "follow_up", priority: "HIGH",
      rule: "Offer Accepted >= 2d",
      context: `${l.address} — Offer Accepted, ${daysSince(l.lastContacted)} days silent. Agent: ${l.agentName}. List: $${l.listPrice.toLocaleString()}.`,
    });
  }

  // Response Received >= 4 days → MEDIUM
  const responseReceived = listings.filter((l) => l.outreachStatus === "Response Received");
  const rrFollowUp = responseReceived.filter((l) => daysSince(l.lastContacted) >= 4);
  rules.push({ rule: "follow_up: Response Received >= 4d", total: responseReceived.length, passedTimeFilter: rrFollowUp.length });
  for (const l of rrFollowUp) {
    candidates.push({
      recordId: l.id, address: l.address, proposalType: "follow_up", priority: "MEDIUM",
      rule: "Response Received >= 4d",
      context: `${l.address} — Response Received, ${daysSince(l.lastContacted)} days silent. Agent: ${l.agentName}. List: $${l.listPrice.toLocaleString()}.`,
    });
  }

  // Texted >= 5 days AND <= 13 days → LOW (soft nudge window)
  const texted = listings.filter((l) => l.outreachStatus === "Texted");
  const textedFollowUp = texted.filter((l) => {
    const d = daysSince(l.lastContacted);
    return d >= 5 && d <= 13;
  });
  rules.push({ rule: "follow_up: Texted 5-13d", total: texted.length, passedTimeFilter: textedFollowUp.length });
  for (const l of textedFollowUp) {
    candidates.push({
      recordId: l.id, address: l.address, proposalType: "follow_up", priority: "LOW",
      rule: "Texted 5-13d",
      context: `${l.address} — Texted ${daysSince(l.lastContacted)} days ago, no reply yet. Agent: ${l.agentName}.`,
    });
  }

  // --- KILL_DEAD_DEAL RULES ---

  // Texted >= 14 days → HIGH
  const textedDead = texted.filter((l) => daysSince(l.lastContacted) >= 14);
  rules.push({ rule: "kill_dead_deal: Texted >= 14d", total: texted.length, passedTimeFilter: textedDead.length });
  for (const l of textedDead) {
    candidates.push({
      recordId: l.id, address: l.address, proposalType: "kill_dead_deal", priority: "HIGH",
      rule: "Texted >= 14d",
      context: `${l.address} — Texted ${daysSince(l.lastContacted)} days ago, no response logged.`,
    });
  }

  // Response Received >= 21 days → MEDIUM
  const rrDead = responseReceived.filter((l) => daysSince(l.lastContacted) >= 21);
  rules.push({ rule: "kill_dead_deal: Response Received >= 21d", total: responseReceived.length, passedTimeFilter: rrDead.length });
  for (const l of rrDead) {
    candidates.push({
      recordId: l.id, address: l.address, proposalType: "kill_dead_deal", priority: "MEDIUM",
      rule: "Response Received >= 21d",
      context: `${l.address} — Response Received but ${daysSince(l.lastContacted)} days silent. Agent ghosted.`,
    });
  }

  // Negotiating >= 21 days → HIGH
  const negotiatingDead = negotiating.filter((l) => daysSince(l.lastContacted) >= 21);
  rules.push({ rule: "kill_dead_deal: Negotiating >= 21d", total: negotiating.length, passedTimeFilter: negotiatingDead.length });
  for (const l of negotiatingDead) {
    candidates.push({
      recordId: l.id, address: l.address, proposalType: "kill_dead_deal", priority: "HIGH",
      rule: "Negotiating >= 21d",
      context: `${l.address} — Negotiating but ${daysSince(l.lastContacted)} days silent. Deal is dead.`,
    });
  }

  // --- SURFACE_STALE RULES ---

  // Emailed >= 7 days → LOW
  const emailed = listings.filter((l) => l.outreachStatus === "Emailed");
  const emailedStale = emailed.filter((l) => daysSince(l.lastContacted) >= 7);
  rules.push({ rule: "surface_stale: Emailed >= 7d", total: emailed.length, passedTimeFilter: emailedStale.length });
  for (const l of emailedStale) {
    candidates.push({
      recordId: l.id, address: l.address, proposalType: "surface_stale", priority: "LOW",
      rule: "Emailed >= 7d",
      context: `${l.address} — Emailed ${daysSince(l.lastContacted)} days ago, no response. Cold email path.`,
    });
  }

  return { candidates, debug: { statusCounts, rules } };
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
Priority: ${candidate.priority}

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
    payload.action = "flag_for_review";
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
        Priority: candidate.priority,
        Record_ID: candidate.recordId,
        Record_Address: candidate.address,
        Reasoning: `[${candidate.priority}] ${reasoning}`,
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
    const { candidates, debug } = findCandidates(listings);

    const existingPending =
      await fetchExistingPendingProposals(proposalsTableId);

    const newCandidates = candidates.filter(
      (c) => !existingPending.has(`${c.recordId}:${c.proposalType}`)
    );

    const priorityCounts = { HIGH: 0, MEDIUM: 0, LOW: 0 };
    let created = 0;
    const errors: string[] = [];

    for (const candidate of newCandidates) {
      try {
        const reasoning = await generateReasoning(candidate, ANTHROPIC_API_KEY);
        await createProposal(proposalsTableId, candidate, reasoning);
        created++;
        priorityCounts[candidate.priority]++;
      } catch (err) {
        const msg = `${candidate.address} (${candidate.proposalType}): ${String(err)}`;
        console.error(`[propose-actions] Failed:`, msg);
        errors.push(msg);
      }
    }

    return Response.json({
      scanned: listings.length,
      candidates: candidates.length,
      deduped: candidates.length - newCandidates.length,
      created,
      createdByPriority: priorityCounts,
      errors: errors.length > 0 ? errors : undefined,
      debug,
    });
  } catch (err) {
    console.error("[propose-actions] Error:", err);
    return Response.json(
      { error: "Cron failed", detail: String(err) },
      { status: 500 }
    );
  }
}
