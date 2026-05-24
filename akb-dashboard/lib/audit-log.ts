// Agent audit log. Append-only with three-state status per the Positive
// Confirmation Principle (docs/Positive_Confirmation_Principle.md):
//
//   confirmed_success — positive proof the operation completed
//   confirmed_failure — explicit error / rejection
//   uncertain         — 2xx/queued/accepted/no-response — NOT success
//
// Writes to Vercel KV when KV_REST_API_URL is configured; otherwise an
// in-memory ring (process-local, dev only). Briefing §12.10 hard rule.

export type AuditStatus = "confirmed_success" | "confirmed_failure" | "uncertain";

export interface AuditEntry {
  ts: string;
  agent: string;
  event: string;
  status: AuditStatus;
  inputSummary?: Record<string, unknown>;
  outputSummary?: Record<string, unknown>;
  decision?: string;
  recordId?: string;
  externalId?: string; // e.g., Quo/OpenPhone message id, Gmail thread id
  ms?: number;
  error?: string;
}

const RING_CAP = 500;
const ring: AuditEntry[] = [];

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

// Loud-warn once per cold start when KV isn't wired — without this the
// audit-log silently falls back to the process-local in-memory ring,
// which is exactly the kind of silent failure the Principle is meant to
// surface. The ring is volatile across lambda restarts so production
// has no durable audit trail in this state.
let kvWarnLogged = false;
function warnIfKvMissing() {
  if (kvWarnLogged) return;
  if (!KV_URL || !KV_TOKEN) {
    console.warn(
      "[audit-log] KV_REST_API_URL / KV_REST_API_TOKEN not configured — audit entries will only persist to the in-memory ring (lost on cold start). Wire Vercel KV to enable durable audit trail.",
    );
    kvWarnLogged = true;
  }
}

async function pushToKv(entry: AuditEntry): Promise<void> {
  warnIfKvMissing();
  if (!KV_URL || !KV_TOKEN) return;
  const url = `${KV_URL}/lpush/agent:audit/${encodeURIComponent(JSON.stringify(entry))}`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
      cache: "no-store",
    });
    await fetch(`${KV_URL}/ltrim/agent:audit/0/4999`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
      cache: "no-store",
    });
  } catch (err) {
    console.error("[audit-log] KV write failed:", err);
  }
}

export async function audit(entry: Omit<AuditEntry, "ts">): Promise<void> {
  const full: AuditEntry = { ts: new Date().toISOString(), ...entry };
  ring.push(full);
  if (ring.length > RING_CAP) ring.splice(0, ring.length - RING_CAP);
  await pushToKv(full);
}

// Pulls recent entries from KV (durable) when configured, else the
// in-memory ring (volatile). Used by gate-runner for the audit_log
// data source (e.g., PS-12 Quo health check reads recent quo:send_attempt).
export async function readRecentFromKv(limit = 200): Promise<AuditEntry[]> {
  if (!KV_URL || !KV_TOKEN) return readMemoryRing(limit);
  try {
    const res = await fetch(`${KV_URL}/lrange/agent:audit/0/${limit - 1}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
      cache: "no-store",
    });
    if (!res.ok) return readMemoryRing(limit);
    const data = (await res.json()) as { result?: string[] };
    if (!Array.isArray(data.result)) return readMemoryRing(limit);
    return data.result.flatMap<AuditEntry>((s) => {
      try {
        return [JSON.parse(s) as AuditEntry];
      } catch {
        return [];
      }
    });
  } catch {
    return readMemoryRing(limit);
  }
}

export function readMemoryRing(limit = 100): AuditEntry[] {
  return ring.slice(-limit).reverse();
}

// Surfaces uncertain entries that have not transitioned to confirmed_*
// within the staleness window. Used by the Orchestrator morning brief
// per Principle §Rule 3.
export function readUncertain(staleMs = 5 * 60_000): AuditEntry[] {
  const cutoff = Date.now() - staleMs;
  return ring.filter(
    (e) => e.status === "uncertain" && new Date(e.ts).getTime() < cutoff,
  );
}
