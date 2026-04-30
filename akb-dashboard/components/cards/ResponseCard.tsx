"use client";

import Link from "next/link";
import { ResponseCard as ResponseCardData } from "@/lib/actionQueue";
import { formatCurrency, buildQuickSMSLink } from "@/lib/utils";
import { showToast } from "@/components/Toast";
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

export default function ResponseCard({ card, onActionComplete }: Props) {
  const handle = async (type: string, extra: Record<string, unknown> = {}) => {
    try {
      await postAction(type, { recordId: card.recordId, ...extra });
      onActionComplete();
    } catch (err) {
      showToast(String(err));
    }
  };

  const isHeld = card.cardState === "Held";

  return (
    <div
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
            {card.address}
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

      <div className="flex gap-2 flex-wrap">
        {card.agentPhone && (
          <a
            href={buildQuickSMSLink(card.agentPhone)}
            onClick={() => handle("clear")}
            className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold text-center py-2.5 rounded min-h-[44px] flex items-center justify-center"
          >
            Reply
          </a>
        )}
        <button
          type="button"
          onClick={() =>
            showToast(
              "Counter composer ships in Step 6 — use Cmd+K with this card focused once it's wired.",
            )
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
