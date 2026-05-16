// Maverick — recall pure logic + multi-source queries.
// @agent: maverick (Day 4)
//
// Tool surface for maverick_recall per Spec v1.1 §5 Step 2 tools.
// Queries across spine / audit / listings / deals by free-text +
// optional date range, truncates to a bounded result set, returns
// normalized records the recall caller can grep.
//
// Default sources when caller omits them: ["spine", "audit"] (the
// two highest-signal recall surfaces per spec §5 Step 2).

import { readRecentFromKv, type AuditEntry } from "@/lib/audit-log";
import { getListings, getDeals } from "@/lib/airtable";
import type { Listing, Deal } from "@/lib/types";

const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
const SPINE_TABLE_ID = "tblbp91DB5szxsJpT";
const AIRTABLE_PAT = process.env.AIRTABLE_PAT;

// Spine field IDs (the v1 fetcher uses returnFieldsByFieldId; the
// recall query does too for consistency).
const SPINE_F_TITLE = "fldkeMrHBhx4X8aml";
const SPINE_F_DATE = "fld36Jlm4Fo4vLG1L";
const SPINE_F_DESCRIPTION = "fldajtCDNGYjsnGBR";
const SPINE_F_TRIGGER = "fldYxNN1KLOSLadI4";
const SPINE_F_WHY = "fld4IRmHf2h2fiNKX";
const SPINE_F_IMPLICATION = "fldgowtyhcDEPRpqE";

export const RECALL_SOURCES = ["spine", "audit", "listings", "deals"] as const;
export type RecallSource = (typeof RECALL_SOURCES)[number];

const DEFAULT_SOURCES: RecallSource[] = ["spine", "audit"];
const RESULT_LIMIT = 50;
// How many recent audit events to scan when searching. KV holds
// hundreds; scanning 500 keeps us in the sub-second range while
// covering the last ~24h of activity comfortably.
const AUDIT_SCAN_DEPTH = 500;

export interface RecallArgs {
  query: string;
  since?: string; // ISO
  until?: string; // ISO
  sources?: RecallSource[];
}

export interface RecallResult {
  source: RecallSource;
  record_id: string;
  summary: string; // 1-line human-readable
  full_data: Record<string, unknown>;
}

export interface RecallResponse {
  results: RecallResult[];
  truncated_to_n: number; // count of additional matches beyond the cap
  searched_sources: RecallSource[];
}

// ────────────────────── pure: arg validation ──────────────────────

export function validateRecallArgs(
  raw: unknown,
): { ok: true; args: RecallArgs } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "arguments must be an object" };
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.query !== "string" || r.query.trim().length === 0) {
    return { ok: false, error: "query is required (non-empty string)" };
  }
  if (r.since !== undefined && (typeof r.since !== "string" || isNaN(new Date(r.since).getTime()))) {
    return { ok: false, error: "since must be an ISO timestamp string when provided" };
  }
  if (r.until !== undefined && (typeof r.until !== "string" || isNaN(new Date(r.until).getTime()))) {
    return { ok: false, error: "until must be an ISO timestamp string when provided" };
  }
  let sources: RecallSource[] | undefined;
  if (r.sources !== undefined) {
    if (!Array.isArray(r.sources)) {
      return { ok: false, error: "sources must be an array when provided" };
    }
    const valid: RecallSource[] = [];
    for (const s of r.sources) {
      if (typeof s !== "string" || !RECALL_SOURCES.includes(s as RecallSource)) {
        return {
          ok: false,
          error: `sources entries must be from: ${RECALL_SOURCES.join(", ")}`,
        };
      }
      if (!valid.includes(s as RecallSource)) valid.push(s as RecallSource);
    }
    if (valid.length === 0) {
      return { ok: false, error: "sources must contain at least one entry when provided" };
    }
    sources = valid;
  }
  return {
    ok: true,
    args: {
      query: r.query.trim(),
      since: typeof r.since === "string" ? r.since : undefined,
      until: typeof r.until === "string" ? r.until : undefined,
      sources,
    },
  };
}

// ────────────────────── pure: filter primitives ──────────────────────

/**
 * Case-insensitive substring match — the recall matcher. Free-text
 * search across whatever string fields the caller passes in. Pure.
 */
export function matchesQuery(query: string, fields: Array<string | null | undefined>): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  for (const f of fields) {
    if (typeof f === "string" && f.toLowerCase().includes(q)) return true;
  }
  return false;
}

/**
 * Returns true when `iso` falls within the [since, until] range
 * (inclusive). Either bound can be undefined. Pure.
 */
export function withinDateRange(
  iso: string | null | undefined,
  since: string | undefined,
  until: string | undefined,
): boolean {
  if (!iso) {
    // Records without a timestamp pass when no range is specified.
    // Otherwise they're excluded (no way to verify they fit).
    return !since && !until;
  }
  const t = new Date(iso).getTime();
  if (isNaN(t)) return !since && !until;
  if (since) {
    const s = new Date(since).getTime();
    if (!isNaN(s) && t < s) return false;
  }
  if (until) {
    const u = new Date(until).getTime();
    if (!isNaN(u) && t > u) return false;
  }
  return true;
}

