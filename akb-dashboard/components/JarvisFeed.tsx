"use client";

import { useState, useEffect, useCallback } from "react";
import { showToast } from "@/components/Toast";

interface JarvisProposal {
  id: string;
  proposalType: string;
  recordId: string;
  recordAddress: string;
  reasoning: string;
  actionPayload: string;
  status: string;
  snoozeUntil: string | null;
}

interface ParsedPayload {
  recordId?: string;
  action?: string;
  to?: string;
  draftBody?: string;
  inboundBody?: string;
}

function parsePayload(raw: string): ParsedPayload {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export default function JarvisFeed() {
  const [proposals, setProposals] = useState<JarvisProposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Record<string, string>>({});

  const fetchProposals = useCallback(async () => {
    try {
      const res = await fetch("/api/proposals");
      if (!res.ok) return;
      const data: JarvisProposal[] = await res.json();
      setProposals(
        data.filter((p) => p.proposalType === "jarvis_reply")
      );
    } catch {
      // non-fatal — feed is supplementary
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProposals();
    const interval = setInterval(fetchProposals, 30_000);
    return () => clearInterval(interval);
  }, [fetchProposals]);

  const handleDismiss = async (proposalId: string) => {
    setActing((prev) => new Set(prev).add(proposalId));
    try {
      const res = await fetch("/api/proposals", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proposalId, action: "reject" }),
      });
      if (res.ok) {
        setProposals((prev) => prev.filter((p) => p.id !== proposalId));
        showToast("Dismissed", "success");
      }
    } catch {
      showToast("Failed to dismiss");
    } finally {
      setActing((prev) => {
        const next = new Set(prev);
        next.delete(proposalId);
        return next;
      });
    }
  };

  const handleSend = async (proposal: JarvisProposal) => {
    const payload = parsePayload(proposal.actionPayload);
    const body = editing[proposal.id] ?? payload.draftBody;
    if (!body || !payload.to) {
      showToast("Missing phone number or message body");
      return;
    }

    setActing((prev) => new Set(prev).add(proposal.id));
    try {
      // Send via Quo through a server-side proxy (to avoid exposing QUO_API_KEY)
      const res = await fetch("/api/jarvis-send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proposalId: proposal.id,
          to: payload.to,
          message: body,
          recordId: payload.recordId,
        }),
      });

      if (res.ok) {
        setProposals((prev) => prev.filter((p) => p.id !== proposal.id));
        showToast("Sent via Quo", "success");
      } else {
        const data = await res.json();
        showToast(data.error || "Send failed");
      }
    } catch {
      showToast("Send failed");
    } finally {
      setActing((prev) => {
        const next = new Set(prev);
        next.delete(proposal.id);
        return next;
      });
    }
  };

  const toggleEdit = (proposalId: string, currentDraft: string) => {
    setEditing((prev) => {
      if (prev[proposalId] !== undefined) {
        const next = { ...prev };
        delete next[proposalId];
        return next;
      }
      return { ...prev, [proposalId]: currentDraft };
    });
  };

  if (loading || proposals.length === 0) return null;

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-bold text-purple-400 uppercase tracking-wider">
        Jarvis — Inbound Replies ({proposals.length})
      </h2>
      <div className="space-y-3">
        {proposals.map((p) => {
          const payload = parsePayload(p.actionPayload);
          const isActing = acting.has(p.id);
          const isEditing = editing[p.id] !== undefined;
          const draftBody = editing[p.id] ?? payload.draftBody ?? "";

          return (
            <div
              key={p.id}
              className="bg-[#1c2128] rounded-lg border-l-4 border-purple-500 border border-[#30363d] p-4"
            >
              {/* Header */}
              <div className="flex justify-between items-start mb-2">
                <div>
                  <span className="text-white font-semibold text-sm">
                    {p.recordAddress}
                  </span>
                </div>
                <span className="text-[10px] text-gray-500 uppercase tracking-wider">
                  Jarvis
                </span>
              </div>

              {/* Inbound message */}
              {payload.inboundBody && (
                <div className="mb-3 bg-[#0d1117] rounded p-2.5 border border-[#30363d]">
                  <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">
                    Agent said:
                  </p>
                  <p className="text-sm text-gray-200 leading-relaxed">
                    &ldquo;{payload.inboundBody}&rdquo;
                  </p>
                </div>
              )}

              {/* AI draft */}
              <div className="mb-3">
                <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">
                  Suggested reply:
                </p>
                {isEditing ? (
                  <textarea
                    value={draftBody}
                    onChange={(e) =>
                      setEditing((prev) => ({
                        ...prev,
                        [p.id]: e.target.value,
                      }))
                    }
                    className="w-full bg-[#0d1117] border border-purple-500/50 rounded p-2.5 text-sm text-white focus:outline-none focus:border-purple-400 resize-y min-h-[80px]"
                  />
                ) : (
                  <p className="text-sm text-emerald-300 leading-relaxed bg-emerald-500/5 rounded p-2.5 border border-emerald-500/20">
                    {draftBody}
                  </p>
                )}
              </div>

              {/* Actions */}
              <div className="flex gap-2">
                <button
                  onClick={() => handleSend(p)}
                  disabled={isActing}
                  className="flex-1 bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-semibold py-2.5 rounded transition-colors min-h-[44px] disabled:opacity-50"
                >
                  {isActing ? "..." : "Send"}
                </button>
                <button
                  onClick={() => toggleEdit(p.id, payload.draftBody ?? "")}
                  disabled={isActing}
                  className="flex-1 bg-[#30363d] hover:bg-[#3d444d] text-gray-300 text-xs font-semibold py-2.5 rounded transition-colors min-h-[44px] disabled:opacity-50"
                >
                  {isEditing ? "Done" : "Edit"}
                </button>
                <button
                  onClick={() => handleDismiss(p.id)}
                  disabled={isActing}
                  className="flex-1 bg-red-700/50 hover:bg-red-700 text-gray-300 text-xs font-semibold py-2.5 rounded transition-colors min-h-[44px] disabled:opacity-50"
                >
                  Dismiss
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
