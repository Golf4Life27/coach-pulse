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
  belowThresholdStreakDays: "fldrRvTum8fEvIpvV",
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
  belowThresholdStreakDays: number | null;
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
    belowThresholdStreakDays:
      typeof f[ZR.belowThresholdStreakDays] === "number"
        ? (f[ZR.belowThresholdStreakDays] as number)
        : null,
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

// Every registry row, all tiers. Used by the Pulse zip-saturation detector,
// which needs `saturated` rows (excluded by getActiveIntakeRows) to surface
// the expansion suggestion.
export async function getAllRegistryRows(): Promise<ZipRegistryRow[]> {
  return fetchRows();
}

// Stamp Last_Ingested_At after a successful intake run (24.5). The intake
// cron owns this per-run timestamp; the rolling *_30d figures are no longer
// written here — they're derived by the zip-saturation-check cron from the
// ZIP_Daily_Stats append-log (see writeRollingStats + lib/zip-daily-stats).
export interface ZipStatsUpdate {
  lastIngestedAt: string; // ISO
}

export async function updateZipStats(recordId: string, stats: ZipStatsUpdate): Promise<void> {
  await patchRow(recordId, { [ZR.lastIngestedAt]: stats.lastIngestedAt });
}

// True 30-day rolling stats write-back (24.5). The zip-saturation-check cron
// is the SOLE writer of these fields: it sums the trailing-window
// ZIP_Daily_Stats rows, writes the rolling figures + the below-threshold
// streak, and — when an active ZIP crosses the streak threshold — flips
// Market_Tier to `saturated` in the same patch.
export interface RollingStatsUpdate {
  acceptRate30d: number | null; // fraction 0..1
  avgDom: number | null;
  avgListPrice: number | null;
  recordsIngested30d: number;
  belowThresholdStreakDays: number;
  marketTier?: MarketTier; // set only when flipping to `saturated`
}

export async function writeRollingStats(recordId: string, u: RollingStatsUpdate): Promise<void> {
  const fields: Record<string, unknown> = {
    [ZR.acceptRate30d]: u.acceptRate30d,
    [ZR.avgDom]: u.avgDom,
    [ZR.avgListPrice]: u.avgListPrice,
    [ZR.recordsIngested30d]: u.recordsIngested30d,
    [ZR.belowThresholdStreakDays]: u.belowThresholdStreakDays,
  };
  if (u.marketTier) fields[ZR.marketTier] = u.marketTier;
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
