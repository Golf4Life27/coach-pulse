// Build Ledger — the durable "what is in the works" list (operator directive
// 2026-09-05): Alex forgets ideas when distracted; this is the list he reads
// every morning. One Airtable table (Build_Ledger), one step per row,
// grouped by Project. PURE summarization lives here so the API route, the
// dashboard page, and the morning briefing all read the exact same shape.

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY || process.env.AIRTABLE_PAT;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";

export const BUILD_LEDGER_TABLE = "tblqMmkZ6zsPhxKBx";

export type BuildStatus = "Idea" | "Planned" | "In Progress" | "Blocked" | "Done" | "Parked";
export type BuildOwner = "machine" | "operator";

export interface BuildStep {
  id: string;
  step: string;
  project: string;
  status: BuildStatus | null;
  progressPct: number | null;
  owner: BuildOwner | null;
  actionItem: string | null;
  nextStep: string | null;
  blockedBy: string | null;
  order: number | null;
  spineRef: string | null;
  updatedAt: string | null;
  notes: string | null;
}

export const BUILD_LEDGER_FIELDS = {
  Step: "Step",
  Project: "Project",
  Status: "Status",
  Progress_Pct: "Progress_Pct",
  Owner: "Owner",
  Action_Item: "Action_Item",
  Next_Step: "Next_Step",
  Blocked_By: "Blocked_By",
  Order: "Order",
  Spine_Ref: "Spine_Ref",
  Updated_At: "Updated_At",
  Notes: "Notes",
} as const;

