export const runtime = "nodejs";
export const maxDuration = 60;

const AIRTABLE_PAT = process.env.AIRTABLE_PAT!;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
const LISTINGS_TABLE = "tbldMjKBgPiq45Jjs";
const MAX_PROPOSALS_PER_RUN = 50;
const AIRTABLE_BATCH_SIZE = 10;

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
      pending.add(`${f.Record_ID}:${f.Proposal_Type}`);
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

const PRIORITY_ORDER: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

function findCandidates(listings: ListingRecord[]): {
  candidates: ProposalCandidate[];
  debug: { statusCounts: Record<string, number>; rules: RuleMatch[] };
} {
  const candidates: ProposalCandidate[] = [];
  const statusCounts: Record<string, number> = {};
  const rules: RuleMatch[] = [];

  for (const l of listings) {
    statusCounts[l.outreachStatus || "(empty)"] =
      (statusCounts[l.outreachStatus || "(empty)"] || 0) + 1;
  }

  const negotiating = listings.filter((l) => l.outreachStatus === "Negotiating");
  const offerAccepted = listings.filter((l) => l.outreachStatus === "Offer Accepted");
  const responseReceived = listings.filter((l) => l.outreachStatus === "Response Received");
  const texted = listings.filter((l) => l.outreachStatus === "Texted");
  const emailed = listings.filter((l) => l.outreachStatus === "Emailed");

  function push(subset: ListingRecord[], filter: (l: ListingRecord) => boolean, type: string, priority: "HIGH" | "MEDIUM" | "LOW", ruleName: string, ctxFn: (l: ListingRecord) => string) {
    const passed = subset.filter(filter);
    rules.push({ rule: `${type}: ${ruleName}`, total: subset.length, passedTimeFilter: passed.length });
    for (const l of passed) {
      candidates.push({ recordId: l.id, address: l.address, proposalType: type, priority, rule: ruleName, context: ctxFn(l) });
    }
  }

  // FOLLOW_UP
  push(negotiating, (l) => daysSince(l.lastContacted) >= 3, "follow_up", "HIGH", "Negotiating >= 3d",
    (l) => `${l.address} — Negotiating, ${daysSince(l.lastContacted)}d silent. Agent: ${l.agentName}. List: $${l.listPrice.toLocaleString()}.`);
  push(offerAccepted, (l) => daysSince(l.lastContacted) >= 2, "follow_up", "HIGH", "Offer Accepted >= 2d",
    (l) => `${l.address} — Offer Accepted, ${daysSince(l.lastContacted)}d silent. Agent: ${l.agentName}. List: $${l.listPrice.toLocaleString()}.`);
  push(responseReceived, (l) => daysSince(l.lastContacted) >= 4, "follow_up", "MEDIUM", "Response Received >= 4d",
    (l) => `${l.address} — Response Received, ${daysSince(l.lastContacted)}d silent. Agent: ${l.agentName}. List: $${l.listPrice.toLocaleString()}.`);
  push(texted, (l) => { const d = daysSince(l.lastContacted); return d >= 5 && d <= 13; }, "follow_up", "LOW", "Texted 5-13d",
    (l) => `${l.address} — Texted ${daysSince(l.lastContacted)}d ago, no reply. Agent: ${l.agentName}.`);

  // KILL_DEAD_DEAL
  push(texted, (l) => daysSince(l.lastContacted) >= 14, "kill_dead_deal", "HIGH", "Texted >= 14d",
    (l) => `${l.address} — Texted ${daysSince(l.lastContacted)}d ago, no response.`);
  push(responseReceived, (l) => daysSince(l.lastContacted) >= 21, "kill_dead_deal", "MEDIUM", "Response Received >= 21d",
    (l) => `${l.address} — Response Received but ${daysSince(l.lastContacted)}d silent. Agent ghosted.`);
  push(negotiating, (l) => daysSince(l.lastContacted) >= 21, "kill_dead_deal", "HIGH", "Negotiating >= 21d",
    (l) => `${l.address} — Negotiating but ${daysSince(l.lastContacted)}d silent. Dead.`);

  // SURFACE_STALE
  push(emailed, (l) => daysSince(l.lastContacted) >= 7, "surface_stale", "LOW", "Emailed >= 7d",
    (l) => `${l.address} — Emailed ${daysSince(l.lastContacted)}d ago, no response. Cold email path.`);

  // Sort: HIGH first, then MEDIUM, then LOW. Within same priority, oldest silence first.
  candidates.sort((a, b) => {
    const pd = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (pd !== 0) return pd;
    return 0; // stable sort preserves insertion order (oldest listings first from Airtable)
  });

  return { candidates, debug: { statusCounts, rules } };
}

