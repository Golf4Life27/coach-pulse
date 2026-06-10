"use client";

// V2 data spine — one shared fetch loop for the surfaces every screen needs
// (decision queue, operator items, listings, audit tail). Read-only: every
// call here is a GET against an existing route. /api/briefing is NOT
// fetched here — v1's BriefingProvider already polls it; v2 derives its
// own counts from the sources below.
//
// HONEST ZERO (design law, operator review 6/10): a number renders only when
// its wired source actually returned it. Unwired or out-of-window sources
// render "no signal" — never a confident zero.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  AuditEntry,
  AuditTailResponse,
  ListingDetail,
  OperatorItem,
  QueueCard,
  QueueResponse,
} from "./types";
import { classifyOperatorItems, listingSuppression, marketSuppression } from "./policy";
import { ago, isLocalToday, startOfLocalDayIso } from "./format";

const REFRESH_MS = 90_000;
const SEND_EVENT = "outreach_batch_send";

export interface HealthSignal {
  label: string;
  state: "ok" | "warn" | "fault" | "nodata";
  value: string;
  detail: string;
}

interface ActivityToday {
  /** Confirmed-delivered offer texts today; null = no wired signal. */
  sends: number | null;
  sendsSource: string;
  /** Listings with an inbound reply today; null = listings not loaded. */
  replies: number | null;
}

interface V2Data {
  queue: QueueResponse | null;
  /** Open queue cards minus paused-market listings (queue hygiene). */
  openCards: QueueCard[];
  suppressedCards: Array<{ card: QueueCard; reference: string }>;
  operatorItems: OperatorItem[] | null;
  actionableItems: OperatorItem[];
  suppressedItems: Array<{ item: OperatorItem; reference: string }>;
  /** NOTE: fetched with ?include_dead=true so queue hygiene can see the
   *  terminal records operator items still reference. Consumers rendering
   *  inventory must filter dead/do-not-text themselves (the boards do). */
  listings: ListingDetail[] | null;
  listingsById: Map<string, ListingDetail>;
  audit: AuditEntry[] | null;
  auditWindow: { oldest: string | null; newest: string | null };
  activityToday: ActivityToday;
  health: HealthSignal[];
  openDecisionCount: number | null;
  loading: boolean;
  lastFetched: string | null;
  errors: string[];
  refresh: () => void;
  setOperatorItemStatus: (id: string, status: "resolved" | "deferred") => Promise<boolean>;
}

const Ctx = createContext<V2Data | null>(null);

export function useV2Data(): V2Data {
  const v = useContext(Ctx);
  if (!v) throw new Error("useV2Data outside V2DataProvider");
  return v;
}

// ── Activity today, honest-zero rules. "Today" is the VIEWER'S local day
// (isLocalToday), not the UTC day. Audit log is the primary send source
// (positive-confirmation events); listings Last_Outreach_Date is the backstop
// when the KV window doesn't reach back to local midnight. ──

function deriveActivity(
  audit: AuditEntry[] | null,
  auditOldest: string | null,
  listings: ListingDetail[] | null,
): ActivityToday {
  let sends: number | null = null;
  let sendsSource = "no signal";

  if (audit) {
    const auditSends = audit.filter(
      (e) => e.event === SEND_EVENT && isLocalToday(e.ts) && e.status === "confirmed_success",
    ).length;
    const windowCoversToday = auditOldest != null && auditOldest <= startOfLocalDayIso();
    if (auditSends > 0 || windowCoversToday) {
      sends = auditSends;
      sendsSource = "KV audit_log (delivery-confirmed sends)";
    }
  }
  if (sends == null && listings) {
    sends = listings.filter((l) => isLocalToday(l.lastOutreachDate)).length;
    sendsSource = "Listings Last_Outreach_Date (audit window doesn't reach midnight)";
  }

  const replies = listings ? listings.filter((l) => isLocalToday(l.lastInboundAt)).length : null;

  return { sends, sendsSource, replies };
}

