// Maverick operator-action queue — the "what needs YOU now" store.
// @agent: maverick
//
// The operator's Phase-C spec (2026-07-02, verbatim intent): "if I logged into
// my Dashboard it should show me front and center the most critical action
// items I am facing, with links to bring me where I need to go or instructions
// as to what I need to do or decide on and why" — ranked by revenue potential,
// time urgency, and operator-only-ness.
//
// Field data alone can't express these (a 2-day verbal window quoted in an SMS,
// an Authentisign invite sitting in Gmail, a POF ask). So Maverick CURATES this
// queue: sessions/automation write items via the priorities POST route; the
// dashboard renders the ranked top of it. Anti-staleness doctrine (CLAUDE.md —
// stale authority is worse than empty): every item REQUIRES expiresAt and
// auto-hides past it, and cards show their posted-age. The live-derived
// MorningBriefing below the strip remains the from-the-records truth layer.
//
// Storage: one KV key holding a JSON array. Pure ranking + IO helpers here so
// the route stays thin and the math is testable.

import type { KvClient } from "@/lib/maverick/oauth/kv";

export const OPERATOR_ACTIONS_KV_KEY = "maverick:operator_actions";

export interface OperatorAction {
  /** Stable slug, e.g. "joyce-tiger-flowers-offer". Upserts match on this. */
  id: string;
  /** Card headline — what to do, with the money object in it. */
  title: string;
  /** WHY this is top of the list — revenue story + urgency in plain English. */
  why: string;
  /** Exact steps / decision framing. Rendered under the why. */
  instructions: string | null;
  /** Where to go: internal path ("/pipeline/rec…") or external URL (Gmail). */
  href: string | null;
  /** Revenue potential in USD (estimate is fine — it drives ranking). */
  revenueUsd: number | null;
  /** Hard/soft deadline driving urgency ranking. Null = no clock. */
  deadlineAt: string | null;
  /** REQUIRED auto-hide moment — a stale card is worse than no card. */
  expiresAt: string;
  postedAt: string;
  /** Attribution, e.g. "maverick". */
  postedBy: string;
  /** Completed items are kept (audit) but never rendered. */
  done?: boolean;
}

/** Urgency buckets, most urgent first. Exported for the card chip. */
export type UrgencyBucket = "overdue" | "under_24h" | "under_72h" | "later" | "none";

export function urgencyBucket(a: OperatorAction, nowIso: string): UrgencyBucket {
  if (!a.deadlineAt) return "none";
  const ms = new Date(a.deadlineAt).getTime() - new Date(nowIso).getTime();
  if (!Number.isFinite(ms)) return "none";
  if (ms <= 0) return "overdue";
  if (ms <= 24 * 3600_000) return "under_24h";
  if (ms <= 72 * 3600_000) return "under_72h";
  return "later";
}

/** Human chip text for the deadline, e.g. "OVERDUE", "due in 5h", "due Jul 4". */
export function urgencyLabel(a: OperatorAction, nowIso: string): string | null {
  if (!a.deadlineAt) return null;
  const now = new Date(nowIso).getTime();
  const dl = new Date(a.deadlineAt).getTime();
  if (!Number.isFinite(dl)) return null;
  const ms = dl - now;
  if (ms <= 0) return "OVERDUE";
  const hours = Math.round(ms / 3600_000);
  if (hours <= 36) return `due in ${hours}h`;
  const d = new Date(a.deadlineAt);
  return `due ${d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Chicago" })}`;
}

const BUCKET_ORDER: Record<UrgencyBucket, number> = {
  overdue: 0,
  under_24h: 1,
  under_72h: 2,
  later: 3,
  none: 4,
};

/** Live = not done, not expired. */
export function isLive(a: OperatorAction, nowIso: string): boolean {
  if (a.done) return false;
  const exp = new Date(a.expiresAt).getTime();
  return Number.isFinite(exp) && exp > new Date(nowIso).getTime();
}

/** The operator's ranking doctrine: time urgency first (an overdue $8k beats a
 *  next-week $20k — the $20k will still be there tonight), then revenue, then
 *  freshness. Pure; ties stay stable. */
export function rankOperatorActions(actions: OperatorAction[], nowIso: string): OperatorAction[] {
  return actions
    .filter((a) => isLive(a, nowIso))
    .slice()
    .sort((x, y) => {
      const bx = BUCKET_ORDER[urgencyBucket(x, nowIso)];
      const by = BUCKET_ORDER[urgencyBucket(y, nowIso)];
      if (bx !== by) return bx - by;
      const rx = x.revenueUsd ?? 0;
      const ry = y.revenueUsd ?? 0;
      if (rx !== ry) return ry - rx;
      return new Date(y.postedAt).getTime() - new Date(x.postedAt).getTime();
    });
}

// ── KV IO ────────────────────────────────────────────────────────────

export async function readOperatorActions(kv: KvClient): Promise<OperatorAction[]> {
  const raw = await kv.get(OPERATOR_ACTIONS_KV_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as OperatorAction[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(kv: KvClient, actions: OperatorAction[]): Promise<void> {
  await kv.set(OPERATOR_ACTIONS_KV_KEY, JSON.stringify(actions));
}

/** Upsert by id (curated queue stays small; last write wins per id). */
export async function upsertOperatorActions(
  kv: KvClient,
  items: OperatorAction[],
): Promise<{ total: number }> {
  const existing = await readOperatorActions(kv);
  const byId = new Map(existing.map((a) => [a.id, a] as const));
  for (const item of items) byId.set(item.id, item);
  const all = Array.from(byId.values());
  await writeAll(kv, all);
  return { total: all.length };
}

/** Mark done by id (kept for audit; never rendered again). */
export async function completeOperatorActions(
  kv: KvClient,
  ids: string[],
): Promise<{ completed: number }> {
  const existing = await readOperatorActions(kv);
  let completed = 0;
  for (const a of existing) {
    if (ids.includes(a.id) && !a.done) {
      a.done = true;
      completed++;
    }
  }
  await writeAll(kv, existing);
  return { completed };
}
