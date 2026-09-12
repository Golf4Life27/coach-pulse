"use client";

// One copy-to-clipboard block for the dispo package page. The whole point of
// the package is that the operator (or a browser mission) pastes these words
// VERBATIM — so the affordance is copy, never an editable field that invites a
// quick improvement on the way to a public group.

import { useState } from "react";

export default function DispoCopyBlock({
  label,
  hint,
  text,
}: {
  label: string;
  hint?: string;
  text: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="bg-[#1c2128] rounded-lg border border-[#30363d] p-4">
      <div className="flex items-center justify-between gap-3 mb-2">
        <div>
          <h3 className="text-sm font-bold text-gray-300 uppercase tracking-wider">{label}</h3>
          {hint && <p className="text-[10px] text-gray-500">{hint}</p>}
        </div>
        <div className="flex items-center gap-2 print-hide">
          <span className="text-[10px] text-gray-500">{text.length} chars</span>
          <button
            type="button"
            onClick={copy}
            className="bg-emerald-700 hover:bg-emerald-600 text-white text-xs px-3 py-1.5 rounded"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
      <pre className="whitespace-pre-wrap break-words text-xs text-gray-300 leading-relaxed font-mono">
        {text}
      </pre>
    </div>
  );
}
