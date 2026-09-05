"use client";

// Build Ledger page — what is in the works, each step's status/% progress,
// and the operator's action items (operator directive 2026-09-05, "the
// durable list Alex reads every morning"). Dark palette matches
// app/system/page.tsx and app/health/page.tsx.

import { useCallback, useEffect, useState } from "react";
import { showToast } from "@/components/Toast";

interface BuildStep {
  id: string;
  step: string;
  project: string;
  status: string | null;
  progressPct: number | null;
  owner: string | null;
  actionItem: string | null;
  nextStep: string | null;
  blockedBy: string | null;
  order: number | null;
  spineRef: string | null;
  updatedAt: string | null;
  notes: string | null;
}

interface ProjectSummary {
  project: string;
  progressPct: number;
  stepsTotal: number;
  stepsDone: number;
  inProgress: BuildStep[];
  blocked: BuildStep[];
  nextSteps: string[];
}

interface OperatorActionItem {
  project: string;
  step: string;
  actionItem: string;
  updatedAt: string | null;
}

interface BuildLedgerSummary {
  projects: ProjectSummary[];
  operatorActionItems: OperatorActionItem[];
  counts: { inWorks: number; blocked: number; done: number; operatorActions: number };
  staleSteps: BuildStep[];
}

const STATUS_STYLE: Record<string, string> = {
  Idea: "bg-[#161b22] text-gray-400 border-[#30363d]",
  Planned: "bg-sky-950/40 text-sky-300 border-sky-500/40",
  "In Progress": "bg-emerald-950/40 text-emerald-300 border-emerald-500/40",
  Blocked: "bg-red-950/50 text-red-300 border-red-500/40",
  Done: "bg-emerald-900/60 text-emerald-200 border-emerald-600/50",
  Parked: "bg-[#161b22] text-gray-500 border-[#30363d]",
};

const STATUS_ACTIONS = ["Done", "In Progress", "Blocked", "Parked"] as const;

function StatusChip({ status }: { status: string | null }) {
  const cls = STATUS_STYLE[status ?? ""] ?? STATUS_STYLE.Idea;
  return (
    <span className={`text-[10px] font-bold tracking-wider px-2 py-0.5 rounded-full border ${cls}`}>
      {(status ?? "—").toUpperCase()}
    </span>
  );
}

