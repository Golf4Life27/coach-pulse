"use client";

// Phase 13 / N.3 — Sentinel approval queue.
//
// Lists pending inbounds where the agent owes a reply (per the
// /api/sentinel/queue feed). Lazy classify + draft per row: the LLM
// call doesn't fire until the operator clicks "Classify & draft".
// Each draft has Send / Edit / Dismiss actions; Send routes through
// the existing /api/deal-action/[id] path so SMS / email writes-back
// behave identically to the JarvisGreeting CardBlock send flow.
//
// Approval-gated per Phase 13 charter: NO LLM call without operator
// click, NO send without operator click. Classification + drafts are
// proposals; the operator approves or edits before anything fires.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { showToast } from "@/components/Toast";
import type {
  SentinelClassification,
  SentinelIntent,
} from "@/lib/sentinel/types";
import type {
  SentinelDraft,
  SentinelDraftPackage,
} from "@/lib/sentinel/drafter";

interface QueueItem {
  recordId: string;
  address: string;
  agent_name: string | null;
  state: string | null;
  list_price: number | null;
  outreach_status: string | null;
  last_inbound_at: string;
  hours_since_inbound: number | null;
  last_inbound_preview: string;
  has_motivation_score: boolean;
}

interface RowState {
  loading: boolean;
  error: string | null;
  pkg: SentinelDraftPackage | null;
  /** Operator's local edits per draft index. */
  edits: Record<number, string>;
  sendingIdx: number | null;
  dismissed: boolean;
}

const initialRowState: RowState = {
  loading: false,
  error: null,
  pkg: null,
  edits: {},
  sendingIdx: null,
  dismissed: false,
};

const INTENT_STYLE: Record<SentinelIntent, { label: string; bg: string; fg: string }> = {
  motivated: { label: "Motivated", bg: "bg-emerald-500/15", fg: "text-emerald-300" },
  lukewarm: { label: "Lukewarm", bg: "bg-amber-500/15", fg: "text-amber-300" },
  rejection: { label: "Rejection", bg: "bg-gray-500/15", fg: "text-gray-300" },
  question: { label: "Question", bg: "bg-blue-500/15", fg: "text-blue-300" },
  wire_fraud_red_flag: { label: "Wire-fraud flag", bg: "bg-red-500/20", fg: "text-red-300" },
  off_topic: { label: "Off-topic", bg: "bg-gray-500/10", fg: "text-gray-400" },
  spam: { label: "Spam", bg: "bg-gray-500/10", fg: "text-gray-400" },
};