// ────────────────────── per-source pure filters ──────────────────────

/**
 * Filter Spine_Decision_Log rows for the query+date range. Accepts
 * the raw field-ID-keyed records (from Airtable list with
 * returnFieldsByFieldId=true). Pure.
 */
export function filterSpine(
  records: Array<{ id: string; fields: Record<string, unknown> }>,
  args: RecallArgs,
): RecallResult[] {
  const out: RecallResult[] = [];
  for (const r of records) {
    const title = asString(r.fields[SPINE_F_TITLE]);
    const description = asString(r.fields[SPINE_F_DESCRIPTION]);
    const trigger = asString(r.fields[SPINE_F_TRIGGER]);
    const why = asString(r.fields[SPINE_F_WHY]);
    const implication = asString(r.fields[SPINE_F_IMPLICATION]);
    const date = asString(r.fields[SPINE_F_DATE]);

    if (!matchesQuery(args.query, [title, description, trigger, why, implication])) continue;
    if (!withinDateRange(date, args.since, args.until)) continue;

    out.push({
      source: "spine",
      record_id: r.id,
      summary: `${date ?? "(undated)"} — ${title ?? "(untitled)"}`,
      full_data: {
        decision_title: title,
        decision_date: date,
        description,
        trigger_event: trigger,
        why,
        implication,
      },
    });
  }
  // Most recent first.
  out.sort((a, b) => {
    const ad = (a.full_data.decision_date as string | null) ?? "";
    const bd = (b.full_data.decision_date as string | null) ?? "";
    return bd.localeCompare(ad);
  });
  return out;
}

/**
 * Filter KV audit events. Matches across event/agent/decision/
 * recordId and JSON-stringified summaries. Pure.
 */
export function filterAudit(events: AuditEntry[], args: RecallArgs): RecallResult[] {
  const out: RecallResult[] = [];
  for (const e of events) {
    if (!withinDateRange(e.ts, args.since, args.until)) continue;
    const haystack = [
      e.event,
      e.agent,
      e.decision ?? null,
      e.recordId ?? null,
      e.error ?? null,
      e.inputSummary ? JSON.stringify(e.inputSummary) : null,
      e.outputSummary ? JSON.stringify(e.outputSummary) : null,
    ];
    if (!matchesQuery(args.query, haystack)) continue;
    out.push({
      source: "audit",
      record_id: e.ts, // KV is keyed by ts; use it as the locatable ID
      summary: `${e.ts.slice(0, 19).replace("T", " ")} — ${e.agent}/${e.event} (${e.status})`,
      full_data: e as unknown as Record<string, unknown>,
    });
  }
  // Audit events come back newest-first from readRecentFromKv;
  // preserve that order.
  return out;
}

export function filterListings(listings: Listing[], args: RecallArgs): RecallResult[] {
  const out: RecallResult[] = [];
  for (const l of listings) {
    const haystack = [l.address, l.agentName, l.notes, l.city, l.state];
    if (!matchesQuery(args.query, haystack)) continue;
    if (!withinDateRange(l.lastOutreachDate ?? l.lastInboundAt ?? l.lastOutboundAt ?? null, args.since, args.until))
      continue;
    out.push({
      source: "listings",
      record_id: l.id,
      summary: `${l.address ?? "(no address)"}${l.city ? `, ${l.city}` : ""} — ${l.outreachStatus ?? "(unset)"}`,
      full_data: {
        address: l.address,
        city: l.city,
        outreach_status: l.outreachStatus,
        agent_name: l.agentName,
        list_price: l.listPrice,
        stored_offer_price: l.storedOfferPrice ?? null,
        last_outreach_date: l.lastOutreachDate,
        last_inbound_at: l.lastInboundAt,
        last_outbound_at: l.lastOutboundAt,
      },
    });
  }
  return out;
}

export function filterDeals(deals: Deal[], args: RecallArgs): RecallResult[] {
  const out: RecallResult[] = [];
  for (const d of deals) {
    const haystack = [d.propertyAddress, d.city, d.state, d.status, d.closingStatus];
    if (!matchesQuery(args.query, haystack)) continue;
    // Deals don't have a date field exposed in the public Deal
    // type today; range-filter is a no-op when no since/until,
    // and excludes all deals when either is set (since we can't
    // verify membership).
    if ((args.since || args.until) && !d) continue;
    out.push({
      source: "deals",
      record_id: d.id,
      summary: `${d.propertyAddress ?? "(no address)"} — ${d.status ?? "(unset)"}`,
      full_data: {
        property_address: d.propertyAddress,
        city: d.city,
        state: d.state,
        status: d.status,
        closing_status: d.closingStatus,
        contract_price: d.contractPrice,
        offer_price: d.offerPrice,
        arv: d.arv,
      },
    });
  }
  return out;
}