function deriveHealth(
  audit: AuditEntry[] | null,
  openCount: number | null,
  activity: ActivityToday,
): HealthSignal[] {
  const out: HealthSignal[] = [];
  const entries = audit ?? [];

  const intake = entries.find((e) => e.event.toLowerCase().includes("intake"));
  out.push(
    intake
      ? {
          label: "INTAKE",
          state: Date.now() - new Date(intake.ts).getTime() < 2 * 3_600_000 ? "ok" : "warn",
          value: ago(intake.ts),
          detail: `last intake event ${intake.status === "confirmed_success" ? "succeeded" : intake.status.replace("_", " ")} (KV audit log)`,
        }
      : {
          label: "INTAKE",
          state: "nodata",
          value: "no signal",
          detail: "no intake event inside the audit window — old events age out; not the same as 'intake stopped'",
        },
  );

  const spend = entries.find((e) => {
    const k = e.event.toLowerCase();
    return k.includes("spend") || k.includes("circuit") || k.includes("breaker") || k.includes("firecrawl");
  });
  out.push(
    spend
      ? {
          label: "SPEND",
          state: spend.status === "confirmed_failure" ? "fault" : "ok",
          value: spend.status === "confirmed_failure" ? "TRIPPED" : "armed",
          detail: `last breaker event ${ago(spend.ts)} (KV audit log)`,
        }
      : {
          label: "SPEND",
          state: "nodata",
          value: "no signal",
          detail: "breaker status needs its own read route (ops request #1) — until then only breaker EVENTS would show here",
        },
  );

  // QUO — delivery-confirmed sends. Exact event match; no signal ≠ zero sends.
  const sends = entries.filter((e) => e.event === SEND_EVENT);
  if (sends.length > 0) {
    const delivered = sends.filter((e) => e.status === "confirmed_success").length;
    const rate = Math.round((delivered / sends.length) * 100);
    out.push({
      label: "QUO",
      state: rate >= 90 ? "ok" : rate >= 60 ? "warn" : "fault",
      value: `${delivered}/${sends.length} delivered`,
      detail: `${rate}% of sends in the audit window confirmed delivered (read back from Quo by id, not assumed)`,
    });
  } else {
    out.push({
      label: "QUO",
      state: "nodata",
      value: "no signal",
      detail:
        activity.sends && activity.sends > 0
          ? `${activity.sends} sends today per ${activity.sendsSource}, but their delivery events have aged out of the audit window`
          : "no send events inside the audit window — not the same as 'no sends'",
    });
  }

  const funnel = entries.find((e) => {
    const k = e.event.toLowerCase();
    return k.includes("funnel") || k.includes("outreach_batch");
  });
  out.push(
    funnel
      ? {
          label: "FUNNEL",
          state: funnel.status === "confirmed_failure" ? "fault" : "ok",
          value: funnel.status === "confirmed_failure" ? "VIOLATED" : "holds",
          detail: `last batch ${ago(funnel.ts)} — every in-scope lead landed in exactly one bucket`,
        }
      : {
          label: "FUNNEL",
          state: "nodata",
          value: "no signal",
          detail: "no batch event inside the audit window — durable snapshot is ops request #2",
        },
  );

  out.push({
    label: "DECISIONS",
    state: openCount == null ? "nodata" : openCount > 0 ? "warn" : "ok",
    value: openCount == null ? "no signal" : String(openCount),
    detail:
      "forward-only count: open queue cards + actionable operator items. Dead / do-not-text / paused-market records are excluded — the spine already decided those.",
  });

  return out;
}

