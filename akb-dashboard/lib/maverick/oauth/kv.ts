// Maverick OAuth — Vercel KV REST wrapper.
// @agent: maverick (Day 4.5)
//
// Thin fetch-based wrapper around the Vercel KV REST API. Mirrors the
// pattern in lib/audit-log.ts (no @vercel/kv package; raw HTTP keeps
// the dependency surface narrow + works identically in edge/node).
//
// KV is required for OAuth — there's no in-memory fallback. Without
// durable token storage, OAuth tokens would be unverifiable after a
// lambda cold-start. Routes return 503 if KV isn't configured.

export interface KvClient {
  /** SET key value EX ttl. Overwrites silently. */
  setEx(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** SET key value (no TTL — persistent record like client registrations). */
  set(key: string, value: string): Promise<void>;
  /** GET key. Returns null when missing. */
  get(key: string): Promise<string | null>;
  /** DEL key. Returns 1 if deleted, 0 if didn't exist. Single-use semantics. */
  del(key: string): Promise<number>;
  /** GETDEL key. Atomic get + delete in one round-trip. Returns value or null. */
  getDel(key: string): Promise<string | null>;
}

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

export function kvConfigured(): boolean {
  return Boolean(KV_URL && KV_TOKEN);
}

/** Production KV client backed by the Upstash REST API. */
export const kvProd: KvClient = {
  async setEx(key, value, ttlSeconds) {
    if (!KV_URL || !KV_TOKEN) throw new Error("KV not configured");
    // SET <key> <value> EX <seconds>
    const url = `${KV_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}/ex/${ttlSeconds}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`KV setEx failed: ${res.status}`);
  },
  async set(key, value) {
    if (!KV_URL || !KV_TOKEN) throw new Error("KV not configured");
    const url = `${KV_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`KV set failed: ${res.status}`);
  },
  async get(key) {
    if (!KV_URL || !KV_TOKEN) throw new Error("KV not configured");
    const res = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`KV get failed: ${res.status}`);
    const data = (await res.json()) as { result: string | null };
    return data.result;
  },
  async del(key) {
    if (!KV_URL || !KV_TOKEN) throw new Error("KV not configured");
    const res = await fetch(`${KV_URL}/del/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`KV del failed: ${res.status}`);
    const data = (await res.json()) as { result: number };
    return data.result;
  },
  async getDel(key) {
    if (!KV_URL || !KV_TOKEN) throw new Error("KV not configured");
    // Upstash REST exposes GETDEL as an atomic primitive.
    const res = await fetch(`${KV_URL}/getdel/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`KV getdel failed: ${res.status}`);
    const data = (await res.json()) as { result: string | null };
    return data.result;
  },
};

/**
 * In-memory KV client for tests. Honors TTLs via Date.now() snapshots
 * so `setEx` semantics match production. Reset between tests via
 * makeMemoryKv().
 */
export function makeMemoryKv(): KvClient {
  const store = new Map<string, { value: string; expiresAt: number | null }>();
  const isExpired = (entry: { expiresAt: number | null }, now: number) =>
    entry.expiresAt !== null && entry.expiresAt <= now;
  return {
    async setEx(key, value, ttlSeconds) {
      store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    },
    async set(key, value) {
      store.set(key, { value, expiresAt: null });
    },
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      if (isExpired(entry, Date.now())) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async del(key) {
      const entry = store.get(key);
      if (!entry) return 0;
      if (isExpired(entry, Date.now())) {
        store.delete(key);
        return 0;
      }
      store.delete(key);
      return 1;
    },
    async getDel(key) {
      const entry = store.get(key);
      if (!entry) return null;
      const now = Date.now();
      store.delete(key);
      if (isExpired(entry, now)) return null;
      return entry.value;
    },
  };
}
