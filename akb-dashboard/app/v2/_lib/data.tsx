"use client";

// V2 data spine — one shared fetch loop for the surfaces every screen needs
// (decision queue, operator items, briefing counts, audit tail). Pages with
// per-record needs (Deal Room) fetch their own routes on top of this.
// Read-only: every call here is a GET against an existing route.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  AuditEntry,
  AuditTailResponse,
  Briefing,
  OperatorItem,
  QueueResponse,
} from "./types";

const REFRESH_MS = 90_000;

export interface HealthSignal {
  label: string;
  /** ok | warn | fault | nodata */
  state: "ok" | "warn" | "fault" | "nodata";
  value: string;
  detail: string;
}

interface V2Data {
  queue: QueueResponse | null;
  operatorItems: OperatorItem[] | null;
  briefing: Briefing | null;
  audit: AuditEntry[] | null;
  auditWindow: { oldest: string | null; newest: string | null };
  health: HealthSignal[];
  openDecisionCount: number | null;
  loading: boolean;
  lastFetched: string | null;
  errors: string[];
  refresh: () => void;
  /** PATCH an operator item via the existing /api/operator-actions route. */
  setOperatorItemStatus: (id: string, status: "resolved" | "deferred") => Promise<boolean>;
}

const Ctx = createContext<V2Data | null>(null);

export function useV2Data(): V2Data {
  const v = useContext(Ctx);
  if (!v) throw new Error("useV2Data outside V2DataProvider");
  return v;
}

// ── Health derivation — every signal carries its source so the strip can
// say WHERE a number came from, and says "no signal" rather than faking. ──

function deriveHealth(
  audit: AuditEntry[] | null,
  openCount: number | null,
): HealthSignal[] {
  const out: HealthSignal[] = [];
  const entries = audit ?? [];

  // 1. Intake tick — newest intake-family event in the KV window.
  const intake = entries.find((e) => e.event.toLowerCase().includes("intake"));
  out.push(
    intake
      ? {
          label: "INTAKE",
          state:
            Date.now() - new Date(intake.ts).getTime() < 2 * 3_600_000
              ? "ok"
              : "warn",
          value: agoShort(intake.ts),
          detail: `${intake.event} · ${intake.status} (KV audit_log)`,
        }
      : {
          label: "INTAKE",
          state: "nodata",
          value: "no signal",
          detail: "no intake event in KV window (~5000 entries; old events age out)",
        },
  );

  // 2. Spend / circuit breaker — newest spend|circuit|firecrawl event.
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
          detail: `${spend.event} ${agoShort(spend.ts)} (KV audit_log)`,
        }
      : {
          label: "SPEND",
          state: "nodata",
          value: "no signal",
          detail: "no breaker event in KV window — breaker status needs a read route (backend request #1)",
        },
  );

  // 3. Quo delivery — send-confirmation events in the window.
  const sends = entries.filter((e) => {
    const k = e.event.toLowerCase();
    return k.includes("send") && (e.agent === "crier" || k.includes("outreach") || k.includes("quo"));
  });
  if (sends.length > 0) {
    const delivered = sends.filter(
      (e) =>
        e.status === "confirmed_success" ||
        e.decision === "delivered" ||
        (e.outputSummary && String(e.outputSummary["send_status"]) === "delivered"),
    ).length;
    const rate = Math.round((delivered / sends.length) * 100);
    out.push({
      label: "QUO",
      state: rate >= 90 ? "ok" : rate >= 60 ? "warn" : "fault",
      value: `${rate}% · ${delivered}/${sends.length}`,
      detail: `delivery-confirmed sends in KV window (positive-confirmation events)`,
    });
  } else {
    out.push({
      label: "QUO",
      state: "nodata",
      value: "no sends",
      detail: "no send events in KV window",
    });
  }

  // 4. Funnel-audit invariant — newest funnel/batch-audit event.
  const funnel = entries.find((e) => {
    const k = e.event.toLowerCase();
    return k.includes("funnel") || k.includes("batch_audit") || k.includes("outreach_batch");
  });
  out.push(
    funnel
      ? {
          label: "FUNNEL",
          state: funnel.status === "confirmed_failure" ? "fault" : "ok",
          value: funnel.status === "confirmed_failure" ? "VIOLATED" : "holds",
          detail: `${funnel.event} ${agoShort(funnel.ts)} — every in-scope lead in exactly one bucket`,
        }
      : {
          label: "FUNNEL",
          state: "nodata",
          value: "no signal",
          detail: "no funnel-audit event in KV window — runs with each batch plan",
        },
  );

  // 5. Open decisions — queue cards + operator items needing Alex.
  out.push({
    label: "DECISIONS",
    state: openCount == null ? "nodata" : openCount > 0 ? "warn" : "ok",
    value: openCount == null ? "—" : String(openCount),
    detail: "open queue cards + open operator action items",
  });

  return out;
}

function agoShort(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function V2DataProvider({ children }: { children: React.ReactNode }) {
  const [queue, setQueue] = useState<QueueResponse | null>(null);
  const [operatorItems, setOperatorItems] = useState<OperatorItem[] | null>(null);
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  const [auditWindow, setAuditWindow] = useState<{ oldest: string | null; newest: string | null }>({ oldest: null, newest: null });
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

    const [q, oa, b, at] = await Promise.all([
      grab<QueueResponse>("/api/queue", "queue"),
      grab<{ items: OperatorItem[] }>("/api/operator-actions", "operator-actions"),
      grab<Briefing>("/api/briefing", "briefing"),
      grab<AuditTailResponse>("/api/admin/audit-tail?limit=500", "audit-tail"),
    ]);

    if (q) setQueue(q);
    if (oa) setOperatorItems(oa.items);
    if (b) setBriefing(b);
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
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
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

  const openDecisionCount =
    queue || operatorItems
      ? (queue?.open.length ?? 0) + (operatorItems?.filter((i) => i.status !== "resolved").length ?? 0)
      : null;

  const health = deriveHealth(audit, openDecisionCount);

  return (
    <Ctx.Provider
      value={{
        queue,
        operatorItems,
        briefing,
        audit,
        auditWindow,
        health,
        openDecisionCount,
        loading,
        lastFetched,
        errors,
        refresh: load,
        setOperatorItemStatus,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

// ── Maverick panel state — any surface can open the panel pre-filled
// (e.g. "Recall context" on a decision card). ──

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
