// M6 — Unmatched_Replies store I/O. @agent: outreach / data_federation
//
// The fail-closed catch-all's persistence layer. Writes are idempotent by Key
// (channel:externalId) so a re-delivered webhook or a re-run poll never
// double-creates. Reads back the New rows for the morning-briefing surface.
//
// Same REST pattern as lib/buyer-median-store.ts. Requires AIRTABLE_PAT — a
// missing PAT THROWS (the caller surfaces it; we never silently drop a reply).

import type { UnmatchedReplyFields } from "./catch-all";

const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
export const UNMATCHED_REPLIES_TABLE = process.env.UNMATCHED_REPLIES_TABLE_ID || "tblh4m0hG7KoZ7dN5";

function requirePat(): string {
  if (!AIRTABLE_PAT) throw new Error("AIRTABLE_PAT not set");
  return AIRTABLE_PAT;
}

interface AirtableRow {
  id: string;
  fields: Record<string, unknown>;
}

export interface UnmatchedReplyRecord {
  recordId: string;
  key: string;
  channel: string;
  sender: string;
  body: string;
  receivedAt: string;
  classification: string;
  tier: string;
  escalate: boolean;
  amounts: string;
  reasoning: string;
  status: string;
}

async function findByKey(key: string): Promise<AirtableRow | null> {
  const pat = requirePat();
  const url = new URL(`https://api.airtable.com/v0/${BASE_ID}/${UNMATCHED_REPLIES_TABLE}`);
  url.searchParams.set("filterByFormula", `{Key}=${JSON.stringify(key)}`);
  url.searchParams.set("maxRecords", "1");
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${pat}` }, cache: "no-store" });
  if (!res.ok) throw new Error(`Unmatched_Replies list ${res.status}: ${await res.text().catch(() => "")}`);
  const body = (await res.json()) as { records?: AirtableRow[] };
  return body.records?.[0] ?? null;
}

/** Idempotent create. If a row with the same Key already exists, returns it
 *  without creating a duplicate. */
export async function createUnmatchedReply(
  fields: UnmatchedReplyFields,
): Promise<{ recordId: string; created: boolean }> {
  const pat = requirePat();
  const key = String(fields.Key ?? "");
  if (!key) throw new Error("createUnmatchedReply: missing Key");

  const existing = await findByKey(key);
  if (existing) return { recordId: existing.id, created: false };

  const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${UNMATCHED_REPLIES_TABLE}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json" },
    body: JSON.stringify({ records: [{ fields }], typecast: true }),
  });
  if (!res.ok) throw new Error(`Unmatched_Replies create ${res.status}: ${await res.text().catch(() => "")}`);
  const body = (await res.json()) as { records?: Array<{ id: string }> };
  const id = body.records?.[0]?.id;
  if (!id) throw new Error("Unmatched_Replies create returned no record id");
  return { recordId: id, created: true };
}

function rowToRecord(rec: AirtableRow): UnmatchedReplyRecord {
  const f = rec.fields;
  const s = (k: string): string => (typeof f[k] === "string" ? (f[k] as string) : "");
  return {
    recordId: rec.id,
    key: s("Key"),
    channel: s("Channel"),
    sender: s("Sender"),
    body: s("Body"),
    receivedAt: s("Received_At"),
    classification: s("Classification"),
    tier: s("Tier"),
    escalate: f["Escalate"] === true,
    amounts: s("Amounts"),
    reasoning: s("Reasoning"),
    status: s("Status"),
  };
}

/** Read unmatched replies for the operator surface. Defaults to the New ones
 *  (the unseen backlog), newest first. */
export async function listUnmatchedReplies(opts: { status?: string; max?: number } = {}): Promise<UnmatchedReplyRecord[]> {
  const pat = requirePat();
  const status = opts.status ?? "New";
  const url = new URL(`https://api.airtable.com/v0/${BASE_ID}/${UNMATCHED_REPLIES_TABLE}`);
  if (status) url.searchParams.set("filterByFormula", `{Status}=${JSON.stringify(status)}`);
  url.searchParams.set("pageSize", String(Math.max(1, Math.min(100, opts.max ?? 50))));
  url.searchParams.set("sort[0][field]", "Received_At");
  url.searchParams.set("sort[0][direction]", "desc");
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${pat}` }, cache: "no-store" });
  if (!res.ok) throw new Error(`Unmatched_Replies list ${res.status}: ${await res.text().catch(() => "")}`);
  const body = (await res.json()) as { records?: AirtableRow[] };
  return (body.records ?? []).map(rowToRecord);
}
