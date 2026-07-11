"use client";

// THE decision conveyor — the one ranked feed that replaced the Top
// Priorities strip, Act Now, and the /queue grid (operator 2026-07-11,
// silver-platter cockpit).
//
// Sources (each already freshness-gated by its API — the UX LAW "if it
// renders, it's live" is enforced at the source, merged here):
//   /api/proposals          Pending Agent_Proposals (2A sends + 2C rulings)
//   /api/operator-actions   Operator_Action_Items  (2B/2C decisions)
//   /api/maverick/priorities curated strip          (2B/2C with real $ + clocks)
//   /api/jarvis-brief       Act Now cards           (async — slots in when ready)
//
// The first three load fast and render immediately; the brief (LLM pass) is
// progressive — its cards join the ranked feed when they arrive, deduped
// against proposals for the same record.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { showToast } from "@/components/Toast";
import ConveyorCard from "@/components/conveyor/ConveyorCard";
import {
  buildConveyor,
  type ActionItemRow,
  type BroCardRow,
  type ConveyorAction,
  type ConveyorItem,
  type PriorityRow,
  type ProposalRow,
} from "@/lib/conveyor/model";

export default function ConveyorFeed() {
  const [proposals, setProposals] = useState<ProposalRow[]>([]);
  const [actionItems, setActionItems] = useState<ActionItemRow[]>([]);
  const [priorities, setPriorities] = useState<PriorityRow[]>([]);
  const [broCards, setBroCards] = useState<BroCardRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [briefLoading, setBriefLoading] = useState(true);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [nowMs, setNowMs] = useState(() => Date.now());
  const alive = useRef(true);

  const loadFast = useCallback(async () => {
    const [p, a, pr] = await Promise.allSettled([
      fetch("/api/proposals").then((r) => (r.ok ? r.json() : Promise.reject(r.status))),
      fetch("/api/operator-actions").then((r) => (r.ok ? r.json() : Promise.reject(r.status))),
      fetch("/api/maverick/priorities", { cache: "no-store" }).then((r) => (r.ok ? r.json() : Promise.reject(r.status))),
    ]);
    if (!alive.current) return;
    if (p.status === "fulfilled" && Array.isArray(p.value)) setProposals(p.value);
    if (a.status === "fulfilled") setActionItems(a.value.items ?? []);
    if (pr.status === "fulfilled") setPriorities(pr.value.actions ?? []);
    setNowMs(Date.now());
    setLoading(false);
  }, []);

  const loadBrief = useCallback(async () => {
    setBriefLoading(true);
    try {
      const res = await fetch("/api/jarvis-brief");
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      if (!alive.current) return;
      const cards = Array.isArray(data.broCards) ? data.broCards : [];
      setBroCards(
        cards
          .filter((c: Record<string, unknown>) => typeof c.recordId === "string")
          .map((c: Record<string, unknown>) => ({
            recordId: c.recordId as string,
            address: (c.address as string) ?? "",
            headline: (c.headline as string) ?? "",
            why_this_matters: (c.why_this_matters as string) ?? "",
          })),
      );
    } catch {
      /* brief is progressive enhancement — the fast feed stands alone */
    } finally {
      if (alive.current) setBriefLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    loadFast();
    loadBrief();
    const t = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [loadFast, loadBrief]);

  const { items, hidden } = useMemo(
    () => buildConveyor({ proposals, actionItems, priorities, broCards }, new Date(nowMs).toISOString()),
    [proposals, actionItems, priorities, broCards, nowMs],
  );

  const removeItem = useCallback((item: ConveyorItem) => {
    if (item.source === "proposal") setProposals((prev) => prev.filter((p) => `proposal:${p.id}` !== item.key));
    else if (item.source === "action_item") setActionItems((prev) => prev.filter((a) => `action_item:${a.id}` !== item.key));
    else if (item.source === "priority") setPriorities((prev) => prev.filter((p) => `priority:${p.id}` !== item.key));
    else setBroCards((prev) => prev.filter((b) => `brocard:${b.recordId}` !== item.key));
  }, []);

  const onAction = useCallback(
    async (item: ConveyorItem, action: ConveyorAction, opts?: { editedBody?: string }) => {
      if (action.kind === "open") return; // links navigate on their own
      if (action.kind === "proposal_reject" && !window.confirm("Kill this card? The proposal is rejected.")) return;
      setBusy((prev) => new Set(prev).add(item.key));
      try {
        let ok = false;
        let message = "";
        if (
          action.kind === "proposal_send" ||
          action.kind === "proposal_approve" ||
          action.kind === "proposal_snooze" ||
          action.kind === "proposal_reject"
        ) {
          const res = await fetch("/api/proposals", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              proposalId: action.proposalId,
              action: action.kind === "proposal_send" ? "approve" : action.kind.replace("proposal_", ""),
              dispatch: action.kind === "proposal_send" ? true : undefined,
              editedBody: opts?.editedBody,
            }),
          });
          const data = await res.json().catch(() => ({}));
          ok = res.ok;
          message = ok
            ? action.kind === "proposal_send"
              ? "Reply sent ✓"
              : action.kind === "proposal_approve"
                ? "Approved"
                : action.kind === "proposal_snooze"
                  ? "Snoozed until 9am"
                  : "Killed"
            : data.skipReason || data.error || "Failed";
        } else if (action.kind === "action_item_resolve" || action.kind === "action_item_defer") {
          const res = await fetch("/api/operator-actions", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: action.itemId, status: action.kind === "action_item_resolve" ? "resolved" : "deferred" }),
          });
          ok = res.ok;
          message = ok ? (action.kind === "action_item_resolve" ? "Resolved" : "Deferred") : "Failed";
        } else if (action.kind === "priority_done") {
          const res = await fetch("/api/maverick/priorities", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ complete: [action.priorityId] }),
          });
          ok = res.ok;
          message = ok ? "Done" : "Failed";
        }
        showToast(message, ok ? "success" : undefined);
        if (ok) removeItem(item);
      } catch {
        showToast("Failed");
      } finally {
        setBusy((prev) => {
          const next = new Set(prev);
          next.delete(item.key);
          return next;
        });
      }
    },
    [removeItem],
  );

  if (loading) {
    return (
      <section className="rounded-xl border border-[#30363d] bg-[#0d1117] px-4 py-8 text-center text-sm text-gray-500 animate-pulse">
        Ranking your decisions…
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-white tracking-wide">
          NEEDS YOU{" "}
          <span className="text-gray-500 font-normal">
            ({items.length}
            {briefLoading ? " · scanning replies…" : ""})
          </span>
          {hidden.machineWork + hidden.stale > 0 && (
            <span
              className="ml-2 text-[10px] text-gray-600 font-normal"
              title="Housekeeping proposals the machine handles itself (bump lane, d3 disposal) and stale items past the decision-age gates — hidden by the UX law: if it renders, it needs you."
            >
              {hidden.machineWork} machine-work · {hidden.stale} stale hidden
            </span>
          )}
        </h2>
        <button
          type="button"
          onClick={() => {
            loadFast();
            loadBrief();
          }}
          className="text-[11px] text-gray-500 hover:text-gray-300 transition-colors min-h-[44px] px-2"
        >
          refresh
        </button>
      </div>

      {items.length === 0 ? (
        <div className="rounded-xl border border-[#30363d] bg-[#0d1117] px-4 py-10 text-center">
          <div className="text-2xl mb-2">🟢</div>
          <p className="text-sm text-gray-400">Nothing needs you. The machine is working.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <ConveyorCard
              key={item.key}
              item={item}
              nowMs={nowMs}
              busy={busy.has(item.key)}
              onAction={(action, opts) => onAction(item, action, opts)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
