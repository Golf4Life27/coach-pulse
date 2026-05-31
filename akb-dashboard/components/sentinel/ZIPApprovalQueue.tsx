"use client";

// Phase 14 / D1 — ZIP market-expansion approval gate.
//
// Lists ZIPs in Market_Tier=approval_pending (per /api/zip-registry/queue).
// Each row: ZIP / State / Market / requested-at + Approve / Reject.
// Approve → active (one click). Reject → paused (requires a note).
// Both route through POST /api/zip-registry/decision, which stamps the
// operator + Approval_Method=dashboard and logs to the Spine.

import { useCallback, useEffect, useState } from "react";
import { showToast } from "@/components/Toast";

interface QueueItem {
  recordId: string;
  zip: string;
  state: string | null;
  market: string | null;
  approval_requested_at: string | null;
  memphis_required: boolean;
  notes: string | null;
}

interface RowState {
  submitting: "approve" | "reject" | null;
  rejecting: boolean; // reject-note panel open
  note: string;
  done: boolean;
}

const initialRowState: RowState = {
  submitting: null,
  rejecting: false,
  note: "",
  done: false,
};

function formatRequestedAt(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "1d ago";
  return `${days}d ago`;
}

export default function ZIPApprovalQueue() {
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [rowStates, setRowStates] = useState<Record<string, RowState>>({});

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch("/api/zip-registry/queue", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) {
          const data = await r.json().catch(() => ({}));
          throw new Error(data.error ?? `HTTP ${r.status}`);
        }
        return r.json();
      })
      .then((data: { items: QueueItem[] }) => setItems(data.items))
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const getRow = useCallback(
    (recordId: string): RowState => rowStates[recordId] ?? initialRowState,
    [rowStates],
  );

  const setRow = useCallback((recordId: string, next: RowState) => {
    setRowStates((prev) => ({ ...prev, [recordId]: next }));
  }, []);

  const submit = useCallback(
    async (item: QueueItem, decision: "approve" | "reject", note: string) => {
      const current = getRow(item.recordId);
      setRow(item.recordId, { ...current, submitting: decision });
      try {
        const res = await fetch("/api/zip-registry/decision", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            recordId: item.recordId,
            decision,
            notes: decision === "reject" ? note : undefined,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          showToast(data.detail ?? data.error ?? "Decision failed");
          setRow(item.recordId, { ...current, submitting: null });
          return;
        }
        showToast(
          decision === "approve"
            ? `${item.zip} approved → active`
            : `${item.zip} rejected → paused`,
          "success",
        );
        setRow(item.recordId, { ...current, submitting: null, done: true });
      } catch (err) {
        showToast(`Decision failed: ${String(err)}`);
        setRow(item.recordId, { ...current, submitting: null });
      }
    },
    [getRow, setRow],
  );

  const visible = (items ?? []).filter((it) => !getRow(it.recordId).done);

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-bold text-white">
            Sentinel · ZIP expansion approvals
          </h1>
          <p className="text-[11px] text-gray-500">
            ZIPs awaiting a go/no-go before they enter active outreach. Approve
            promotes to <em>active</em>; reject pauses the ZIP.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="text-xs bg-[#1c2128] border border-[#30363d] text-gray-300 px-3 py-1.5 rounded hover:bg-[#30363d] disabled:opacity-50"
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/40 rounded px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      {!loading && items && visible.length === 0 && !error && (
        <div className="bg-[#161b22] rounded-lg border border-[#30363d] p-6 text-center text-sm text-gray-500">
          No ZIPs awaiting approval.
        </div>
      )}

      <div className="space-y-2.5">
        {visible.map((it) => {
          const rs = getRow(it.recordId);
          const busy = rs.submitting !== null;
          return (
            <div
              key={it.recordId}
              className="bg-[#161b22] rounded-lg border border-[#30363d] p-3 space-y-2"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1 min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-white">{it.zip}</span>
                    {it.state && (
                      <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-[#0d1117] border border-[#30363d] text-gray-400">
                        {it.state}
                      </span>
                    )}
                    {it.market && (
                      <span className="text-[11px] text-gray-400">{it.market}</span>
                    )}
                    {it.memphis_required && (
                      <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-300">
                        Memphis assignment
                      </span>
                    )}
                    <span className="text-[10px] text-gray-500">
                      requested {formatRequestedAt(it.approval_requested_at)}
                    </span>
                  </div>
                  {it.notes && (
                    <p className="text-[11px] text-gray-500 whitespace-pre-wrap">{it.notes}</p>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => submit(it, "approve", "")}
                    disabled={busy}
                    className="text-[11px] bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white px-3 py-1.5 rounded"
                  >
                    {rs.submitting === "approve" ? "Approving…" : "Approve"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setRow(it.recordId, { ...rs, rejecting: !rs.rejecting })}
                    disabled={busy}
                    className="text-[11px] bg-[#1c2128] border border-[#30363d] hover:bg-[#30363d] disabled:opacity-50 text-gray-300 px-3 py-1.5 rounded"
                  >
                    Reject
                  </button>
                </div>
              </div>

              {rs.rejecting && (
                <div className="space-y-1.5 pt-1">
                  <textarea
                    value={rs.note}
                    onChange={(e) => setRow(it.recordId, { ...rs, note: e.target.value })}
                    rows={2}
                    placeholder="Reason for rejecting (required) — saved to the ZIP's Notes."
                    className="w-full bg-[#0d1117] border border-[#30363d] rounded p-2 text-[11px] text-white focus:outline-none focus:border-emerald-500 resize-y"
                  />
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => submit(it, "reject", rs.note)}
                      disabled={busy || rs.note.trim().length === 0}
                      className="text-[11px] bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white px-3 py-1.5 rounded"
                    >
                      {rs.submitting === "reject" ? "Rejecting…" : "Confirm reject → paused"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
