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
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (replyOpen && inputRef.current) inputRef.current.focus();
  }, [replyOpen]);

  const handle = async (type: string, extra: Record<string, unknown> = {}) => {
    try {
      await postAction(type, { recordId: card.recordId, ...extra });
      onActionComplete();
    } catch (err) {
      showToast(String(err));
    }
  };

  const handleSend = async () => {
    if (!replyText.trim() || !card.agentPhone || sending) return;
    setSending(true);
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
        showToast(data.error || "Send failed");
        return;
      }
      showToast("Sent via Quo", "success");
      setReplyOpen(false);
      setReplyText("");
      handle("clear");
    } catch {
      showToast("Send failed");
    } finally {
      setSending(false);
    }
  };

  const isHeld = card.cardState === "Held";

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

      {/* Inline reply input */}
      {replyOpen && (
        <div className="mb-3 space-y-2">
          <textarea
            ref={inputRef}
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            placeholder={`Reply to ${card.agentName?.split(" ")[0] ?? "agent"}...`}
            rows={3}
            className="w-full bg-[#0d1117] border border-emerald-500/50 rounded p-2.5 text-sm text-white focus:outline-none focus:border-emerald-400 resize-y placeholder-gray-600"
            disabled={sending}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSend();
              if (e.key === "Escape") { setReplyOpen(false); setReplyText(""); }
            }}
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleSend}
              disabled={sending || !replyText.trim()}
              className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold py-2 rounded min-h-[44px] disabled:opacity-50"
            >
              {sending ? "Sending..." : "Send via Quo"}
            </button>
            <button
              type="button"
              onClick={() => { setReplyOpen(false); setReplyText(""); }}
              className="bg-[#30363d] hover:bg-[#3d444d] text-gray-300 text-xs font-semibold px-4 py-2 rounded min-h-[44px]"
            >
              Cancel
            </button>
          </div>
          <p className="text-[10px] text-gray-600">Cmd+Enter to send · Esc to cancel</p>
        </div>
      )}

      <div className="flex gap-2 flex-wrap">
        {card.agentPhone && !replyOpen && (
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
