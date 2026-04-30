"use client";

import { useState, useRef, useEffect } from "react";

interface HoldButtonProps {
  onHold: (untilISO: string) => void;
  disabled?: boolean;
  label?: string;
}

function isoDateOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

const PRESETS: Array<{ label: string; days: number }> = [
  { label: "Tomorrow", days: 1 },
  { label: "+3 days", days: 3 },
  { label: "+1 week", days: 7 },
];

export default function HoldButton({
  onHold,
  disabled,
  label = "Hold for Later",
}: HoldButtonProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} className="relative flex-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        className="w-full bg-[#30363d] hover:bg-[#3d444d] disabled:opacity-50 text-gray-300 text-xs font-semibold py-2.5 rounded transition-colors min-h-[44px]"
      >
        {label}
      </button>
      {open && (
        <div className="absolute z-10 left-0 right-0 mt-1 bg-[#161b22] border border-[#30363d] rounded shadow-xl">
          {PRESETS.map((p) => (
            <button
              key={p.days}
              type="button"
              onClick={() => {
                onHold(isoDateOffset(p.days));
                setOpen(false);
              }}
              className="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-[#30363d]"
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