function buildReasoning(candidate: ProposalCandidate): string {
  const parts: Record<string, string> = {
    "follow_up": `Silent for multiple days after ${candidate.rule.split(" ")[0]} status. A follow-up nudge maintains deal momentum and signals continued interest.`,
    "kill_dead_deal": `No response after extended silence (${candidate.rule}). Marking dead frees pipeline focus and prevents wasted outreach on unresponsive agents.`,
    "surface_stale": `Cold email with no response for 7+ days. Flagging for review to decide on re-approach strategy or channel switch.`,
  };
  return parts[candidate.proposalType] || "Auto-generated proposal based on silence threshold.";
}

async function batchCreateProposals(
  tableId: string,
  candidates: ProposalCandidate[]
): Promise<{ created: number; errors: string[] }> {
  let created = 0;
  const errors: string[] = [];

  for (let i = 0; i < candidates.length; i += AIRTABLE_BATCH_SIZE) {
    const batch = candidates.slice(i, i + AIRTABLE_BATCH_SIZE);
    const records = batch.map((c) => {
      const payload: Record<string, unknown> = { recordId: c.recordId };
      if (c.proposalType === "follow_up") payload.action = "open_draft_modal";
      else if (c.proposalType === "kill_dead_deal") payload.action = "set_outreach_status_dead";
      else if (c.proposalType === "surface_stale") payload.action = "flag_for_review";

      return {
        fields: {
          Proposal_ID: `${c.proposalType}-${Date.now()}-${i + batch.indexOf(c)}`,
          Proposal_Type: c.proposalType,
          Priority: c.priority,
          Record_ID: c.recordId,
          Record_Address: c.address,
          Reasoning: `[${c.priority}] ${buildReasoning(c)}`,
          Suggested_Action_Payload: JSON.stringify(payload),
          Status: "Pending",
        },
      };
    });

    try {
      const res = await fetch(
        `https://api.airtable.com/v0/${BASE_ID}/${tableId}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${AIRTABLE_PAT}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ records, typecast: true }),
        }
      );

      if (!res.ok) {
        const errText = await res.text();
        errors.push(`Batch ${Math.floor(i / AIRTABLE_BATCH_SIZE)}: ${res.status} ${errText}`);
      } else {
        created += batch.length;
      }
    } catch (err) {
      errors.push(`Batch ${Math.floor(i / AIRTABLE_BATCH_SIZE)}: ${String(err)}`);
    }
  }

  return { created, errors };
}

export async function GET() {
  return handleCron();
}

export async function POST() {
  return handleCron();
}

async function handleCron() {
  const proposalsTableId = getProposalsTableId();

  if (!AIRTABLE_PAT) {
    return Response.json({ error: "AIRTABLE_PAT not set" }, { status: 500 });
  }
  if (!proposalsTableId) {
    return Response.json(
      { error: "AGENT_PROPOSALS_TABLE_ID not set. Run POST /api/scaffold-tables first, then set the env var." },
      { status: 500 }
    );
  }

  try {
    const listings = await fetchListings();
    const { candidates, debug } = findCandidates(listings);

    // Pre-flight dedupe: fetch all pending proposals once into memory
    const existingPending = await fetchExistingPendingProposals(proposalsTableId);

    const newCandidates = candidates.filter(
      (c) => !existingPending.has(`${c.recordId}:${c.proposalType}`)
    );

    // Cap at MAX_PROPOSALS_PER_RUN (already sorted by priority)
    const capped = newCandidates.slice(0, MAX_PROPOSALS_PER_RUN);
    const skipped = newCandidates.length - capped.length;

    // Batch insert (no Claude API calls — reasoning is template-based)
    const { created, errors } = await batchCreateProposals(proposalsTableId, capped);

    const priorityCounts = { HIGH: 0, MEDIUM: 0, LOW: 0 };
    for (const c of capped) priorityCounts[c.priority]++;

    return Response.json({
      scanned: listings.length,
      candidatesFound: candidates.length,
      deduped: candidates.length - newCandidates.length,
      capped: capped.length,
      skippedForNextRun: skipped,
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
