// Server-side conveyor feed (escalation + digest crons). Reads the same
// three fast sources the client ConveyorFeed merges — Pending proposals,
// open action items, curated priorities — through the SAME pure mappers
// (lib/conveyor/model), so a texted escalation describes exactly the card
// the operator will see when they tap the link.

import {
  buildConveyor,
  type ActionItemRow,
  type ConveyorItem,
  type PriorityRow,
  type ProposalRow,
} from "@/lib/conveyor/model";
import { rankOperatorActions, readOperatorActions } from "@/lib/maverick/operator-actions";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";

const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
const ACTION_ITEMS_TABLE = "tblZRunAe5OaMTRCM";

async function fetchPendingProposals(): Promise<ProposalRow[]> {
  const pat = process.env.AIRTABLE_PAT;
  const tableId = process.env.AGENT_PROPOSALS_TABLE_ID;
  if (!pat || !tableId) return [];
  const out: ProposalRow[] = [];
  let offset: string | undefined;
  do {
    const p = new URLSearchParams();
    p.set("filterByFormula", `{Status}="Pending"`);
    if (offset) p.set("offset", offset);
    const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${tableId}?${p.toString()}`, {
      headers: { Authorization: `Bearer ${pat}` },
      cache: "no-store",
    });
    if (!res.ok) break;
    const data = (await res.json()) as {
      records?: Array<{ id: string; createdTime?: string; fields: Record<string, unknown> }>;
      offset?: string;
    };
    for (const rec of data.records ?? []) {
      const f = rec.fields;
      const snooze = (f.Snooze_Until as string) ?? null;
      if (snooze && new Date(snooze) > new Date()) continue;
      out.push({
        id: rec.id,
        proposalType: (f.Proposal_Type as string) ?? "",
        recordId: (f.Record_ID as string) ?? "",
        recordAddress: (f.Record_Address as string) ?? "",
        reasoning: (f.Reasoning as string) ?? "",
        actionPayload: (f.Suggested_Action_Payload as string) ?? "{}",
        createdTime: rec.createdTime ?? null,
      });
    }
    offset = data.offset;
  } while (offset);
  return out;
}

async function fetchOpenActionItems(): Promise<ActionItemRow[]> {
  const pat = process.env.AIRTABLE_PAT;
  if (!pat) return [];
  // Mirrors /api/operator-actions: open/in_progress within 14 days.
  const formula = `AND(OR({Status}='open',{Status}='in_progress'), IS_AFTER(CREATED_TIME(), DATEADD(NOW(), -14, 'days')))`;
  const res = await fetch(
    `https://api.airtable.com/v0/${BASE_ID}/${ACTION_ITEMS_TABLE}?filterByFormula=${encodeURIComponent(formula)}&pageSize=100`,
    { headers: { Authorization: `Bearer ${pat}` }, cache: "no-store" },
  ).catch(() => null);
  if (!res || !res.ok) return [];
  const data = (await res.json()) as { records?: Array<{ id: string; fields: Record<string, unknown> }> };
  return (data.records ?? []).map((r) => ({
    id: r.id,
    title: typeof r.fields.Title === "string" ? (r.fields.Title as string) : "(untitled)",
    sourceRecordId: typeof r.fields.Source_Record_Id === "string" ? (r.fields.Source_Record_Id as string) : null,
    actionRequired: typeof r.fields.Action_Required === "string" ? (r.fields.Action_Required as string) : null,
    context: typeof r.fields.Context === "string" ? (r.fields.Context as string) : null,
    verbatimReply: typeof r.fields.Verbatim_Reply === "string" ? (r.fields.Verbatim_Reply as string) : null,
    priority: typeof r.fields.Priority === "string" ? (r.fields.Priority as string) : "medium",
    createdAt: typeof r.fields.Created_At === "string" ? (r.fields.Created_At as string) : null,
  }));
}

async function fetchPriorities(): Promise<PriorityRow[]> {
  if (!kvConfigured()) return [];
  try {
    const all = await readOperatorActions(kvProd);
    return rankOperatorActions(all, new Date().toISOString()).map((a) => ({
      id: a.id,
      title: a.title,
      why: a.why,
      instructions: a.instructions ?? null,
      href: a.href ?? null,
      revenueUsd: a.revenueUsd ?? null,
      deadlineAt: a.deadlineAt ?? null,
      postedAt: a.postedAt,
    }));
  } catch {
    return [];
  }
}

/** The ranked feed as the crons see it — brief cards excluded (they carry
 *  no sourced $ and duplicate proposals; escalation never needs them).
 *  Inherits the machine-work gate: housekeeping proposals can neither
 *  render NOR text the operator's phone. */
export async function fetchConveyorItemsServer(nowIso: string): Promise<ConveyorItem[]> {
  const [proposals, actionItems, priorities] = await Promise.all([
    fetchPendingProposals(),
    fetchOpenActionItems(),
    fetchPriorities(),
  ]);
  return buildConveyor({ proposals, actionItems, priorities, broCards: [] }, nowIso).items;
}
