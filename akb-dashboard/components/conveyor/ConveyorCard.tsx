"use client";

// One decision card on the conveyor (silver-platter cockpit).
//
// Contract: revenue $ (sourced or "—"), deadline/waiting clock, ONE sentence
// of reasoning, and 1–2 thumb-sized taps (approve / edit-then-send / snooze /
// kill). Typed 2A / 2B / 2C. If it renders, it is live and needs the operator.

import { useState } from "react";
import Link from "next/link";
import type { ConveyorAction, ConveyorItem } from "@/lib/conveyor/model";
import { TYPE_LABEL } from "@/lib/conveyor/model";

const TYPE_STYLE: Record<ConveyorItem["type"], { chip: string; ring: string }> = {
  "2A": { chip: "bg-emerald-950/60 text-emerald-300 border-emerald-500/40", ring: "border-l-emerald-500/70" },
  "2B": { chip: "bg-amber-950/60 text-amber-300 border-amber-500/40", ring: "border-l-amber-500/70" },
  "2C": { chip: "bg-violet-950/60 text-violet-300 border-violet-500/40", ring: "border-l-violet-500/70" },
};

function money(n: number | null): string {
  return n == null ? "$—" : `$${Math.round(n).toLocaleString("en-US")}`;
}

function clockLabel(item: ConveyorItem, nowMs: number): { text: string; tone: "overdue" | "soon" | "calm" } {
  if (item.deadlineAt) {
    const t = Date.parse(item.deadlineAt);
    if (Number.isFinite(t)) {
      const h = (t - nowMs) / 3_600_000;
      if (item.deadlineImplied) {
        // Implied same-day clock renders as honest waiting time, never a
        // fake countdown.
        const posted = item.postedAt ? Date.parse(item.postedAt) : NaN;
        const waitedH = Number.isFinite(posted) ? Math.max(0, Math.round((nowMs - posted) / 3_600_000)) : null;
        if (h <= 0) return { text: waitedH != null ? `waiting ${waitedH}h — overdue` : "overdue", tone: "overdue" };
        return { text: waitedH != null ? `waiting ${waitedH}h` : "due today", tone: h <= 6 ? "soon" : "calm" };
      }
      if (h <= 0) return { text: "OVERDUE", tone: "overdue" };
      if (h <= 24) return { text: `due in ${Math.max(1, Math.round(h))}h`, tone: "soon" };
      return { text: `due ${new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`, tone: "calm" };
    }
  }
  if (item.postedAt) {
    const p = Date.parse(item.postedAt);
    if (Number.isFinite(p)) {
      const h = Math.round((nowMs - p) / 3_600_000);
      return { text: h < 24 ? `waiting ${Math.max(0, h)}h` : `waiting ${Math.round(h / 24)}d`, tone: "calm" };
    }
  }
  return { text: "", tone: "calm" };
}

const CLOCK_TONE: Record<"overdue" | "soon" | "calm", string> = {
  overdue: "bg-red-950/60 text-red-300 border border-red-500/50",
  soon: "bg-amber-950/50 text-amber-300 border border-amber-500/40",
  calm: "bg-[#161b22] text-gray-400 border border-[#30363d]",
};

export interface ConveyorCardProps {
  item: ConveyorItem;
  nowMs: number;
  busy: boolean;
  onAction: (action: ConveyorAction, opts?: { editedBody?: string }) => void;
}

