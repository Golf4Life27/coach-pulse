"use client";

/**
 * Maverick priority surface (Phase 9.2).
 *
 * Renders priority signals derived from `maverick_load_state` output.
 * Lives inside the expanded Shepherd panel; can also be embedded
 * directly in pages that want a standalone priority list.
 *
 * Signals carry severity tier (Phase 9.5) which drives card colors.
 * Each card has optional href for click-through navigation. Empty
 * state is the Watching message per Character Spec §3 (Maverick is
 * resting, eyes alert).
 */

import Link from "next/link";
import { TIER_VISUAL, type PrioritySignal } from "@/lib/maverick/severity";

interface Props {
  signals: PrioritySignal[];
  /** Pass loading state from parent so we can render a skeleton. */
  loading?: boolean;
  /** Error message from the last load attempt; renders retry CTA. */
  error?: string | null;
  /** Click-to-retry handler when error is set. */
  onRetry?: () => void;
}

export default function MaverickPriority({
  signals,
  loading = false,
  error = null,
  onRetry,
}: Props) {
  if (loading) {
    return (
      <div className="space-y-2 px-3 py-4 text-xs text-gray-500">
        Maverick is watching…
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-3 px-3 py-4">
        <div className="text-xs text-red-400">
          Briefing failed: {error}
        </div>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="text-xs bg-[#1c2128] border border-[#30363d] text-gray-300 px-3 py-1.5 rounded hover:bg-[#30363d] transition-colors"
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  if (signals.length === 0) {
    return (
      <div className="px-3 py-4 text-xs text-gray-500">
        All clear. Maverick is watching.
      </div>
    );
  }

  return (
    <ul className="space-y-2 px-2 py-3">
      {signals.map((s) => {
        const v = TIER_VISUAL[s.tier];
        const cardBody = (
          <div
            className={`border-l-2 ${v.border} ${v.bg} rounded-r px-3 py-2 transition-colors hover:bg-[#1c2128]`}
          >
            <div className="flex items-start gap-2">
              <span className={`w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 ${v.dot}`} />
              <div className="flex-1 min-w-0">
                <div className={`text-xs font-semibold ${v.text}`}>
                  {s.title}
                </div>
                {s.reason && (
                  <div className="text-[11px] text-gray-500 mt-1 leading-relaxed">
                    {s.reason}
                  </div>
                )}
                {s.agent && (
                  <div className="text-[10px] text-gray-600 uppercase tracking-wider mt-1.5">
                    @{s.agent}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
        return (
          <li key={s.id}>
            {s.href ? (
              <Link href={s.href} className="block">
                {cardBody}
              </Link>
            ) : (
              cardBody
            )}
          </li>
        );
      })}
    </ul>
  );
}
