// ZIP_Registry data layer (Workstream D1).
// @agent: scout / sentinel
//
// Operational registry of target ZIPs. Drives listings-intake targeting
// (Market_Tier in launch/active AND NOT Wholesale_Restricted) and the
// market-expansion approval gate (Market_Tier=approval_pending).
//
// Refs Spine recGtpPH4YxvUL2V8 (approval-gate model) + recTOr9pk1oQ1zfhB
// (D scoping). Distinct from ZIP_Intelligence (buyer-intel layer).
//
// Wholesale_Restricted + Memphis_Assignment_Required are CODE-MAINTAINED
// booleans (not Airtable formulas — the Meta API can't reliably create
// formula fields). deriveWholesaleRestricted / deriveMemphisRequired are
// the single source of truth; the seed + intake cron keep the columns in
// sync from State. Accept_Rate_30d + Saturation_Threshold are percent
// fields stored as FRACTIONS (0.01 = 1%).

const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
const ZIP_REGISTRY_TABLE = "tbljGMYeY3GcOZza1";

// Field IDs (read via returnFieldsByFieldId=true; written by ID).
export const ZR = {
  zip: "fldJr5P7OlZh60S6X",
  state: "fldPIYZYPLcIdHjEW",
  market: "fldUuqqmZOD4IXDuY",
  marketTier: "fld2dzwbiUU0m5ji7",
  wholesaleRestricted: "fld7si33NHWDLAMAY",
  memphisRequired: "fldjpzkNgN4MvAEOr",
  lastIngestedAt: "fldb4NwWK5qXF2XxZ",
  acceptRate30d: "fldF7dIiWSnAXtEfu",
  avgDom: "fldS541WwNtLfDaGV",
  avgListPrice: "fld9rI8eLezEgUnUm",
  recordsIngested30d: "fldTDRbvWlur4BRnk",
  saturationThreshold: "fldAbZeSBgbihf4wf",
  belowThresholdStreak: "fldrRvTum8fEvIpvV",
  approvalRequestedAt: "fldRcbHsnUiDpDSRF",
  approvalNotifiedChannels: "fldVKgqMFoF3Sx5Ru",
  approvedBy: "fldmFfEGD0u5teM9e",
  approvalMethod: "fldxjsKuNXM3tb74l",
  notes: "fldlnkJyciSJATeeO",
} as const;

export type MarketTier =
  | "launch"
  | "active"
  | "paused"
  | "saturated"
  | "staged"
  | "approval_pending"
  | "wholesale_restricted";

export type NotifyChannel = "dashboard" | "sms";
export type ApprovalMethod = "dashboard" | "sms" | "manual";

export interface ZipRegistryRow {
  recordId: string;
  zip: string;
  state: string | null;
  market: string | null;
  marketTier: MarketTier | null;
  wholesaleRestricted: boolean;
  memphisRequired: boolean;
  lastIngestedAt: string | null;
  acceptRate30d: number | null;
  avgDom: number | null;
  avgListPrice: number | null;
  recordsIngested30d: number | null;
  saturationThreshold: number | null;
  /** Consecutive zero-yield ingest runs (Below_Threshold_Streak_Days) —
   *  maintained by the intake stats write-back; consumed by the tiered
   *  recrawl cadence (lib/crawler/zip-rotation recrawlCycleHours). */
  belowThresholdStreak: number | null;
  approvalRequestedAt: string | null;
  approvalNotifiedChannels: NotifyChannel[];
  approvedBy: string | null;
  approvalMethod: ApprovalMethod | null;
  notes: string | null;
}

// ───────────────────── pure: derived booleans ─────────────────────

// States where wholesale assignment is restricted/atypical — intake
// skips these even if a ZIP is otherwise active. Keep in lockstep with
// the original spec formula (IL, MO, SC, NC, OK, ND).
export const WHOLESALE_RESTRICTED_STATES = new Set([
  "IL",
  "MO",
  "SC",
  "NC",
  "OK",
  "ND",
]);

