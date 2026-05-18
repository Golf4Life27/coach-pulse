"use client";

/**
 * Sentinel room.
 *
 * Phase 9.4b: intake agent (process-intake, verify-listing,
 * multi-listing-detect). Phase 13 / N.3: inbound approval-queue
 * teaser. The full classify + draft + approve UI lives on /sentinel;
 * this room shows the pending count + a deep link so the operator
 * sees queue pressure at glance from the factory floor.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { useBriefing } from "../BriefingProvider";
import {
  summarizeAgentActivity,
  idleActivity,
} from "@/lib/maverick/agent-room";
import AgentRoom from "./AgentRoom";
import RecentEventsList from "./RecentEventsList";

export default function SentinelRoom() {
  const { briefing } = useBriefing();
  const activity = briefing
    ? summarizeAgentActivity(briefing.structured, "sentinel")
    : idleActivity("sentinel");

  const queued = briefing?.structured.pipeline_counts["Multi-Listing Queued"] ?? 0;
  const totalListings = Object.values(briefing?.structured.pipeline_counts ?? {}).reduce(
    (a, b) => a + b,
    0,
  );

  const [inboundCount, setInboundCount] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/sentinel/queue", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((data: { count: number }) => {
        if (!cancelled) setInboundCount(data.count);
      })
      .catch(() => {
        if (!cancelled) setInboundCount(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <AgentRoom
      agent="sentinel"
      displayName="Sentinel"
      role="Intake + Inbound triage"
      activity={activity}
      href="/sentinel"
    >
      <div className="space-y-2">
        <Link
          href="/sentinel"
          className={`block rounded px-2 py-1.5 border ${
            inboundCount && inboundCount > 0
              ? "bg-blue-500/10 border-blue-500/40 hover:bg-blue-500/20"
              : "bg-[#161b22] border-[#30363d] hover:bg-[#21262d]"
          } transition-colors`}
        >
          <div className="flex items-center justify-between">
            <div className="text-[10px] uppercase tracking-wider text-gray-500">
              Inbound queue
            </div>
            <div
              className={`text-sm font-semibold ${
                inboundCount && inboundCount > 0 ? "text-blue-300" : "text-gray-400"
              }`}
            >
              {inboundCount == null ? "—" : inboundCount}
            </div>
          </div>
          <div className="text-[10px] text-gray-500">
            {inboundCount == null
              ? "Loading…"
              : inboundCount === 0
                ? "All replied"
                : `${inboundCount} awaiting reply →`}
          </div>
        </Link>
        <div className="grid grid-cols-2 gap-2 text-[11px]">
          <div className="bg-[#161b22] rounded px-2 py-1">
            <div className="text-gray-500">Queued</div>
            <div className="text-gray-200 font-semibold text-sm">{queued}</div>
          </div>
          <div className="bg-[#161b22] rounded px-2 py-1">
            <div className="text-gray-500">Pipeline</div>
            <div className="text-gray-200 font-semibold text-sm">{totalListings}</div>
          </div>
        </div>
        <div className="border-t border-[#21262d] pt-2">
          <RecentEventsList
            activity={activity}
            emptyLabel="No Sentinel events in window"
          />
        </div>
      </div>
    </AgentRoom>
  );
}
