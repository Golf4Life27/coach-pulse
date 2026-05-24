"use client";

/**
 * Shared per-room recent-events list (Phase 9.4b).
 *
 * Renders an agent's last N audit entries with status dot + event
 * name + relative timestamp. Click-through is omitted here because
 * the parent AgentRoom may already wrap the whole card in a Link.
 */

import {
  formatRelativeTs,
  type AgentActivity,
} from "@/lib/maverick/agent-room";

const STATUS_DOT: Record<AgentActivity["recent_events"][number]["status"], string> = {
  confirmed_success: "bg-emerald-500",
  confirmed_failure: "bg-red-500",
  uncertain: "bg-amber-500",
};

export default function RecentEventsList({
  activity,
  emptyLabel = "No recent events",
}: {
  activity: AgentActivity;
  emptyLabel?: string;
}) {
  if (activity.recent_events.length === 0) {
    return <p className="text-[11px] text-gray-500 italic">{emptyLabel}</p>;
  }
  return (
    <ul className="space-y-1">
      {activity.recent_events.map((e) => (
        <li
          key={`${e.ts}_${e.event}_${e.recordId ?? "no-record"}`}
          className="flex items-center gap-2 text-[11px]"
        >
          <span
            className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${STATUS_DOT[e.status]}`}
            aria-label={e.status}
          />
          <span className="text-gray-300 truncate flex-1">{e.event}</span>
          <span className="text-gray-600 flex-shrink-0">
            {formatRelativeTs(e.ts)}
          </span>
        </li>
      ))}
    </ul>
  );
}
