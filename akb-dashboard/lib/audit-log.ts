// Minimal agent audit log. Writes append-only entries with timestamp, agent
// name, input hash, output summary, and decision label. Uses Vercel KV via
// REST API when KV_REST_API_URL is configured; otherwise falls back to an
// in-memory ring buffer (process-local, lost on restart — fine for dev).
//
// Every agent call goes through here. Briefing §12.10 hard rule.

export interface AuditEntry {
  ts: string;
  agent: string;
  event: string;
  inputSummary?: Record<string, unknown>;
  outputSummary?: Record<string, unknown>;
  decision?: string;
  recordId?: string;
  ms?: number;
  error?: string;
}

const RING_CAP = 500;
const ring: AuditEntry[] = [];

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function pushToKv(entry: AuditEntry): Promise<void> {
  if (!KV_URL || !KV_TOKEN) return;
  // Use a single list key + LPUSH; readers can LRANGE / LTRIM.
  const url = `${KV_URL}/lpush/agent:audit/${encodeURIComponent(JSON.stringify(entry))}`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
      cache: "no-store",
    });
    // Cap list at ~5000 entries.
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

export function readMemoryRing(limit = 100): AuditEntry[] {
  return ring.slice(-limit).reverse();
}