export default function ConveyorCard({ item, nowMs, busy, onAction }: ConveyorCardProps) {
  const style = TYPE_STYLE[item.type];
  const clock = clockLabel(item, nowMs);
  const send = item.actions.find((a) => a.kind === "proposal_send");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(send && send.kind === "proposal_send" ? send.draftBody : "");

  const primary = item.actions[0];
  const snooze = item.actions.find((a) => a.kind === "proposal_snooze" || a.kind === "action_item_defer");
  const kill = item.actions.find((a) => a.kind === "proposal_reject");
  const done = item.actions.find((a) => a.kind === "priority_done" || a.kind === "action_item_resolve");

  return (
    <div className={`bg-[#1c2128] border border-[#30363d] border-l-4 ${style.ring} rounded-xl p-4`}>
      {/* Row 1 — type · $ · clock */}
      <div className="flex items-center flex-wrap gap-2">
        <span className={`text-[10px] font-bold tracking-wider px-2 py-0.5 rounded-full border ${style.chip}`}>
          {item.type} · {TYPE_LABEL[item.type]}
        </span>
        <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${item.dollars != null ? "bg-emerald-950/50 text-emerald-300 border border-emerald-500/30" : "bg-[#161b22] text-gray-500 border border-[#30363d]"}`}>
          {money(item.dollars)}
        </span>
        {clock.text && (
          <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${CLOCK_TONE[clock.tone]}`}>
            {clock.text}
          </span>
        )}
      </div>

      {/* Row 2 — title (deep link when a deal room exists) */}
      <div className="mt-2">
        {item.href ? (
          <Link href={item.href} className="text-white font-semibold text-[15px] leading-snug hover:text-emerald-300 transition-colors">
            {item.title}
          </Link>
        ) : (
          <span className="text-white font-semibold text-[15px] leading-snug">{item.title}</span>
        )}
      </div>

      {/* Verbatim inbound quote when the decision is about a reply */}
      {item.verbatim && (
        <blockquote className="mt-2 text-[12px] text-gray-300 bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 leading-relaxed">
          “{item.verbatim}”
        </blockquote>
      )}

      {/* One sentence, no more */}
      {item.reasoning && <p className="mt-2 text-xs text-gray-400 leading-relaxed">{item.reasoning}</p>}

      {/* Edit-then-send (2A dispatch cards only) */}
      {send && send.kind === "proposal_send" && editing && (
        <div className="mt-3">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={4}
            maxLength={640}
            className="w-full text-sm bg-[#0d1117] border border-[#30363d] rounded-lg p-3 text-gray-200 leading-relaxed focus:outline-none focus:border-emerald-500"
          />
          <div className="text-right text-[10px] text-gray-600">{draft.length}/640 · to {send.to}</div>
        </div>
      )}

      {/* Taps — thumb-sized */}
      <div className="mt-3 flex items-center gap-2">
        {send && send.kind === "proposal_send" ? (
          <>
            <button
              type="button"
              disabled={busy || (editing && !draft.trim())}
              onClick={() => onAction(send, { editedBody: editing ? draft : undefined })}
              className="flex-1 min-h-[48px] bg-emerald-700 hover:bg-emerald-600 active:bg-emerald-800 text-white text-sm font-semibold rounded-xl transition-colors disabled:opacity-50"
            >
              {busy ? "Sending…" : "Approve & Send"}
            </button>
            <button
              type="button"
              onClick={() => setEditing((v) => !v)}
              className={`min-h-[48px] px-4 text-sm font-semibold rounded-xl border transition-colors ${editing ? "bg-[#30363d] text-white border-[#3d444d]" : "bg-[#161b22] text-gray-300 border-[#30363d] hover:bg-[#30363d]"}`}
            >
              {editing ? "Keep draft" : "Edit"}
            </button>
          </>
        ) : primary && primary.kind === "open" ? (
          <Link
            href={primary.href}
            className="flex-1 min-h-[48px] bg-[#238636] hover:bg-[#2ea043] text-white text-sm font-semibold rounded-xl transition-colors inline-flex items-center justify-center"
          >
            {primary.label ?? "Open"} →
          </Link>
        ) : primary ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => onAction(primary)}
            className="flex-1 min-h-[48px] bg-emerald-700 hover:bg-emerald-600 active:bg-emerald-800 text-white text-sm font-semibold rounded-xl transition-colors disabled:opacity-50"
          >
            {busy
              ? "Working…"
              : primary.kind === "proposal_approve"
                ? (primary.label ?? "Approve")
                : primary.kind === "action_item_resolve"
                  ? "Resolve"
                  : "Done"}
          </button>
        ) : null}

        {done && primary !== done && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onAction(done)}
            className="min-h-[48px] px-4 bg-[#161b22] hover:bg-[#30363d] text-gray-300 text-sm font-semibold rounded-xl border border-[#30363d] transition-colors disabled:opacity-50"
          >
            Done
          </button>
        )}
        {snooze && (
          <button
            type="button"
            disabled={busy}
            title="Snooze until tomorrow 9am"
            onClick={() => onAction(snooze)}
            className="min-h-[48px] min-w-[48px] bg-[#161b22] hover:bg-[#30363d] text-gray-400 rounded-xl border border-[#30363d] transition-colors disabled:opacity-50"
          >
            ⏰
          </button>
        )}
        {kill && (
          <button
            type="button"
            disabled={busy}
            title="Kill (reject)"
            onClick={() => onAction(kill)}
            className="min-h-[48px] min-w-[48px] bg-[#161b22] hover:bg-red-950/60 text-gray-500 hover:text-red-300 rounded-xl border border-[#30363d] hover:border-red-500/40 transition-colors disabled:opacity-50"
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}