export function deriveWholesaleRestricted(state: string | null | undefined): boolean {
  if (!state) return false;
  return WHOLESALE_RESTRICTED_STATES.has(state.trim().toUpperCase());
}

export function deriveMemphisRequired(state: string | null | undefined): boolean {
  if (!state) return false;
  return state.trim().toUpperCase() === "TN";
}

// ───────────────────── I/O ─────────────────────

function requirePat(): string {
  if (!AIRTABLE_PAT) throw new Error("AIRTABLE_PAT not set");
  return AIRTABLE_PAT;
}

function mapRow(rec: { id: string; fields: Record<string, unknown> }): ZipRegistryRow {
  const f = rec.fields;
  const channels = Array.isArray(f[ZR.approvalNotifiedChannels])
    ? (f[ZR.approvalNotifiedChannels] as string[]).filter(
        (c): c is NotifyChannel => c === "dashboard" || c === "sms",
      )
    : [];
  return {
    recordId: rec.id,
    zip: typeof f[ZR.zip] === "string" ? (f[ZR.zip] as string) : "",
    state: (f[ZR.state] as string) ?? null,
    market: (f[ZR.market] as string) ?? null,
    marketTier: (f[ZR.marketTier] as MarketTier) ?? null,
    wholesaleRestricted: f[ZR.wholesaleRestricted] === true,
    memphisRequired: f[ZR.memphisRequired] === true,
    lastIngestedAt: (f[ZR.lastIngestedAt] as string) ?? null,
    acceptRate30d: typeof f[ZR.acceptRate30d] === "number" ? (f[ZR.acceptRate30d] as number) : null,
    avgDom: typeof f[ZR.avgDom] === "number" ? (f[ZR.avgDom] as number) : null,
    avgListPrice: typeof f[ZR.avgListPrice] === "number" ? (f[ZR.avgListPrice] as number) : null,
    recordsIngested30d:
      typeof f[ZR.recordsIngested30d] === "number" ? (f[ZR.recordsIngested30d] as number) : null,
    saturationThreshold:
      typeof f[ZR.saturationThreshold] === "number" ? (f[ZR.saturationThreshold] as number) : null,
    belowThresholdStreak:
      typeof f[ZR.belowThresholdStreak] === "number" ? (f[ZR.belowThresholdStreak] as number) : null,
    approvalRequestedAt: (f[ZR.approvalRequestedAt] as string) ?? null,
    approvalNotifiedChannels: channels,
    approvedBy: (f[ZR.approvedBy] as string) ?? null,
    approvalMethod: (f[ZR.approvalMethod] as ApprovalMethod) ?? null,
    notes: (f[ZR.notes] as string) ?? null,
  };
}

async function fetchRows(filterByFormula?: string): Promise<ZipRegistryRow[]> {
  const pat = requirePat();
  const rows: ZipRegistryRow[] = [];
  let offset: string | undefined;
  do {
    const params = new URLSearchParams();
    Object.values(ZR).forEach((id) => params.append("fields[]", id));
    params.set("returnFieldsByFieldId", "true");
    if (filterByFormula) params.set("filterByFormula", filterByFormula);
    if (offset) params.set("offset", offset);

    const url = `https://api.airtable.com/v0/${BASE_ID}/${ZIP_REGISTRY_TABLE}?${params.toString()}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${pat}` },
      cache: "no-store",
    });
    if (!res.ok) {
      throw new Error(`ZIP_Registry fetch error ${res.status}: ${await res.text().catch(() => "")}`);
    }
    const data = (await res.json()) as {
      records: Array<{ id: string; fields: Record<string, unknown> }>;
      offset?: string;
    };
    for (const rec of data.records) rows.push(mapRow(rec));
    offset = data.offset;
  } while (offset);
  return rows;
}

