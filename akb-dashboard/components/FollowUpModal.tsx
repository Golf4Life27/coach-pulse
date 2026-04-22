"use client";

import { useEffect, useCallback } from "react";
import { formatCurrency } from "@/lib/utils";
import { showToast } from "@/components/Toast";

interface Variant {
  label: string;
  body: string;
}

interface Context {
  address: string;
  list_price: number;
  our_offer: number;
  agent_first_name: string;
  days_since_contact: number;
  last_reply_excerpt: string;
}

interface FollowUpModalProps {
  variants: Variant[];
  context: Context;
  agentPhone: string;
  onClose: () => void;
}

function cleanPhone(phone: string): string {
  return phone.replace(/[^+\d]/g, "");
}

export default function FollowUpModal({
  variants,
  context,
  agentPhone,
  onClose,
}: FollowUpModalProps) {
  const handleCopy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        showToast("Copied to clipboard", "success");
      } catch {
        showToast("Failed to copy");
      }
    },
    []
  );

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const cleaned = cleanPhone(agentPhone);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-[#161b22] border border-[#30363d] rounded-xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex justify-between items-center p-4 border-b border-[#30363d]">
          <h2 className="text-white font-bold text-sm">Draft Follow-Up</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white text-lg leading-none"
          >
            &times;
          </button>
        </div>

        {/* Context Summary */}
        <div className="p-4 border-b border-[#30363d] bg-[#0d1117]/50">
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <span className="text-gray-500">Property</span>
              <p className="text-white font-medium">{context.address}</p>
            </div>
            <div>
              <span className="text-gray-500">Agent</span>
              <p className="text-white font-medium">
                {context.agent_first_name}
              </p>
            </div>
            <div>
              <span className="text-gray-500">List Price</span>
              <p className="text-white font-medium">
                {formatCurrency(context.list_price)}
              </p>
            </div>
            <div>
              <span className="text-gray-500">Our Offer (65%)</span>
              <p className="text-emerald-400 font-medium">
                {formatCurrency(context.our_offer)}
              </p>
            </div>
            <div>
              <span className="text-gray-500">Days Silent</span>
              <p className="text-white font-medium">
                {context.days_since_contact}
              </p>
            </div>
          </div>
          {context.last_reply_excerpt && (
            <div className="mt-2">
              <span className="text-gray-500 text-xs">Last reply</span>
              <p className="text-xs text-gray-300 bg-[#1c2128] rounded p-2 mt-1 line-clamp-3">
                {context.last_reply_excerpt}
              </p>
            </div>
          )}
        </div>

        {/* Variants */}
        <div className="p-4 space-y-3">
          {variants.map((v, i) => (
            <div
              key={i}
              className="bg-[#1c2128] border border-[#30363d] rounded-lg p-3"
            >
              <div className="flex justify-between items-center mb-2">
                <span className="text-xs font-bold text-gray-400 uppercase tracking-wider">
                  {v.label}
                </span>
              </div>
              <p className="text-sm text-white mb-3 leading-relaxed">
                {v.body}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => handleCopy(v.body)}
                  className="flex-1 bg-[#30363d] hover:bg-[#3d444d] text-gray-200 text-xs font-semibold py-2.5 rounded transition-colors min-h-[44px]"
                >
                  Copy
                </button>
                {cleaned && (
                  <a
                    href={`sms:${cleaned}?body=${encodeURIComponent(v.body)}`}
                    className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold py-2.5 rounded transition-colors min-h-[44px] flex items-center justify-center"
                  >
                    Open in SMS
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-[#30363d]">
          <button
            onClick={onClose}
            className="w-full text-xs text-gray-400 hover:text-white py-2 transition-colors"
          >
            Close (Esc)
          </button>
        </div>
      </div>
    </div>
  );
}