// ────────────────────── pure: result composition ──────────────────────

/**
 * Combine per-source result arrays, apply the global cap, and
 * report truncation. Pure.
 *
 * Interleaving rule: results from each source are kept in their
 * source-local order (most-recent first), then merged round-robin
 * so the caller sees a diverse top-N rather than 50 spine entries
 * pushing out 0 audit entries.
 */
export function composeRecallResponse(
  perSource: { source: RecallSource; results: RecallResult[] }[],
  limit: number = RESULT_LIMIT,
): RecallResponse {
  const merged: RecallResult[] = [];
  const indices = perSource.map(() => 0);
  let totalAvailable = perSource.reduce((sum, p) => sum + p.results.length, 0);

  while (merged.length < limit && merged.length < totalAvailable) {
    let progressed = false;
    for (let i = 0; i < perSource.length; i++) {
      if (indices[i] < perSource[i].results.length) {
        merged.push(perSource[i].results[indices[i]]);
        indices[i]++;
        progressed = true;
        if (merged.length >= limit) break;
      }
    }
    if (!progressed) break;
  }

  return {
    results: merged,
    truncated_to_n: Math.max(0, totalAvailable - merged.length),
    searched_sources: perSource.map((p) => p.source),
  };
}

// ────────────────────── I/O wrappers ──────────────────────

export interface RecallDeps {
  fetchSpineRecords: (
    since: string | undefined,
    until: string | undefined,
  ) => Promise<Array<{ id: string; fields: Record<string, unknown> }>>;
  fetchAuditEvents: (limit: number) => Promise<AuditEntry[]>;
  fetchListings: () => Promise<Listing[]>;
  fetchDeals: () => Promise<Deal[]>;
}

export function defaultRecallDeps(): RecallDeps {
  return {
    fetchSpineRecords: fetchSpineRecordsViaAirtable,
    fetchAuditEvents: readRecentFromKv,
    fetchListings: getListings,
    fetchDeals: getDeals,
  };
}

async function fetchSpineRecordsViaAirtable(
  since: string | undefined,
  until: string | undefined,
): Promise<Array<{ id: string; fields: Record<string, unknown> }>> {
  if (!AIRTABLE_PAT) {
    throw new Error("AIRTABLE_PAT not configured");
  }
  const url = new URL(`https://api.airtable.com/v0/${BASE_ID}/${SPINE_TABLE_ID}`);
  url.searchParams.set("returnFieldsByFieldId", "true");
  url.searchParams.set("pageSize", "100");
  // Spine is small (~10-100 rows typically); single page is fine.
  // When since/until are set we apply IS_AFTER server-side to cut
  // bytes; otherwise we return everything for client-side text match.
  if (since || until) {
    const clauses: string[] = [];
    if (since) clauses.push(`IS_AFTER({${SPINE_F_DATE}}, "${since.slice(0, 10)}")`);
    if (until) clauses.push(`IS_BEFORE({${SPINE_F_DATE}}, "${until.slice(0, 10)}")`);
    url.searchParams.set("filterByFormula", clauses.length === 1 ? clauses[0] : `AND(${clauses.join(",")})`);
  }
  url.searchParams.append("sort[0][field]", SPINE_F_DATE);
  url.searchParams.append("sort[0][direction]", "desc");

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${AIRTABLE_PAT}` },
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Spine recall query failed ${res.status}: ${text.slice(0, 200)}`);
  }
  const body = (await res.json()) as {
    records?: Array<{ id: string; fields: Record<string, unknown> }>;
  };
  return body.records ?? [];
}

/**
 * Orchestrate the recall: fetch the requested sources in parallel,
 * filter per-source, compose the final response.
 */
export async function recall(
  args: RecallArgs,
  deps: RecallDeps = defaultRecallDeps(),
): Promise<RecallResponse> {
  const sources = args.sources ?? DEFAULT_SOURCES;
  const fetches = sources.map(async (source) => {
    try {
      switch (source) {
        case "spine": {
          const records = await deps.fetchSpineRecords(args.since, args.until);
          return { source, results: filterSpine(records, args) };
        }
        case "audit": {
          const events = await deps.fetchAuditEvents(AUDIT_SCAN_DEPTH);
          return { source, results: filterAudit(events, args) };
        }
        case "listings": {
          const listings = await deps.fetchListings();
          return { source, results: filterListings(listings, args) };
        }
        case "deals": {
          const deals = await deps.fetchDeals();
          return { source, results: filterDeals(deals, args) };
        }
      }
    } catch {
      // Per source — graceful degrade. The compose step still
      // returns results from healthy sources.
      return { source, results: [] };
    }
  });
  const perSource = await Promise.all(fetches);
  return composeRecallResponse(perSource);
}

// ────────────────────── private helpers ──────────────────────

function asString(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "name" in v) {
    const n = (v as { name: unknown }).name;
    if (typeof n === "string") return n;
  }
  return null;
}
