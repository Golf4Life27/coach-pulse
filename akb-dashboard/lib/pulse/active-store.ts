// Phase 14 / O.1 — Pulse active-detection store (KV-backed).
//
// Tracks which Pulse detection IDs are currently "active" (firing).
// The runner uses this to diff against the latest scan and decide
// which detections are NEW (fresh fire → Spine write) vs RESOLVED
// (was active, no longer → Spine resolution write) vs STEADY-STATE
// (active in both → no Spine churn).
//
// Storage: Vercel KV string key. Falls back to a process-local
// in-memory snapshot when KV isn't wired (dev mode). Volatile on
// cold start in dev — that's accepted; Pulse is observability and
// the worst-case false positive is a duplicate Spine entry on first
// post-cold-start scan.
//
// Also stores the previous test_count anchor for the
// test-count-regression detector (single KV key holds the whole
// Pulse state to keep I/O cheap).

export interface PulseActiveState {
  /** Map of active detection_id → first-seen ISO timestamp. The
   *  timestamp lets the UI / load-state surface "active for 6h"
   *  style age strings. */
  active: Record<string, string>;
  /** Most-recent test_count Pulse anchored. Null on first scan. */
  test_count_anchor: number | null;
  /** ISO of the last scan that wrote this state. Surfaced in
   *  Pulse-room UI for freshness. */
  last_scan_at: string | null;
}

const KV_KEY = "pulse:state";
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

const EMPTY_STATE: PulseActiveState = {
  active: {},
  test_count_anchor: null,
  last_scan_at: null,
};

let memoryState: PulseActiveState = { ...EMPTY_STATE };

/** Read the current Pulse state. Returns the empty state when KV
 *  is unreachable or the key is unset. */
export async function readPulseState(): Promise<PulseActiveState> {
  if (!KV_URL || !KV_TOKEN) return { ...memoryState };
  try {
    const res = await fetch(`${KV_URL}/get/${encodeURIComponent(KV_KEY)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
      cache: "no-store",
    });
    if (!res.ok) return { ...EMPTY_STATE };
    const data = (await res.json()) as { result?: string | null };
    if (!data.result || typeof data.result !== "string") return { ...EMPTY_STATE };
    const parsed = JSON.parse(data.result) as Partial<PulseActiveState>;
    return {
      active: parsed.active && typeof parsed.active === "object" ? parsed.active : {},
      test_count_anchor:
        typeof parsed.test_count_anchor === "number" ? parsed.test_count_anchor : null,
      last_scan_at: typeof parsed.last_scan_at === "string" ? parsed.last_scan_at : null,
    };
  } catch {
    return { ...EMPTY_STATE };
  }
}

/** Persist the state. Best-effort — failures are logged but don't
 *  throw (Pulse must never break the rest of the app). */
export async function writePulseState(state: PulseActiveState): Promise<void> {
  memoryState = { ...state };
  if (!KV_URL || !KV_TOKEN) return;
  try {
    const url = `${KV_URL}/set/${encodeURIComponent(KV_KEY)}/${encodeURIComponent(JSON.stringify(state))}`;
    await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
      cache: "no-store",
    });
  } catch (err) {
    console.error("[pulse-state] KV write failed:", err);
  }
}

// Test seam: tests can reset the memory state between runs without
// touching KV. Not exported from the package index — internal-only.
export function _resetMemoryStateForTesting(): void {
  memoryState = { ...EMPTY_STATE };
}