function formatCurrency(n: number | null): string {
  if (n == null) return "—";
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

function formatHours(h: number | null): string {
  if (h == null) return "—";
  if (h < 1) return "<1h";
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function ClassificationChips({ c }: { c: SentinelClassification }) {
  const style = INTENT_STYLE[c.intent];
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span
        className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${style.bg} ${style.fg}`}
      >
        {style.label}
      </span>
      <span className="text-[10px] text-gray-500">
        conf {Math.round(c.confidence * 100)}%
      </span>
      {c.motivation_score_hint != null && (
        <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-300">
          motivation {c.motivation_score_hint}/5
        </span>
      )}
      {c.red_flags.map((f) => (
        <span
          key={f}
          className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-red-500/15 text-red-300"
        >
          ⚠ {f.replace(/_/g, " ")}
        </span>
      ))}
    </div>
  );
}

function DraftBlock({
  recordId,
  draft,
  idx,
  draftBody,
  onBodyChange,
  onSend,
  sending,
  recommended,
}: {
  recordId: string;
  draft: SentinelDraft;
  idx: number;
  draftBody: string;
  onBodyChange: (v: string) => void;
  onSend: () => void;
  sending: boolean;
  recommended: boolean;
}) {
  void recordId; // reserved for future per-draft analytics
  const sendable = draft.channel === "sms" || draft.channel === "email";
  return (
    <div
      className={`rounded border ${recommended ? "border-emerald-700/60 bg-emerald-950/10" : "border-[#30363d] bg-[#0d1117]"} p-2.5 space-y-1.5`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold text-gray-200">
            {draft.label}
          </span>
          {recommended && (
            <span className="text-[9px] uppercase tracking-wider px-1 py-0.5 rounded bg-emerald-500/20 text-emerald-300">
              ★ recommended
            </span>
          )}
          <span className="text-[10px] text-gray-500">via {draft.channel}</span>
        </div>
        {sendable && (
          <button
            type="button"
            onClick={onSend}
            disabled={sending || draftBody.trim().length === 0}
            className="text-[11px] bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white px-2.5 py-1 rounded"
          >
            {sending
              ? "Sending…"
              : draft.channel === "sms"
                ? "Send via Quo"
                : "Create email draft"}
          </button>
        )}
      </div>
      {draft.channel === "email" && draft.subject && (
        <div className="text-[10px] text-gray-500">
          Subject: <span className="text-gray-300">{draft.subject}</span>
        </div>
      )}
      {sendable ? (
        <textarea
          value={draftBody}
          onChange={(e) => onBodyChange(e.target.value)}
          rows={3}
          className="w-full bg-[#161b22] border border-[#30363d] rounded p-2 text-[11px] text-white focus:outline-none focus:border-emerald-500 resize-y"
        />
      ) : (
        <div className="text-[11px] text-gray-500 italic">
          Alert only — no draft generated. Review the classification before
          deciding.
        </div>
      )}
    </div>
  );
}

function QueueRow({
  item,
  rowState,
  setRowState,
  onClassifyDraft,
  onSend,
  onDismiss,
}: {
  item: QueueItem;
  rowState: RowState;
  setRowState: (next: RowState) => void;
  onClassifyDraft: () => void;
  onSend: (draftIdx: number, body: string) => void;
  onDismiss: () => void;
}) {
  if (rowState.dismissed) return null;

  const pkg = rowState.pkg;
  const drafts = pkg?.drafts ?? [];

  return (
    <div className="bg-[#161b22] rounded-lg border border-[#30363d] p-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1 min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Link
              href={`/pipeline/${item.recordId}`}
              className="text-sm font-semibold text-blue-400 hover:underline truncate"
            >
              {item.address}
            </Link>
            {item.state && (
              <span className="text-[10px] text-gray-500">{item.state}</span>
            )}
            <span className="text-[10px] text-gray-500">
              {formatHours(item.hours_since_inbound)} ago
            </span>
            {item.outreach_status && (
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-[#0d1117] border border-[#30363d] text-gray-400">
                {item.outreach_status}
              </span>
            )}
            {item.has_motivation_score && (
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-300">
                scored
              </span>
            )}
          </div>
          <div className="text-[11px] text-gray-500">
            {item.agent_name ?? "—"} · list {formatCurrency(item.list_price)}
          </div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="text-[10px] text-gray-500 hover:text-gray-300"
          title="Hide from queue (local — reappears on refresh)"
        >
          Dismiss
        </button>
      </div>

      <blockquote className="bg-[#0d1117] border-l-2 border-[#30363d] px-2 py-1.5 text-[11px] text-gray-300 italic">
        {item.last_inbound_preview || "(empty inbound)"}
      </blockquote>

      {!pkg && (
        <button
          type="button"
          onClick={onClassifyDraft}
          disabled={rowState.loading}
          className="text-[11px] bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white px-3 py-1.5 rounded"
        >
          {rowState.loading ? "Sentinel thinking…" : "Classify & draft"}
        </button>
      )}

      {rowState.error && (
        <div className="bg-red-500/10 border border-red-500/40 rounded px-2 py-1.5 text-[11px] text-red-300">
          {rowState.error}
        </div>
      )}

      {pkg && (
        <div className="space-y-2 pt-1">
          <ClassificationChips c={pkg.classification} />
          {pkg.classification.reasoning && (
            <p className="text-[11px] text-gray-400 italic">
              {pkg.classification.reasoning}
            </p>
          )}
          {drafts.length === 0 && (
            <div className="text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1.5">
              Sentinel flagged this as <strong>{pkg.classification.intent}</strong>
              — no auto-draft generated. Open the workspace to handle manually.
            </div>
          )}
          {drafts.map((d, i) => {
            const body = rowState.edits[i] ?? d.body;
            return (
              <DraftBlock
                key={`${d.option}-${i}`}
                recordId={item.recordId}
                draft={d}
                idx={i}
                draftBody={body}
                onBodyChange={(v) =>
                  setRowState({
                    ...rowState,
                    edits: { ...rowState.edits, [i]: v },
                  })
                }
                onSend={() => onSend(i, body)}
                sending={rowState.sendingIdx === i}
                recommended={i === pkg.recommended_index}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function SentinelApprovalQueue() {
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [rowStates, setRowStates] = useState<Record<string, RowState>>({});

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch("/api/sentinel/queue", { cache: "no-store" })
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

  const setRow = useCallback((recordId: string, next: RowState) => {
    setRowStates((prev) => ({ ...prev, [recordId]: next }));
  }, []);

  const getRow = useCallback(
    (recordId: string): RowState => rowStates[recordId] ?? initialRowState,
    [rowStates],
  );

  const handleClassifyDraft = useCallback(
    async (recordId: string) => {
      const current = getRow(recordId);
      setRow(recordId, { ...current, loading: true, error: null });
      try {
        const res = await fetch(`/api/sentinel/draft/${recordId}`, {
          cache: "no-store",
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.detail ?? data.error ?? `HTTP ${res.status}`);
        }
        setRow(recordId, {
          ...current,
          loading: false,
          error: null,
          pkg: data.draft_package as SentinelDraftPackage,
        });
      } catch (err) {
        setRow(recordId, {
          ...current,
          loading: false,
          error: String(err).slice(0, 300),
        });
      }
    },
    [getRow, setRow],
  );

  const handleSend = useCallback(
    async (recordId: string, draftIdx: number, body: string) => {
      const current = getRow(recordId);
      if (!current.pkg) return;
      const draft = current.pkg.drafts[draftIdx];
      if (!draft) return;
      setRow(recordId, { ...current, sendingIdx: draftIdx });
      try {
        const res = await fetch(`/api/deal-action/${recordId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            channel: draft.channel,
            body,
            subject: draft.subject,
            action_type: "send_reply",
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          showToast(data.error ?? data.detail ?? "Send failed");
          setRow(recordId, { ...current, sendingIdx: null });
          return;
        }
        showToast("Sent", "success");
        setRow(recordId, { ...current, sendingIdx: null, dismissed: true });
      } catch (err) {
        showToast(`Send failed: ${String(err)}`);
        setRow(recordId, { ...current, sendingIdx: null });
      }
    },
    [getRow, setRow],
  );

  const handleDismiss = useCallback(
    (recordId: string) => {
      const current = getRow(recordId);
      setRow(recordId, { ...current, dismissed: true });
    },
    [getRow, setRow],
  );

  const visibleItems = useMemo(
    () => (items ?? []).filter((it) => !(rowStates[it.recordId]?.dismissed)),
    [items, rowStates],
  );

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-bold text-white">
            Sentinel · Inbound approval queue
          </h1>
          <p className="text-[11px] text-gray-500">
            Pending inbounds where we owe a reply. Click <em>Classify &amp;
            draft</em> to fire Sentinel on a row; nothing sends without your
            approval.
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

      {!loading && items && visibleItems.length === 0 && !error && (
        <div className="bg-[#161b22] rounded-lg border border-[#30363d] p-6 text-center text-sm text-gray-500">
          Queue empty. No inbounds awaiting reply.
        </div>
      )}

      <div className="space-y-2.5">
        {visibleItems.map((it) => (
          <QueueRow
            key={it.recordId}
            item={it}
            rowState={getRow(it.recordId)}
            setRowState={(next) => setRow(it.recordId, next)}
            onClassifyDraft={() => handleClassifyDraft(it.recordId)}
            onSend={(idx, body) => handleSend(it.recordId, idx, body)}
            onDismiss={() => handleDismiss(it.recordId)}
          />
        ))}
      </div>
    </section>
  );
}
