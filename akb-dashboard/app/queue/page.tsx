"use client";

import { useState, useEffect, useCallback } from "react";
import { showToast } from "@/components/Toast";

interface Proposal {
  id: string;
  proposalType: string;
  recordId: string;
  recordAddress: string;
  reasoning: string;
  actionPayload: string;
  status: string;
  snoozeUntil: string | null;
}

const typeColors: Record<string, string> = {
  draft_followup: "border-purple-500 text-purple-400",
  mark_dead: "border-red-500 text-red-400",
  send_buyer_nudge: "border-blue-500 text-blue-400",
  suggest_dispo_price: "border-yellow-500 text-yellow-400",
};

const typeLabels: Record<string, string> = {
  draft_followup: "Draft Follow-Up",
  mark_dead: "Mark Dead",
  send_buyer_nudge: "Buyer Nudge",
  suggest_dispo_price: "Dispo Price",
};

export default function QueuePage() {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<Set<string>>(new Set());

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/proposals");
      if (!res.ok) throw new Error("API error");
      const data = await res.json();
      setProposals(data);
    } catch {
      showToast("Failed to fetch proposals.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleAction = async (
    proposalId: string,
    action: "approve" | "reject" | "snooze"
  ) => {
    if (action === "reject") {
      if (!window.confirm("Reject this proposal?")) return;
    }

    setActing((prev) => new Set(prev).add(proposalId));

    try {
      const res = await fetch("/api/proposals", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proposalId, action }),
      });
      if (!res.ok) {
        const data = await res.json();
        showToast(data.error || "Failed");
        return;
      }

      const actionLabel =
        action === "approve"
          ? "Approved"
          : action === "reject"
            ? "Rejected"
            : "Snoozed until 9am";

      showToast(actionLabel, "success");
      setProposals((prev) => prev.filter((p) => p.id !== proposalId));
    } catch {
      showToast("Failed to update");
    } finally {
      setActing((prev) => {
        const next = new Set(prev);
        next.delete(proposalId);
        return next;
      });
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-gray-400 animate-pulse">Loading queue...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-white">
          AGENT QUEUE{" "}
          <span className="text-sm text-gray-500 font-normal">
            ({proposals.length} pending)
          </span>
        </h1>
        <div className="flex gap-2">
          <button
            onClick={fetchData}
            className="text-xs bg-[#1c2128] border border-[#30363d] text-gray-300 px-3 py-1.5 rounded hover:bg-[#30363d] transition-colors"
          >
            Refresh
          </button>
          <button
            onClick={async () => {
              showToast("Running cron...", "success");
              const res = await fetch("/api/cron/propose-actions");
              const data = await res.json();
              showToast(
                `Scanned ${data.scanned}, created ${data.created} proposals`,
                "success"
              );
              fetchData();
            }}
            className="text-xs bg-purple-700 hover:bg-purple-600 text-white px-3 py-1.5 rounded transition-colors"
          >
            Run Proposals
          </button>
        </div>
      </div>

      {proposals.length === 0 ? (
        <div className="bg-[#1c2128] rounded-lg border border-[#30363d] p-12 text-center text-gray-500">
          No pending proposals. The agent queue is clear.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {proposals.map((p) => {
            const colors = typeColors[p.proposalType] || "border-gray-500 text-gray-400";
            const label = typeLabels[p.proposalType] || p.proposalType;
            const isActing = acting.has(p.id);

            return (
              <div
                key={p.id}
                className={`bg-[#1c2128] rounded-lg border-l-4 ${colors.split(" ")[0]} border border-[#30363d] p-4`}
              >
                <div className="flex justify-between items-start mb-2">
                  <span
                    className={`text-xs font-bold uppercase tracking-wider ${colors.split(" ")[1]}`}
                  >
                    {label}
                  </span>
                </div>

                <h3 className="text-white font-semibold text-sm mb-2">
                  {p.recordAddress || p.recordId}
                </h3>

                <p className="text-xs text-gray-400 mb-4 leading-relaxed">
                  {p.reasoning}
                </p>

                <div className="flex gap-2">
                  <button
                    onClick={() => handleAction(p.id, "approve")}
                    disabled={isActing}
                    className="flex-1 bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-semibold py-2.5 rounded transition-colors min-h-[44px] disabled:opacity-50"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => handleAction(p.id, "reject")}
                    disabled={isActing}
                    className="flex-1 bg-red-700 hover:bg-red-600 text-white text-xs font-semibold py-2.5 rounded transition-colors min-h-[44px] disabled:opacity-50"
                  >
                    Reject
                  </button>
                  <button
                    onClick={() => handleAction(p.id, "snooze")}
                    disabled={isActing}
                    className="flex-1 bg-[#30363d] hover:bg-[#3d444d] text-gray-300 text-xs font-semibold py-2.5 rounded transition-colors min-h-[44px] disabled:opacity-50"
                  >
                    Snooze
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