async function patchRow(recordId: string, fields: Record<string, unknown>): Promise<void> {
  const pat = requirePat();
  const url = `https://api.airtable.com/v0/${BASE_ID}/${ZIP_REGISTRY_TABLE}/${recordId}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields, typecast: true }),
  });
  if (!res.ok) {
    throw new Error(`ZIP_Registry PATCH error ${res.status}: ${await res.text().catch(() => "")}`);
  }
}

// Rows the intake cron should target: launch/active tiers that are not
// wholesale-restricted. Filtered to valid 5-digit ZIPs.
export async function getActiveIntakeRows(): Promise<ZipRegistryRow[]> {
  const formula =
    "AND(OR({Market_Tier}='launch',{Market_Tier}='active'),NOT({Wholesale_Restricted}))";
  const rows = await fetchRows(formula);
  return rows.filter((r) => /^\d{5}$/.test(r.zip));
}

// Convenience: just the de-duped, sorted ZIP strings.
export async function getActiveIntakeZips(): Promise<string[]> {
  const rows = await getActiveIntakeRows();
  return Array.from(new Set(rows.map((r) => r.zip))).sort();
}

// Full rows for the approval gate (dashboard queue + SMS reply matching).
export async function getApprovalPendingRows(): Promise<ZipRegistryRow[]> {
  return fetchRows("{Market_Tier}='approval_pending'");
}

// Every registry row — the weekly frontier pass needs staged + paused rows
// too, not just the intake-eligible set.
export async function getAllRegistryRows(): Promise<ZipRegistryRow[]> {
  return fetchRows();
}

// Frontier promotion (#37): staged → launch, stamped note appended.
// Autonomous within the UNLEASH ruling's rails (allowed states only —
// callers filter restricted rows; budget capacity bounds how many promote
// per pass).
export async function promoteStagedZip(
  recordId: string,
  opts: { note: string; existingNotes?: string | null },
): Promise<void> {
  const stamped = `[${new Date().toISOString()}] ${opts.note}`;
  await patchRow(recordId, {
    [ZR.marketTier]: "launch",
    [ZR.notes]: opts.existingNotes ? `${opts.existingNotes}\n\n${stamped}` : stamped,
  });
}

// Frontier auto-stage (expansion pipeline, 2026-07-22): create tier=staged
// rows for new expansion-metro ZIPs. Staged rows do NOT crawl (intake targets
// launch/active only) — they sit in the promotion queue until the weekly
// frontier pass promotes them within sustainable budget capacity. The caller
// (lib/crawler/frontier-stage) is responsible for filtering restricted states,
// non-disclosure states, and ZIPs already in the registry.
export async function createStagedZips(
  rows: Array<{ zip: string; state: string; market: string; note: string }>,
): Promise<number> {
  if (rows.length === 0) return 0;
  const pat = requirePat();
  let created = 0;
  // Airtable caps create at 10 records/request.
  for (let i = 0; i < rows.length; i += 10) {
    const batch = rows.slice(i, i + 10);
    const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${ZIP_REGISTRY_TABLE}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        records: batch.map((r) => ({
          fields: {
            [ZR.zip]: r.zip,
            [ZR.state]: r.state,
            [ZR.market]: r.market,
            [ZR.marketTier]: "staged",
            [ZR.wholesaleRestricted]: deriveWholesaleRestricted(r.state),
            [ZR.memphisRequired]: deriveMemphisRequired(r.state),
            [ZR.notes]: `[${new Date().toISOString()}] ${r.note}`,
          },
        })),
        typecast: true,
      }),
    });
    if (!res.ok) {
      throw new Error(`ZIP_Registry create error ${res.status}: ${await res.text().catch(() => "")}`);
    }
    created += batch.length;
  }
  return created;
}

// Frontier retirement execution (#37 one-tap card): ZIP → paused, stamped.
// ONLY fired by an operator-approved frontier_retire proposal — retirement
// (coverage reduction) is never autonomous; this is the dispatch the
// Approve tap runs.
export async function retireZip(
  recordId: string,
  opts: { note: string },
): Promise<void> {
  // Fetch current notes so the stamp appends instead of overwriting.
  const rows = await fetchRows(`RECORD_ID()='${recordId}'`);
  const existing = rows[0]?.notes ?? null;
  const stamped = `[${new Date().toISOString()}] ${opts.note}`;
  await patchRow(recordId, {
    [ZR.marketTier]: "paused",
    [ZR.notes]: existing ? `${existing}\n\n${stamped}` : stamped,
  });
}

// Per-ZIP stats write-back after a successful intake run.
//
// NOTE on semantics: v1 writes the LATEST successful run's snapshot into
// the *_30d fields. A true 30-day rolling aggregation is owned by the
// saturation-detection follow-up (Master Checklist 14.5), which is the
// sole consumer of these fields. Until then these are best-available
// per-run figures, refreshed daily.
export interface ZipStatsUpdate {
  lastIngestedAt: string; // ISO
  acceptRate30d?: number | null; // fraction 0..1
  avgDom?: number | null;
  avgListPrice?: number | null;
  recordsIngested30d?: number | null;
  /** Consecutive zero-yield ingest runs. 0 resets the streak (a producing
   *  run); the caller computes prior+1 for a zero-yield run. Explicit 0 IS
   *  written (unlike the nullable stats above) — resets must land. */
  belowThresholdStreak?: number | null;
}

export async function updateZipStats(recordId: string, stats: ZipStatsUpdate): Promise<void> {
  const fields: Record<string, unknown> = { [ZR.lastIngestedAt]: stats.lastIngestedAt };
  if (stats.acceptRate30d != null) fields[ZR.acceptRate30d] = stats.acceptRate30d;
  if (stats.avgDom != null) fields[ZR.avgDom] = stats.avgDom;
  if (stats.avgListPrice != null) fields[ZR.avgListPrice] = stats.avgListPrice;
  if (stats.recordsIngested30d != null) fields[ZR.recordsIngested30d] = stats.recordsIngested30d;
  if (stats.belowThresholdStreak != null) fields[ZR.belowThresholdStreak] = stats.belowThresholdStreak;
  await patchRow(recordId, fields);
}

// Approve a pending ZIP → active. Stamps operator + method.
export async function approveZip(
  recordId: string,
  opts: { approvedBy: string; method: ApprovalMethod },
): Promise<void> {
  await patchRow(recordId, {
    [ZR.marketTier]: "active",
    [ZR.approvedBy]: opts.approvedBy,
    [ZR.approvalMethod]: opts.method,
  });
}

// Reject a pending ZIP → paused. Appends operator note when provided.
export async function rejectZip(
  recordId: string,
  opts: { approvedBy: string; method: ApprovalMethod; notes?: string | null; existingNotes?: string | null },
): Promise<void> {
  const fields: Record<string, unknown> = {
    [ZR.marketTier]: "paused",
    [ZR.approvedBy]: opts.approvedBy,
    [ZR.approvalMethod]: opts.method,
  };
  if (opts.notes && opts.notes.trim()) {
    const stamped = `[${new Date().toISOString()}] ${opts.notes.trim()}`;
    fields[ZR.notes] = opts.existingNotes ? `${opts.existingNotes}\n\n${stamped}` : stamped;
  }
  await patchRow(recordId, fields);
}

// Record that a channel notified the operator of a pending approval, and
// stamp Approval_Requested_At if it isn't set yet. Idempotent on channels.
export async function markApprovalNotified(
  row: ZipRegistryRow,
  channel: NotifyChannel,
): Promise<void> {
  const channels = new Set(row.approvalNotifiedChannels);
  channels.add(channel);
  const fields: Record<string, unknown> = {
    [ZR.approvalNotifiedChannels]: Array.from(channels),
  };
  if (!row.approvalRequestedAt) fields[ZR.approvalRequestedAt] = new Date().toISOString();
  await patchRow(row.recordId, fields);
}
