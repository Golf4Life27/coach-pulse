"use client";

import { StaleCard as StaleCardData } from "@/lib/actionQueue";
import { formatCurrency, buildSMSLink } from "@/lib/utils";
import { showToast } from "@/components/Toast";
import HoldButton from "./HoldButton";

interface Props {
  card: StaleCardData;
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

export default function StaleCard({ card, onActionComplete }: Props) {
  const handle = async (type: string, extra: Record<string, unknown> = {}) => {
    try {
      await postAction(type, { recordId: card.recordId, ...extra });
      onActionComplete();
    } catch (err) {
      showToast(String(err));
    }
  };

  const isHeld = card.cardState === "Held";
  const followUpHref = card.agentPhone
    ? buildSMSLink(card.agentPhone, card.agentName, card.address, null, card.mao)
    : "#";

  return (
    <div
      className={`bg-[#1c2128] rounded-lg border p-4 transition-colors ${
        isHeld
          ? "border-[#30363d] opacity-60"
          : "border-gray-500/40 hover:border-gray-400"
      }`}
    >
      <div className="flex justify-between items-start mb-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded text-xs font-bold bg-gray-500/20 text-gray-300">
              STALE
            </span>
            {isHeld && card.holdUntil && (
              <span className="text-xs text-gray-500">held until {card.holdUntil}</span>
            )}
          </div>
          <h3 className="text-white font-semibold text-sm mt-1">{card.address}</h3>
          <p className="text-gray-500 text-xs">
            {card.agentName ?? "—"} · {card.daysSilent} days silent
            {card.lastOutreachDate ? ` · last ${card.lastOutreachDate.slice(0, 10)}` : ""}
          </p>
        </div>
        <div className="text-right text-xs">
          <p className="text-gray-500">Offer (MAO)</p>
          <p className="text-emerald-400 font-medium">{formatCurrency(card.mao)}</p>
        </div>
      </div>

      <div className="flex gap-2 flex-wrap">
        {card.agentPhone ? (
          <a
            href={followUpHref}
            onClick={() => handle("clear")}
            className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold text-center py-2.5 rounded min-h-[44px] flex items-center justify-center"
          >
            Send Follow-up
          </a>
        ) : (
          <button
            type="button"
            onClick={() => showToast("No agent phone on record")}
            className="flex-1 bg-[#30363d] text-gray-500 text-xs font-semibold py-2.5 rounded min-h-[44px]"
            disabled
          >
            Send Follow-up
          </button>
        )}
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
