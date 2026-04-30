"use client";

import { DealCard as DealCardData } from "@/lib/actionQueue";
import { formatCurrency } from "@/lib/utils";
import { showToast } from "@/components/Toast";
import HoldButton from "./HoldButton";

interface Props {
  card: DealCardData;
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

export default function DealCard({ card, onActionComplete }: Props) {
  const handle = async (type: string, extra: Record<string, unknown> = {}) => {
    try {
      await postAction(type, {
        recordId: card.recordId,
        table: "deals",
        ...extra,
      });
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
          : "border-emerald-500/40 hover:border-emerald-500"
      }`}
    >
      <div className="flex justify-between items-start mb-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded text-xs font-bold bg-emerald-500/20 text-emerald-400">
              DEAL
            </span>
            {isHeld && card.holdUntil && (
              <span className="text-xs text-gray-500">held until {card.holdUntil}</span>
            )}
          </div>
          <h3 className="text-white font-semibold text-sm mt-1">{card.address}</h3>
          <p className="text-gray-500 text-xs">
            {card.closingStatus ?? card.status ?? "Status —"}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 mb-3 text-xs bg-[#161b22] rounded p-2">
        <div>
          <p className="text-gray-500">Contract</p>
          <p className="text-white font-medium">{formatCurrency(card.contractPrice)}</p>
        </div>
        <div>
          <p className="text-gray-500">Assignment</p>
          <p className="text-white font-medium">{formatCurrency(card.assignmentPrice)}</p>
        </div>
        <div>
          <p className="text-gray-500">Spread</p>
          <p className="text-emerald-400 font-medium">{formatCurrency(card.spread)}</p>
        </div>
      </div>

      <div className="flex gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => handle("send_buyer_blast")}
          className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold py-2.5 rounded min-h-[44px]"
        >
          Send Buyer Blast
        </button>
        <button
          type="button"
          onClick={() => handle("sign_contract")}
          className="flex-1 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold py-2.5 rounded min-h-[44px]"
        >
          Sign Contract
        </button>
        <button
          type="button"
          onClick={() => handle("walk_away")}
          className="flex-1 bg-red-900/40 hover:bg-red-900/60 border border-red-900/60 text-red-300 text-xs font-semibold py-2.5 rounded min-h-[44px]"
        >
          Walk Away
        </button>
        <HoldButton onHold={(until) => handle("hold", { until })} />
      </div>
    </div>
  );
}