function ProgressBar({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div className="w-full h-2 rounded-full bg-[#161b22] border border-[#30363d] overflow-hidden">
      <div
        className="h-full bg-emerald-500/80 transition-all"
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

export default function BuildLedgerPage() {
  const [summary, setSummary] = useState<BuildLedgerSummary | null>(null);
  const [steps, setSteps] = useState<BuildStep[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyStepId, setBusyStepId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/build-ledger", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "load_failed");
      setSummary(data.summary as BuildLedgerSummary);
      setSteps((data.steps as BuildStep[]) ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const setStepStatus = useCallback(
    async (s: BuildStep, status: string) => {
      setBusyStepId(s.id);
      try {
        const res = await fetch("/api/build-ledger", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ project: s.project, step: s.step, status }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error ?? "update_failed");
        showToast(`${s.step} → ${status}`);
        await load();
      } catch (e) {
        showToast(`Failed to update: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBusyStepId(null);
      }
    },
    [load],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-gray-400 animate-pulse">Loading build ledger…</div>
      </div>
    );
  }

  const actionItems = summary?.operatorActionItems ?? [];
  const staleSteps = summary?.staleSteps ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-white">BUILD LEDGER</h1>
        <button
          onClick={load}
          className="text-xs bg-[#1c2128] border border-[#30363d] text-gray-300 px-3 py-1.5 rounded hover:bg-[#30363d] transition-colors"
        >
          Refresh
        </button>
      </div>

      {error && (
        <div className="text-xs text-red-300 border border-red-500/40 rounded-xl px-3 py-2 bg-red-950/20">
          {error}
        </div>
      )}

      {/* YOUR ACTION ITEMS — unmissable */}
      <div className="bg-[#1c2128] rounded-lg border-2 border-amber-500/60 overflow-hidden">
        <div className="px-4 py-3 border-b border-amber-500/40 bg-amber-950/20">
          <h2 className="text-sm font-bold text-amber-300 tracking-wider">YOUR ACTION ITEMS</h2>
          <p className="text-[11px] text-amber-200/70 mt-0.5">Things only you can do to keep the build moving.</p>
        </div>
        <div className="p-3 space-y-2">
          {actionItems.length === 0 ? (
            <div className="text-center py-6 text-emerald-400 text-sm font-medium">
              Nothing needs you.
            </div>
          ) : (
            actionItems.map((a, i) => (
              <div
                key={`${a.project}-${a.step}-${i}`}
                className="bg-[#161b22] border border-amber-500/30 rounded-lg p-3"
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[11px] px-1.5 py-0.5 rounded bg-[#30363d] text-gray-300">{a.project}</span>
                  <span className="text-xs text-gray-500">{a.step}</span>
                </div>
                <p className="text-base text-white font-semibold leading-snug">{a.actionItem}</p>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Stale flags */}
      {staleSteps.length > 0 && (
        <div className="bg-[#1c2128] rounded-lg border border-red-500/40 p-3">
          <h2 className="text-xs font-bold text-red-300 tracking-wider mb-2">
            STALE — In Progress with no update in 7+ days
          </h2>
          <div className="flex flex-wrap gap-2">
            {staleSteps.map((s) => (
              <span
                key={s.id}
                className="text-[11px] px-2 py-1 rounded border border-red-500/40 bg-red-950/30 text-red-200"
              >
                {s.project} · {s.step}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Per-project cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {(summary?.projects ?? []).map((p) => (
          <div key={p.project} className="bg-[#1c2128] rounded-lg border border-[#30363d] overflow-hidden">
            <div className="p-4 border-b border-[#30363d]">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-white">{p.project}</h3>
                <span className="text-xs text-gray-400">
                  {p.stepsDone}/{p.stepsTotal} done
                </span>
              </div>
              <div className="mt-2">
                <ProgressBar pct={p.progressPct} />
                <div className="text-[11px] text-gray-500 mt-1">{p.progressPct}% complete</div>
              </div>
            </div>
            <div className="p-2 space-y-2 max-h-[50vh] overflow-y-auto">
              {(stepsForProject(steps, p.project)).map((s) => (
                <div key={s.id} className="bg-[#161b22] rounded p-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm text-white font-medium leading-snug">{s.step}</p>
                    <StatusChip status={s.status} />
                  </div>
                  {s.nextStep && (
                    <p className="text-xs text-gray-400 mt-1">
                      <span className="text-gray-500">Next:</span> {s.nextStep}
                    </p>
                  )}
                  {s.blockedBy && (
                    <p className="text-xs text-red-300 mt-1">
                      <span className="text-red-400 font-semibold">Blocked by:</span> {s.blockedBy}
                    </p>
                  )}
                  {s.owner === "operator" && s.actionItem && (
                    <p className="text-xs text-amber-300 mt-1">
                      <span className="font-semibold">Your action:</span> {s.actionItem}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {STATUS_ACTIONS.filter((a) => a !== s.status).map((action) => (
                      <button
                        key={action}
                        disabled={busyStepId === s.id}
                        onClick={() => setStepStatus(s, action)}
                        className="text-[10px] px-2 py-1 rounded border border-[#30363d] text-gray-400 hover:bg-[#30363d] hover:text-white transition-colors disabled:opacity-40"
                      >
                        {action}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              {p.stepsTotal === 0 && (
                <div className="text-center py-6 text-gray-600 text-xs">No steps</div>
              )}
            </div>
          </div>
        ))}
        {(summary?.projects ?? []).length === 0 && !error && (
          <div className="col-span-full text-center py-12 text-gray-500 text-sm">
            Nothing in the build ledger yet.
          </div>
        )}
      </div>
    </div>
  );
}

// All steps for one project, in Order — the API's flat `steps` list is
// already sorted Project then Order, so filtering preserves that order.
function stepsForProject(steps: BuildStep[], project: string): BuildStep[] {
  return steps.filter((s) => s.project === project);
}
