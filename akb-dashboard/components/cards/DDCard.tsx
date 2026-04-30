"use client";

import Link from "next/link";
import { DDCard as DDCardData } from "@/lib/actionQueue";
import { showToast } from "@/components/Toast";
import HoldButton from "./HoldButton";

interface Props {
  card: DDCardData;
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

function buildDDQuestionsSMS(
  phone: string,
  agentName: string | null,
  address: string,
  missingItems: string[],
): string {
  const firstName = agentName ? agentName.split(" ")[0] : "there";
  const cleaned = phone.replace(/[^+\d]/g, "");
  const questionMap: Record<string, string> = {
    "Bed/Bath Verified": "Confirming the property is X bed / X bath?",
    "Vacancy Status Known": "Is the property currently vacant or occupied?",
    "Roof Age Asked": "Approx age of the roof?",
    "HVAC Age Asked": "Approx age of the HVAC system?",
    "Water Heater Age Asked": "Approx age of the water heater?",
    "Showing Access Confirmed": "Can you grant lockbox / showing access?",
  };
  const questions = missingItems
    .map((item, i) => `${i + 1}) ${questionMap[item] ?? item}`)
    .join("\n");
  const body = `Hi ${firstName}, quick due-diligence questions on ${address} before we lock pricing:\n${questions}\nThanks!`;
  return `sms:${cleaned}?body=${encodeURIComponent(body)}`;
}

export default function DDCard({ card, onActionComplete }: Props) {
  const handle = async (type: string, extra: Record<string, unknown> = {}) => {
    try {
      await postAction(type, { recordId: card.recordId, ...extra });
      onActionComplete();
    } catch (err) {
      showToast(String(err));
    }
  };

  const isHeld = card.cardState === "Held";
  const ddHref = card.agentPhone
    ? buildDDQuestionsSMS(
        card.agentPhone,
        card.agentName,
        card.address,
        card.missingItems,
      )
    : "#";

  return (
    <div
      className={`bg-[#1c2128] rounded-lg border p-4 transition-colors ${
        isHeld
          ? "border-[#30363d] opacity-60"
          : "border-blue-500/40 hover:border-blue-500"
      }`}
    >
      <div className="flex justify-between items-start mb-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded text-xs font-bold bg-blue-500/20 text-blue-400">
              DD
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
          <p className="text-gray-500 text-xs">{card.agentName ?? "—"}</p>
        </div>
      </div>

      <div className="mb-3">
        <p className="text-xs text-gray-500 mb-1">Missing items ({card.missingItems.length}):</p>
        <ul className="text-xs text-gray-300 space-y-0.5">
          {card.missingItems.map((item) => (
            <li key={item}>· {item}</li>
          ))}
        </ul>
      </div>

      <div className="flex gap-2 flex-wrap">
        {card.agentPhone ? (
          <a
            href={ddHref}
            className="flex-1 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold text-center py-2.5 rounded min-h-[44px] flex items-center justify-center"
          >
            Send DD Questions
          </a>
        ) : (
          <button
            type="button"
            onClick={() => showToast("No agent phone on record")}
            className="flex-1 bg-[#30363d] text-gray-500 text-xs font-semibold py-2.5 rounded min-h-[44px]"
            disabled
          >
            Send DD Questions
          </button>
        )}
        <button
          type="button"
          onClick={() => handle("mark_dd_complete")}
          className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold py-2.5 rounded min-h-[44px]"
        >
          Mark Complete
        </button>
        <HoldButton onHold={(until) => handle("hold", { until })} />
      </div>
    </div>
  );
}
