"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { ResponseCard as ResponseCardData } from "@/lib/actionQueue";
import { formatCurrency } from "@/lib/utils";
import { showToast } from "@/components/Toast";
import { setHoveredCard, openCommandBar } from "@/lib/commandBus";
import HoldButton from "./HoldButton";

interface Props {
  card: ResponseCardData;
  onActionComplete: () => void;
}

// Send state machine per Positive Confirmation Principle §UI Pattern.
// idle → sending → confirming → confirmed | failed | uncertain
// confirmed auto-clears after 2s; failed/uncertain persist until dismiss.
type SendState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "confirming"; quoMessageId: string; attempts: number }
  | { kind: "confirmed"; quoMessageId: string }
  | { kind: "failed"; message: string; quoMessageId?: string }
  | { kind: "uncertain"; quoMessageId: string };

const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 10; // 20s total → falls to "uncertain"
const CONFIRMED_AUTO_CLEAR_MS = 2000;

async function postAction(type: string, body: Record<string, unknown>) {
  const res = await fetch(`/api/actions/${type}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
}

function cleanPhone(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

export default function ResponseCard({ card, onActionComplete }: Props) {
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [sendState, setSendState] = useState<SendState>({ kind: "idle" });
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (replyOpen && inputRef.current) inputRef.current.focus();
  }, [replyOpen]);

  // Cleanup any pending timers on unmount.
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    };
  }, []);

  const handle = async (type: string, extra: Record<string, unknown> = {}) => {
    try {
      await postAction(type, { recordId: card.recordId, ...extra });
      onActionComplete();
    } catch (err) {
      showToast(String(err));
    }
  };

  // Poll Quo status until terminal or attempts exhausted. Each tick
  // schedules the next via setTimeout (avoids overlapping requests).
  const pollStatus = (quoMessageId: string, attempt: number) => {
    pollTimerRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/quo-message-status/${quoMessageId}`);
        if (!res.ok) {
          // Network/auth failure during polling — keep card visible,
          // surface as uncertain so Alex can verify in Quo.
          setSendState({ kind: "uncertain", quoMessageId });
          return;
        }
        const data: {
          status: string;
          isTerminal: boolean;
          isSuccess: boolean;
        } = await res.json();

        if (data.isTerminal && data.isSuccess) {
          setSendState({ kind: "confirmed", quoMessageId });
          clearTimerRef.current = setTimeout(() => {
            setReplyOpen(false);
            setReplyText("");
            handle("clear");
          }, CONFIRMED_AUTO_CLEAR_MS);
          return;
        }
        if (data.isTerminal && !data.isSuccess) {
          setSendState({
            kind: "failed",
            message: `Quo reports status: ${data.status}. Message did not deliver.`,
            quoMessageId,
          });
          return;
        }
        // Still queued/sending — keep polling unless exhausted.
        if (attempt + 1 >= POLL_MAX_ATTEMPTS) {
          setSendState({ kind: "uncertain", quoMessageId });
          return;
        }
        setSendState({
          kind: "confirming",
          quoMessageId,
          attempts: attempt + 1,
        });
        pollStatus(quoMessageId, attempt + 1);
      } catch {
        setSendState({ kind: "uncertain", quoMessageId });
      }
    }, POLL_INTERVAL_MS);
  };

  const handleSend = async () => {
    if (!replyText.trim() || !card.agentPhone || sendState.kind === "sending") {
      return;
    }
    setSendState({ kind: "sending" });
    try {
      const res = await fetch("/api/jarvis-send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proposalId: `manual-reply-${Date.now()}`,
          to: cleanPhone(card.agentPhone),
          message: replyText.trim(),
          recordId: card.recordId,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setSendState({
          kind: "failed",
          message: data.error || data.detail || `Send failed (HTTP ${res.status})`,
        });
        return;
      }
      const data: {
        quoMessageId: string | null;
        quoStatus: string;
        accepted: boolean;
        isTerminal: boolean;
        isSuccess: boolean;
      } = await res.json();

      if (data.isTerminal && data.isSuccess && data.quoMessageId) {
        setSendState({ kind: "confirmed", quoMessageId: data.quoMessageId });
        clearTimerRef.current = setTimeout(() => {
          setReplyOpen(false);
          setReplyText("");
          handle("clear");
        }, CONFIRMED_AUTO_CLEAR_MS);
        return;
      }
      if (!data.quoMessageId) {
        // 2xx but no message id — Quo accepted nothing identifiable. Treat
        // as uncertain. Card persists; Alex must verify in Quo.
        setSendState({ kind: "uncertain", quoMessageId: "(no id returned)" });
        return;
      }
      setSendState({
        kind: "confirming",
        quoMessageId: data.quoMessageId,
        attempts: 0,
      });
      pollStatus(data.quoMessageId, 0);
    } catch (err) {
      setSendState({
        kind: "failed",
        message: `Network error: ${String(err)}`,
      });
    }
  };

  const handleDismissSendState = () => {
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    setSendState({ kind: "idle" });
    setReplyText("");
    setReplyOpen(false);
  };

  const isHeld = card.cardState === "Held";
  const isSending = sendState.kind === "sending";
  const isConfirming = sendState.kind === "confirming";
  const showBanner =
    sendState.kind === "confirmed" ||
    sendState.kind === "failed" ||
    sendState.kind === "uncertain";

  return (
    <div
      onMouseEnter={() => setHoveredCard(card.recordId)}
      onMouseLeave={() => setHoveredCard(null)}
      className={`bg-[#1c2128] rounded-lg border p-4 transition-colors ${
        isHeld
          ? "border-[#30363d] opacity-60"
          : "border-orange-500/40 hover:border-orange-500"
      }`}
    >
      <div className="flex justify-between items-start mb-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded text-xs font-bold bg-orange-500/20 text-orange-400">
              RESPONSE
            </span>
            {isHeld && card.holdUntil && (
              <span className="text-xs text-gray-500">held until {card.holdUntil}</span>
            )}
          </div>
          <Link
            href={`/pipeline/${card.recordId}`}
            className="block text-white font-semibold text-sm mt-1 hover:underline"
          >
            {card.address}{card.city || card.state ? `, ${[card.city, card.state].filter(Boolean).join(", ")}` : ""}
          </Link>
          <p className="text-gray-500 text-xs">
            {card.agentName ?? "—"}
            {card.dom != null ? ` · DOM ${card.dom}` : ""}
          </p>
        </div>
        <div className="text-right text-xs">
          <p className="text-gray-500">List</p>
          <p className="text-white font-medium">{formatCurrency(card.listPrice)}</p>
          <p className="text-gray-500 mt-1">Offer (MAO)</p>
          <p className="text-emerald-400 font-medium">{formatCurrency(card.mao)}</p>
        </div>
      </div>

      {card.outboundMessage && (
        <div className="mb-2">
          <p className="text-xs text-gray-500 mb-1">You said:</p>
          <p className="text-xs text-gray-300 bg-[#161b22] rounded p-2 line-clamp-3">
            {card.outboundMessage}
          </p>
        </div>
      )}

      {card.inboundMessage && (
        <div className="mb-3">
          <p className="text-xs text-gray-500 mb-1">They replied:</p>
          <p className="text-sm text-white bg-orange-500/10 border border-orange-500/30 rounded p-2 line-clamp-4">
            {card.inboundMessage}
          </p>
        </div>
      )}

      {/* Send-state banner — persistent for failed/uncertain, brief for confirmed */}
      {showBanner && (
        <div
          className={`mb-3 rounded p-2.5 border text-xs flex items-start gap-2 ${
            sendState.kind === "confirmed"
              ? "bg-emerald-900/30 border-emerald-500/40 text-emerald-200"
              : sendState.kind === "failed"
                ? "bg-red-900/30 border-red-500/50 text-red-200"
                : "bg-amber-900/30 border-amber-500/50 text-amber-200"
          }`}
        >
          <div className="flex-1">
            {sendState.kind === "confirmed" && (
              <>
                <p className="font-semibold">Delivered via Quo</p>
                <p className="opacity-70 mt-0.5 break-all">id: {sendState.quoMessageId}</p>
              </>
            )}
            {sendState.kind === "failed" && (
              <>
                <p className="font-semibold">Send failed — not delivered</p>
                <p className="opacity-90 mt-0.5">{sendState.message}</p>
                {sendState.quoMessageId && (
                  <p className="opacity-70 mt-0.5 break-all">id: {sendState.quoMessageId}</p>
                )}
                <p className="opacity-70 mt-1">Listing state unchanged. Try again or send from Quo directly.</p>
              </>
            )}
            {sendState.kind === "uncertain" && (
              <>
                <p className="font-semibold">Delivery uncertain</p>
                <p className="opacity-90 mt-0.5">
                  Quo accepted the message but hasn&apos;t confirmed delivery. <strong>Verify in Quo before assuming sent.</strong>
                </p>
                <p className="opacity-70 mt-0.5 break-all">id: {sendState.quoMessageId}</p>
              </>
            )}
          </div>
          {sendState.kind !== "confirmed" && (
            <button
              type="button"
              onClick={handleDismissSendState}
              className="text-xs underline opacity-80 hover:opacity-100 shrink-0"
            >
              Dismiss
            </button>
          )}
        </div>
      )}

      {/* Inline reply input */}
      {replyOpen && sendState.kind !== "confirmed" && (
        <div className="mb-3 space-y-2">
          <textarea
            ref={inputRef}
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            placeholder={`Reply to ${card.agentName?.split(" ")[0] ?? "agent"}...`}
            rows={3}
            className="w-full bg-[#0d1117] border border-emerald-500/50 rounded p-2.5 text-sm text-white focus:outline-none focus:border-emerald-400 resize-y placeholder-gray-600"
            disabled={isSending || isConfirming}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSend();
              if (e.key === "Escape") { setReplyOpen(false); setReplyText(""); }
            }}
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleSend}
              disabled={isSending || isConfirming || !replyText.trim()}
              className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold py-2 rounded min-h-[44px] disabled:opacity-50"
            >
              {isSending
                ? "Sending..."
                : isConfirming
                  ? `Confirming delivery... (${sendState.attempts + 1}/${POLL_MAX_ATTEMPTS})`
                  : "Send via Quo"}
            </button>
            <button
              type="button"
              onClick={() => { setReplyOpen(false); setReplyText(""); }}
              disabled={isSending || isConfirming}
              className="bg-[#30363d] hover:bg-[#3d444d] text-gray-300 text-xs font-semibold px-4 py-2 rounded min-h-[44px] disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
          <p className="text-[10px] text-gray-600">Cmd+Enter to send · Esc to cancel</p>
        </div>
      )}

      <div className="flex gap-2 flex-wrap">
        {card.agentPhone && !replyOpen && sendState.kind === "idle" && (
          <button
            type="button"
            onClick={() => setReplyOpen(true)}
            className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold text-center py-2.5 rounded min-h-[44px]"
          >
            Reply
          </button>
        )}
        <button
          type="button"
          onClick={() =>
            openCommandBar({
              contextRecordId: card.recordId,
              prefill:
                "Draft a counter offer reply to this agent. Apply the 65% rule and entity-flexibility language.",
            })
          }
          className="flex-1 bg-[#30363d] hover:bg-[#3d444d] text-gray-200 text-xs font-semibold py-2.5 rounded min-h-[44px]"
        >
          Counter
        </button>
        <button
          type="button"
          onClick={() => handle("mark_dead")}
          className="flex-1 bg-red-900/40 hover:bg-red-900/60 border border-red-900/60 text-red-300 text-xs font-semibold py-2.5 rounded min-h-[44px]"
        >
          Mark Dead
        </button>
        <HoldButton onHold={(until) => handle("hold", { until })} />
      </div>
    </div>
  );
}