export function V2DataProvider({ children }: { children: React.ReactNode }) {
  const [queue, setQueue] = useState<QueueResponse | null>(null);
  const [operatorItems, setOperatorItems] = useState<OperatorItem[] | null>(null);
  const [listings, setListings] = useState<ListingDetail[] | null>(null);
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  const [auditWindow, setAuditWindow] = useState<{ oldest: string | null; newest: string | null }>({
    oldest: null,
    newest: null,
  });
  const [loading, setLoading] = useState(true);
  const [lastFetched, setLastFetched] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const errs: string[] = [];
    const grab = async <T,>(url: string, label: string): Promise<T | null> => {
      try {
        const r = await fetch(url, { cache: "no-store" });
        if (!r.ok) {
          errs.push(`${label}: HTTP ${r.status}`);
          return null;
        }
        return (await r.json()) as T;
      } catch (e) {
        errs.push(`${label}: ${String(e)}`);
        return null;
      }
    };

    const [q, oa, at, ls] = await Promise.all([
      grab<QueueResponse>("/api/queue", "queue"),
      grab<{ items: OperatorItem[] }>("/api/operator-actions", "operator-actions"),
      grab<AuditTailResponse>("/api/admin/audit-tail?limit=500", "audit-tail"),
      // include_dead so queue hygiene can see terminal records that operator
      // items still reference.
      grab<ListingDetail[]>("/api/listings?include_dead=true", "listings"),
    ]);

    if (q) setQueue(q);
    if (oa) setOperatorItems(oa.items);
    if (ls) setListings(ls);
    if (at?.ok) {
      setAudit(at.entries);
      setAuditWindow({ oldest: at.kv_oldest_ts, newest: at.kv_newest_ts });
    }
    setErrors(errs);
    setLastFetched(new Date().toISOString());
    setLoading(false);
    inFlight.current = false;
  }, []);

  useEffect(() => {
    load();
    // Don't poll while the tab is hidden — refresh immediately on return
    // instead. The strip is global, so this loop runs on every page.
    const t = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const setOperatorItemStatus = useCallback(
    async (id: string, status: "resolved" | "deferred"): Promise<boolean> => {
      try {
        const r = await fetch("/api/operator-actions", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, status }),
        });
        if (!r.ok) return false;
        setOperatorItems((prev) => (prev ? prev.filter((i) => i.id !== id) : prev));
        return true;
      } catch {
        return false;
      }
    },
    [],
  );

  const listingsById = useMemo(() => {
    const m = new Map<string, ListingDetail>();
    for (const l of listings ?? []) m.set(l.id, l);
    return m;
  }, [listings]);

  // Queue hygiene — operator items + queue cards through the policy filter.
  // Ordering happens once, in policy.mergeAndSort, at the board.
  const { actionableItems, suppressedItems } = useMemo(
    () => {
      const c = classifyOperatorItems(operatorItems ?? [], listingsById);
      return { actionableItems: c.actionable, suppressedItems: c.suppressed };
    },
    [operatorItems, listingsById],
  );

  const { openCards, suppressedCards } = useMemo(() => {
    const open: QueueCard[] = [];
    const supp: Array<{ card: QueueCard; reference: string }> = [];
    for (const card of queue?.open ?? []) {
      // /api/queue already drops dead + do-not-text listings; paused markets
      // and any terminal record it misses get caught here. card.state is the
      // GEOGRAPHIC state ("TN"), not the card's hold status (cardState).
      const listing = card.table === "listings" ? listingsById.get(card.recordId) : null;
      const v = listing ? listingSuppression(listing) : marketSuppression(card.state);
      if (v.suppressed) supp.push({ card, reference: v.reference! });
      else open.push(card);
    }
    return { openCards: open, suppressedCards: supp };
  }, [queue, listingsById]);

  // HONEST ZERO: the count renders only when BOTH sources loaded — a failed
  // queue fetch must not present "operator items only" as the whole truth.
  const openDecisionCount =
    queue && operatorItems ? openCards.length + actionableItems.length : null;

  const activityToday = useMemo(
    () => deriveActivity(audit, auditWindow.oldest, listings),
    [audit, auditWindow.oldest, listings],
  );

  const health = useMemo(
    () => deriveHealth(audit, openDecisionCount, activityToday),
    [audit, openDecisionCount, activityToday],
  );

  // Stable context identity between data refreshes — consumers across every
  // page subscribe to this; don't re-render them for a no-op render pass.
  const value = useMemo<V2Data>(
    () => ({
      queue,
      openCards,
      suppressedCards,
      operatorItems,
      actionableItems,
      suppressedItems,
      listings,
      listingsById,
      audit,
      auditWindow,
      activityToday,
      health,
      openDecisionCount,
      loading,
      lastFetched,
      errors,
      refresh: load,
      setOperatorItemStatus,
    }),
    [
      queue,
      openCards,
      suppressedCards,
      operatorItems,
      actionableItems,
      suppressedItems,
      listings,
      listingsById,
      audit,
      auditWindow,
      activityToday,
      health,
      openDecisionCount,
      loading,
      lastFetched,
      errors,
      load,
      setOperatorItemStatus,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// ── Maverick panel state ──

interface MaverickPanelState {
  open: boolean;
  prefill: string | null;
  setOpen: (v: boolean) => void;
  openWithQuery: (q: string) => void;
  consumePrefill: () => string | null;
}

const MavCtx = createContext<MaverickPanelState | null>(null);

export function useMaverickPanel(): MaverickPanelState {
  const v = useContext(MavCtx);
  if (!v) throw new Error("useMaverickPanel outside provider");
  return v;
}

export function MaverickPanelProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [prefill, setPrefill] = useState<string | null>(null);

  const openWithQuery = useCallback((q: string) => {
    setPrefill(q);
    setOpen(true);
  }, []);

  const consumePrefill = useCallback(() => {
    const p = prefill;
    setPrefill(null);
    return p;
  }, [prefill]);

  return (
    <MavCtx.Provider value={{ open, prefill, setOpen, openWithQuery, consumePrefill }}>
      {children}
    </MavCtx.Provider>
  );
}