function asString(v: unknown): string | null {
  if (typeof v === "string" && v.trim().length > 0) return v;
  return null;
}
function asNumber(v: unknown): number | null {
  if (typeof v === "number" && !isNaN(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
  }
  return null;
}

function mapRecord(record: { id: string; fields: Record<string, unknown> }): BuildStep {
  const f = record.fields;
  return {
    id: record.id,
    step: asString(f[BUILD_LEDGER_FIELDS.Step]) ?? "",
    project: asString(f[BUILD_LEDGER_FIELDS.Project]) ?? "",
    status: (asString(f[BUILD_LEDGER_FIELDS.Status]) as BuildStatus | null) ?? null,
    progressPct: asNumber(f[BUILD_LEDGER_FIELDS.Progress_Pct]),
    owner: (asString(f[BUILD_LEDGER_FIELDS.Owner]) as BuildOwner | null) ?? null,
    actionItem: asString(f[BUILD_LEDGER_FIELDS.Action_Item]),
    nextStep: asString(f[BUILD_LEDGER_FIELDS.Next_Step]),
    blockedBy: asString(f[BUILD_LEDGER_FIELDS.Blocked_By]),
    order: asNumber(f[BUILD_LEDGER_FIELDS.Order]),
    spineRef: asString(f[BUILD_LEDGER_FIELDS.Spine_Ref]),
    updatedAt: asString(f[BUILD_LEDGER_FIELDS.Updated_At]),
    notes: asString(f[BUILD_LEDGER_FIELDS.Notes]),
  };
}

/** Paginated REST read of the full ledger, sorted Project then Order.
 *  Fails toward an empty list — a ledger read must never blank a page. */
export async function fetchBuildLedger(): Promise<BuildStep[]> {
  if (!AIRTABLE_API_KEY) return [];
  const all: BuildStep[] = [];
  let offset: string | undefined;
  try {
    do {
      const params = new URLSearchParams();
      params.set("pageSize", "100");
      params.set("sort[0][field]", BUILD_LEDGER_FIELDS.Project);
      params.set("sort[0][direction]", "asc");
      params.set("sort[1][field]", BUILD_LEDGER_FIELDS.Order);
      params.set("sort[1][direction]", "asc");
      if (offset) params.set("offset", offset);
      const url = `https://api.airtable.com/v0/${BASE_ID}/${BUILD_LEDGER_TABLE}?${params.toString()}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
        cache: "no-store",
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`Airtable build ledger list ${res.status}: ${errText}`);
      }
      const data = (await res.json()) as {
        records: Array<{ id: string; fields: Record<string, unknown> }>;
        offset?: string;
      };
      for (const rec of data.records) all.push(mapRecord(rec));
      offset = data.offset;
    } while (offset);
    return all;
  } catch (err) {
    console.error("[build-ledger] fetchBuildLedger failed:", err);
    return [];
  }
}

export interface UpsertBuildStepInput {
  project: string;
  step: string;
  status?: BuildStatus;
  progressPct?: number;
  owner?: BuildOwner;
  actionItem?: string | null;
  nextStep?: string | null;
  blockedBy?: string | null;
  order?: number;
  spineRef?: string | null;
  notes?: string | null;
}

/** Create-or-update on (Project, Step). Always stamps Updated_At. Throws on
 *  a real Airtable failure — callers (the API route) decide how to report it. */
export async function upsertBuildStep(input: UpsertBuildStepInput): Promise<BuildStep> {
  if (!AIRTABLE_API_KEY) throw new Error("build-ledger: no Airtable credential configured");

  const formula = `AND({${BUILD_LEDGER_FIELDS.Project}}=${JSON.stringify(input.project)}, {${BUILD_LEDGER_FIELDS.Step}}=${JSON.stringify(input.step)})`;
  const findUrl = `https://api.airtable.com/v0/${BASE_ID}/${BUILD_LEDGER_TABLE}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;
  const findRes = await fetch(findUrl, {
    headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
    cache: "no-store",
  });
  if (!findRes.ok) {
    const errText = await findRes.text().catch(() => "");
    throw new Error(`Airtable build ledger find ${findRes.status}: ${errText}`);
  }
  const findData = (await findRes.json()) as { records: Array<{ id: string; fields: Record<string, unknown> }> };
  const existing = findData.records[0] ?? null;

  const fields: Record<string, unknown> = {
    [BUILD_LEDGER_FIELDS.Project]: input.project,
    [BUILD_LEDGER_FIELDS.Step]: input.step,
    [BUILD_LEDGER_FIELDS.Updated_At]: new Date().toISOString(),
  };
  if (input.status !== undefined) fields[BUILD_LEDGER_FIELDS.Status] = input.status;
  if (input.progressPct !== undefined) fields[BUILD_LEDGER_FIELDS.Progress_Pct] = input.progressPct;
  if (input.owner !== undefined) fields[BUILD_LEDGER_FIELDS.Owner] = input.owner;
  if (input.actionItem !== undefined) fields[BUILD_LEDGER_FIELDS.Action_Item] = input.actionItem;
  if (input.nextStep !== undefined) fields[BUILD_LEDGER_FIELDS.Next_Step] = input.nextStep;
  if (input.blockedBy !== undefined) fields[BUILD_LEDGER_FIELDS.Blocked_By] = input.blockedBy;
  if (input.order !== undefined) fields[BUILD_LEDGER_FIELDS.Order] = input.order;
  if (input.spineRef !== undefined) fields[BUILD_LEDGER_FIELDS.Spine_Ref] = input.spineRef;
  if (input.notes !== undefined) fields[BUILD_LEDGER_FIELDS.Notes] = input.notes;

  const url = existing
    ? `https://api.airtable.com/v0/${BASE_ID}/${BUILD_LEDGER_TABLE}/${existing.id}`
    : `https://api.airtable.com/v0/${BASE_ID}/${BUILD_LEDGER_TABLE}`;
  const method = existing ? "PATCH" : "POST";
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${AIRTABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields, typecast: true }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Airtable build ledger ${method} ${res.status}: ${errText}`);
  }
  const record = (await res.json()) as { id: string; fields: Record<string, unknown> };
  return mapRecord(record);
}

// ── Pure summarization ──────────────────────────────────────────────────

export interface ProjectSummary {
  project: string;
  progressPct: number;
  stepsTotal: number;
  stepsDone: number;
  inProgress: BuildStep[];
  blocked: BuildStep[];
  nextSteps: string[];
}

export interface OperatorActionItem {
  project: string;
  step: string;
  actionItem: string;
  updatedAt: string | null;
}

export interface BuildLedgerSummary {
  projects: ProjectSummary[];
  operatorActionItems: OperatorActionItem[];
  counts: {
    inWorks: number;
    blocked: number;
    done: number;
    operatorActions: number;
  };
  staleSteps: BuildStep[];
}

const STALE_MS = 7 * 24 * 3_600_000;

function stepProgress(s: BuildStep): number {
  if (s.status === "Done") return 100;
  if (typeof s.progressPct === "number") return Math.max(0, Math.min(100, s.progressPct));
  return 0;
}

const PARKED_LIKE = new Set<BuildStatus | null>(["Parked", "Idea"]);

/** PURE — no I/O. Groups steps by Project, computes mean progress (Done
 *  counts as 100 regardless of a stale/missing Progress_Pct), collects
 *  operator action items, and flags stale In Progress steps. */
export function summarizeBuildLedger(steps: BuildStep[], now: Date = new Date()): BuildLedgerSummary {
  const byProject = new Map<string, BuildStep[]>();
  for (const s of steps) {
    const key = s.project || "(no project)";
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key)!.push(s);
  }

  const operatorActionItems: OperatorActionItem[] = [];
  for (const s of steps) {
    if (s.owner === "operator" && s.actionItem) {
      operatorActionItems.push({
        project: s.project,
        step: s.step,
        actionItem: s.actionItem,
        updatedAt: s.updatedAt,
      });
    }
  }
  // Most recently updated action items first.
  operatorActionItems.sort((a, b) => (Date.parse(b.updatedAt ?? "") || 0) - (Date.parse(a.updatedAt ?? "") || 0));

  const projectsWithActionItems = new Set(operatorActionItems.map((a) => a.project));

  const projects: ProjectSummary[] = [];
  for (const [project, projectSteps] of byProject) {
    const stepsTotal = projectSteps.length;
    const stepsDone = projectSteps.filter((s) => s.status === "Done").length;
    const progressPct =
      stepsTotal === 0 ? 0 : Math.round(projectSteps.reduce((sum, s) => sum + stepProgress(s), 0) / stepsTotal);
    const inProgress = projectSteps.filter((s) => s.status === "In Progress");
    const blocked = projectSteps.filter((s) => s.status === "Blocked");
    const nextSteps = projectSteps.map((s) => s.nextStep).filter((n): n is string => !!n);

    projects.push({ project, progressPct, stepsTotal, stepsDone, inProgress, blocked, nextSteps });
  }

  // Ordering: any project with an operator action item first (by most
  // urgent — lowest progress within that group), then remaining active
  // projects by lowest progress, with Parked/Idea-only projects last.
  const isParkedOnly = (p: ProjectSummary): boolean => {
    const projectSteps = byProject.get(p.project) ?? [];
    return projectSteps.length > 0 && projectSteps.every((s) => PARKED_LIKE.has(s.status));
  };

  projects.sort((a, b) => {
    const aParked = isParkedOnly(a);
    const bParked = isParkedOnly(b);
    if (aParked !== bParked) return aParked ? 1 : -1;

    const aHasAction = projectsWithActionItems.has(a.project);
    const bHasAction = projectsWithActionItems.has(b.project);
    if (aHasAction !== bHasAction) return aHasAction ? -1 : 1;

    return a.progressPct - b.progressPct;
  });

  let inWorks = 0;
  let blockedCount = 0;
  let doneCount = 0;
  for (const s of steps) {
    if (s.status === "In Progress" || s.status === "Planned") inWorks++;
    else if (s.status === "Blocked") blockedCount++;
    else if (s.status === "Done") doneCount++;
  }

  const staleSteps = steps.filter((s) => {
    if (s.status !== "In Progress") return false;
    if (!s.updatedAt) return false;
    const t = Date.parse(s.updatedAt);
    if (!Number.isFinite(t)) return false;
    return now.getTime() - t > STALE_MS;
  });

  return {
    projects,
    operatorActionItems,
    counts: {
      inWorks,
      blocked: blockedCount,
      done: doneCount,
      operatorActions: operatorActionItems.length,
    },
    staleSteps,
  };
}
