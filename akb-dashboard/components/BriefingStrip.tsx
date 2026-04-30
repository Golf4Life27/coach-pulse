"use client";

import { Briefing } from "@/lib/types";

interface Props {
  briefing: Briefing | null;
  previousLogin: string | null;
}

interface CardProps {
  label: string;
  value: string;
  subtitle?: string;
  accent?: "orange" | "yellow" | "blue" | "gray" | "red";
  muted?: boolean;
}

const ACCENT: Record<NonNullable<CardProps["accent"]>, string> = {
  orange: "border-orange-500",
  yellow: "border-yellow-500",
  blue: "border-blue-500",
  gray: "border-gray-500",
  red: "border-red-500",
};

function BriefingCard({ label, value, subtitle, accent = "gray", muted }: CardProps) {
  return (
    <div
      className={`bg-[#1c2128] rounded-lg border-l-4 ${ACCENT[accent]} p-3`}
    >
      <p className="text-[10px] uppercase tracking-wider text-gray-500 mb-0.5">
        {label}
      </p>
      <p
        className={`text-xl font-bold ${
          muted ? "text-gray-500" : "text-white"
        }`}
      >
        {value}
      </p>
      {subtitle && (
        <p className="text-[10px] text-gray-500 mt-0.5">{subtitle}</p>
      )}
    </div>
  );
}

function formatRelativeLogin(iso: string | null): string | null {
  if (!iso) return null;
  const prev = new Date(iso);
  if (Number.isNaN(prev.getTime())) return null;
  const diffMs = Date.now() - prev.getTime();
  const hours = Math.floor(diffMs / 3_600_000);
  if (hours < 1) return "less than an hour ago";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function BriefingStrip({ briefing, previousLogin }: Props) {
  const last = formatRelativeLogin(previousLogin);

  if (!briefing) {
    return (
      <div className="bg-[#1c2128] rounded-lg border border-[#30363d] p-4 text-gray-500 text-sm animate-pulse">
        Loading briefing...
      </div>
    );
  }

  const hasGap = (g: Briefing["gaps"][number]) => briefing.gaps.includes(g);

  return (
    <section>
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-sm font-bold text-gray-400 uppercase tracking-wider">
          Morning Briefing
        </h2>
        {last && (
          <span className="text-[10px] text-gray-500">last visit {last}</span>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <BriefingCard
          label="Pending Responses"
          value={String(briefing.pendingResponses)}
          subtitle={
            hasGap("pendingResponsesSinceLogin")
              ? "currently open (not since-login)"
              : undefined
          }
          accent="orange"
        />
        <BriefingCard
          label="Active Negotiations"
          value={String(briefing.activeNegotiations)}
          subtitle={`${briefing.staleNegotiations} silent 7d+`}
          accent="yellow"
        />
        <BriefingCard
          label="Deal Deadlines 7d"
          value={hasGap("dealDeadlines7d") ? "—" : String(briefing.dealDeadlines7d)}
          subtitle={hasGap("dealDeadlines7d") ? "no expiry field on Deals" : undefined}
          accent="blue"
          muted={hasGap("dealDeadlines7d")}
        />
        <BriefingCard
          label="Texted Today"
          value={String(briefing.textsToday)}
          subtitle={
            briefing.responseRateToday == null
              ? "response rate —"
              : `${Math.round(briefing.responseRateToday * 100)}% reply rate`
          }
          accent="blue"
        />
        <BriefingCard
          label="Make Errors 24h"
          value={hasGap("makeErrors24h") ? "—" : String(briefing.makeErrors24h)}
          subtitle={hasGap("makeErrors24h") ? "no log source wired" : undefined}
          accent="red"
          muted={hasGap("makeErrors24h")}
        />
      </div>
    </section>
  );
}
