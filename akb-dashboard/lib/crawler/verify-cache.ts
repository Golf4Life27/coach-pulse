// Within-cycle Firecrawl verify cache (operator 2026-06-08).
//
// Guard (3): never re-verify (re-pay Firecrawl for) a listing already
// verified THIS cycle. The freshness cursor already runs each ZIP once
// per cycle, but a ZIP that partially completes (budget/time skip) stays
// DUE and re-runs — re-fetching RentCast and re-searching the candidates
// that were REJECTED last run (rejects aren't written to Listings_V1, so
// the existing address-dedup against the table doesn't catch them).
// Cross-ZIP-boundary addresses have the same shape. This cache records
// EVERY verified address (accepted AND rejected) with a cycle-length TTL,
// so those re-searches are skipped before any paid call.
//
// KV-backed (Upstash REST, same creds as the audit log). Batched via the
// pipeline endpoint — one HTTP round-trip for the whole candidate set.
// Degrades gracefully: when KV is unset or errors, reads return "nothing
// cached" and writes no-op, so behavior falls back to today's (the cache
// only ever PREVENTS spend; it never blocks a needed verify).

import { normalizeAddressKey } from "@/lib/crawler/intake-filter";

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

const KEY_PREFIX = "intake:vfy:";

/** Pure: KV key for a candidate address (normalized so "346 Modder Ave."
 *  and "346 modder ave" share one slot). Empty address → null (uncacheable). */
export function verifyCacheKey(address: string | null): string | null {
  const norm = normalizeAddressKey(address);
  return norm ? KEY_PREFIX + encodeURIComponent(norm) : null;
}

async function kvPipeline(commands: string[][]): Promise<unknown[] | null> {
  if (!KV_URL || !KV_TOKEN || commands.length === 0) return null;
  try {
    const res = await fetch(`${KV_URL}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(commands),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Array<{ result?: unknown }>;
    return body.map((r) => r.result ?? null);
  } catch {
    return null;
  }
}

/** Return the subset of `addresses` already verified within the cycle (so
 *  the caller skips them). Normalized + deduped. KV-down → empty set
 *  (nothing cached → caller verifies everything, as today). */
export async function getVerifiedThisCycle(addresses: Array<string | null>): Promise<Set<string>> {
  const keyByNorm = new Map<string, string>(); // normAddr → kv key
  for (const a of addresses) {
    const norm = normalizeAddressKey(a);
    const key = verifyCacheKey(a);
    if (norm && key && !keyByNorm.has(norm)) keyByNorm.set(norm, key);
  }
  if (keyByNorm.size === 0) return new Set();
  const norms = [...keyByNorm.keys()];
  const keys = [...keyByNorm.values()];
  const results = await kvPipeline(keys.map((k) => ["GET", k]));
  if (!results) return new Set();
  const hit = new Set<string>();
  results.forEach((r, i) => {
    if (r != null) hit.add(norms[i]);
  });
  return hit;
}

/** Mark addresses verified this cycle (accept AND reject). Per-address
 *  SET with EX=cycleHours, so each independently expires a cycle after it
 *  was verified. Best-effort; KV-down → no-op. */
export async function markVerifiedThisCycle(
  addresses: Array<string | null>,
  cycleHours: number,
): Promise<void> {
  const seen = new Set<string>();
  const cmds: string[][] = [];
  const ex = String(Math.max(1, Math.floor(cycleHours * 3600)));
  for (const a of addresses) {
    const key = verifyCacheKey(a);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    cmds.push(["SET", key, "1", "EX", ex]);
  }
  if (cmds.length === 0) return;
  await kvPipeline(cmds);
}
