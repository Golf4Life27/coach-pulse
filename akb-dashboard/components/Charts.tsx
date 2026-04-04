"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import { Listing } from "@/lib/types";

const COLORS = ["#10b981", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6", "#6b7280"];

interface ChartsProps {
  listings: Listing[];
}

export function OutreachFunnel({ listings }: ChartsProps) {
  const data = [
    { name: "Not Contacted", value: listings.filter((l) => !l.outreachStatus).length },
    { name: "Texted", value: listings.filter((l) => l.outreachStatus === "Texted").length },
    { name: "Emailed", value: listings.filter((l) => l.outreachStatus === "Emailed").length },
    { name: "Response", value: listings.filter((l) => l.outreachStatus === "Response Received").length },
    { name: "Negotiating", value: listings.filter((l) => l.outreachStatus === "Negotiating").length },
    { name: "Dead", value: listings.filter((l) => l.outreachStatus === "Dead").length },
  ];

  return (
    <div className="bg-[#1c2128] rounded-lg border border-[#30363d] p-4">
      <h3 className="text-white text-sm font-semibold mb-4">Outreach Funnel</h3>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data} layout="vertical" margin={{ left: 80 }}>
          <XAxis type="number" tick={{ fill: "#9ca3af", fontSize: 11 }} />
          <YAxis type="category" dataKey="name" tick={{ fill: "#9ca3af", fontSize: 11 }} width={80} />
          <Tooltip
            contentStyle={{ backgroundColor: "#1c2128", border: "1px solid #30363d", borderRadius: 8 }}
            labelStyle={{ color: "#fff" }}
            itemStyle={{ color: "#10b981" }}
          />
          <Bar dataKey="value" fill="#10b981" radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function MarketBreakdown({ listings }: ChartsProps) {
  const cityMap: Record<string, number> = {};
  listings.forEach((l) => {
    const city = l.city || "Unknown";
    cityMap[city] = (cityMap[city] || 0) + 1;
  });
  const data = Object.entries(cityMap).map(([name, value]) => ({ name, value }));

  return (
    <div className="bg-[#1c2128] rounded-lg border border-[#30363d] p-4">
      <h3 className="text-white text-sm font-semibold mb-4">Market Breakdown</h3>
      <ResponsiveContainer width="100%" height={200}>
        <PieChart>
          <Pie
            data={data}
            cx="50%"
            cy="50%"
            innerRadius={50}
            outerRadius={80}
            paddingAngle={2}
            dataKey="value"
            label={((props: { name?: string; percent?: number }) => `${props.name ?? ""} ${((props.percent ?? 0) * 100).toFixed(0)}%`) as unknown as import("recharts").PieLabel}
          >
            {data.map((_, i) => (
              <Cell key={i} fill={COLORS[i % COLORS.length]} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{ backgroundColor: "#1c2128", border: "1px solid #30363d", borderRadius: 8 }}
          />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

export function DOMDistribution({ listings }: ChartsProps) {
  const buckets = [
    { name: "0-30", min: 0, max: 30 },
    { name: "30-60", min: 30, max: 60 },
    { name: "60-90", min: 60, max: 90 },
    { name: "90-120", min: 90, max: 120 },
    { name: "120+", min: 120, max: Infinity },
  ];

  const data = buckets.map((b) => ({
    name: b.name,
    value: listings.filter((l) => {
      const dom = l.dom ?? 0;
      return dom >= b.min && dom < b.max;
    }).length,
  }));

  return (
    <div className="bg-[#1c2128] rounded-lg border border-[#30363d] p-4">
      <h3 className="text-white text-sm font-semibold mb-4">DOM Distribution</h3>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data}>
          <XAxis dataKey="name" tick={{ fill: "#9ca3af", fontSize: 11 }} />
          <YAxis tick={{ fill: "#9ca3af", fontSize: 11 }} />
          <Tooltip
            contentStyle={{ backgroundColor: "#1c2128", border: "1px solid #30363d", borderRadius: 8 }}
            labelStyle={{ color: "#fff" }}
            itemStyle={{ color: "#3b82f6" }}
          />
          <Bar dataKey="value" fill="#3b82f6" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function OfferTierBreakdown({ listings }: ChartsProps) {
  const tiers = ["A", "B", "C", "D"];
  const data = tiers.map((tier) => ({
    name: `Tier ${tier}`,
    value: listings.filter((l) => l.offerTier === tier).length,
  }));

  const tierColors = ["#10b981", "#3b82f6", "#f59e0b", "#ef4444"];

  return (
    <div className="bg-[#1c2128] rounded-lg border border-[#30363d] p-4">
      <h3 className="text-white text-sm font-semibold mb-4">Offer Tier Breakdown</h3>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data}>
          <XAxis dataKey="name" tick={{ fill: "#9ca3af", fontSize: 11 }} />
          <YAxis tick={{ fill: "#9ca3af", fontSize: 11 }} />
          <Tooltip
            contentStyle={{ backgroundColor: "#1c2128", border: "1px solid #30363d", borderRadius: 8 }}
            labelStyle={{ color: "#fff" }}
            itemStyle={{ color: "#f59e0b" }}
          />
          <Bar dataKey="value" radius={[4, 4, 0, 0]}>
            {data.map((_, i) => (
              <Cell key={i} fill={tierColors[i]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
