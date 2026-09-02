"use client";

// Machine Health — the third operator screen (directive 2026-09-01 §5):
// "Sends today/cap, replies, classifier escalations, cron status, connector
// status. Read-only." Built from data that already exists — the Pulse scan
// and the audit tail — with no new plumbing. This is the screen that would
// have shown the 2026-09-02 Quo 402 outage at 9:05am instead of 2pm.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { PulseDetection } from "@/lib/pulse/types";
import {
  summarizeLaneRuns,
  summarizeVendors,
  type LaneRunSummary,
  type AuditRow,
} from "@/lib/health/machine-health";

interface Scan {
  scanned_at: string;
  detections: PulseDetection[];
  transitions?: { new: string[]; resolved: string[]; steady: string[] };
}

async function tail(event: string, limit: number): Promise<AuditRow[]> {
  const res = await fetch(`/api/admin/audit-tail?event=${encodeURIComponent(event)}&limit=${limit}`, { cache: "no-store" });
  if (!res.ok) return [];
  const data = (await res.json()) as { entries?: AuditRow[] };
  return data.entries ?? [];
}

const SEV: Record<string, string> = {
  critical: "bg-red-950/60 text-red-300 border-red-500/40",
  warning: "bg-amber-950/50 text-amber-300 border-amber-500/40",
  info: "bg-[#161b22] text-gray-400 border-[#30363d]",
};

function Tile({ label, value, tone = "calm", sub }: { label: string; value: string; tone?: "calm" | "bad" | "good"; sub?: string }) {
  const ring = tone === "bad" ? "border-l-red-500/70" : tone === "good" ? "border-l-emerald-500/70" : "border-l-[#30363d]";
  return (
    <div className={`bg-[#1c2128] border border-[#30363d] border-l-4 ${ring} rounded-xl p-4`}>
      <div className="text-[10px] font-bold tracking-wider text-gray-500 uppercase">{label}</div>
      <div className="text-2xl font-semibold text-white mt-1">{value}</div>
      {sub && <div className="text-[11px] text-gray-500 mt-1">{sub}</div>}
    </div>
  );
}

export default function MachineHealth() {
  const [scan, setScan] = useState<Scan | null>(null);
  const [outreach, setOutreach] = useState<AuditRow[]>([]);
  const [bumps, setBumps] = useState<AuditRow[]>([]);
  const [trips, setTrips] = useState<AuditRow[]>([]);
  const [replies, setReplies] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, o, b, t, r] = await Promise.all([
        fetch("/api/agents/pulse/scan", { cache: "no-store" }).then((x) => (x.ok ? x.json() : null)),
        tail("h2_outreach_live", 40),
        tail("h2_bump_live", 20),
        tail("quo_credits_exhausted", 3),
        tail("reply_draft_created", 50),
      ]);
      setScan(s);
      setOutreach(o);
      setBumps(b);
      setTrips(t);
      setReplies(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5 * 60_000);
    return () => clearInterval(t);
  }, [load]);

  const now = Date.now();
  const lanes: LaneRunSummary = useMemo(() => summarizeLaneRuns([...outreach, ...bumps], now), [outreach, bumps, now]);
  const detections = scan?.detections ?? [];
  const vendors = useMemo(() => summarizeVendors(detections, trips, now), [detections, trips, now]);
  const repliesToday = replies.filter((r) => now - Date.parse(r.ts) < 24 * 3_600_000).length;
  const escalations = detections.filter((d) => d.severity === "critical").length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-sm font-bold text-white tracking-wide">
          MACHINE HEALTH <span className="text-gray-500 font-normal">(read-only · auto-refreshes every 5 min)</span>
        </h1>
        <button type="button" onClick={load} className="text-[11px] text-gray-500 hover:text-gray-300 min-h-[44px] px-2">
          refresh
        </button>
      </div>

      {error && <div className="text-xs text-red-300 border border-red-500/40 rounded-xl px-3 py-2">{error}</div>}

      {/* Row 1 — the numbers that matter */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Tile
          label="Texts sent today"
          value={loading ? "…" : String(lanes.sentToday)}
          tone={lanes.sentToday === 0 && lanes.runsToday > 0 ? "bad" : lanes.sentToday > 0 ? "good" : "calm"}
          sub={`of ${lanes.dailyCap ?? "—"} cap · ${lanes.runsToday} slot runs`}
        />
        <Tile
          label="Slots fired blank"
          value={loading ? "…" : String(lanes.blankRunsToday)}
          tone={lanes.blankRunsToday > 0 ? "bad" : "good"}
          sub="had work, sent zero"
        />
        <Tile
          label="Quo credits"
          value={loading ? "…" : vendors.quoCredits.label}
          tone={vendors.quoCredits.ok ? "good" : "bad"}
          sub={vendors.quoCredits.detail}
        />
        <Tile label="Replies drafted 24h" value={loading ? "…" : String(repliesToday)} sub={`${escalations} critical detections`} />
      </div>

      {/* Row 2 — connectors */}
      <section className="space-y-2">
        <h2 className="text-xs font-bold text-gray-400 tracking-wider">CONNECTORS</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {vendors.rows.map((v) => (
            <div key={v.name} className={`rounded-xl border px-3 py-2 text-xs ${v.ok ? "border-emerald-500/30 bg-emerald-950/20 text-emerald-200" : "border-red-500/40 bg-red-950/40 text-red-200"}`}>
              <div className="font-semibold">{v.ok ? "● " : "✕ "}{v.name}</div>
              <div className="text-[11px] opacity-80">{v.detail}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Row 3 — send slots */}
      <section className="space-y-2">
        <h2 className="text-xs font-bold text-gray-400 tracking-wider">SEND SLOTS (last 24h)</h2>
        <div className="overflow-x-auto rounded-xl border border-[#30363d]">
          <table className="w-full text-xs">
            <thead className="bg-[#161b22] text-gray-500">
              <tr>
                <th className="text-left px-3 py-2">time (UTC)</th>
                <th className="text-left px-3 py-2">lane</th>
                <th className="text-right px-3 py-2">processed</th>
                <th className="text-right px-3 py-2">sent</th>
                <th className="text-right px-3 py-2">errors</th>
                <th className="text-right px-3 py-2">probe credits</th>
                <th className="text-left px-3 py-2">note</th>
              </tr>
            </thead>
            <tbody>
              {lanes.runs.map((r) => (
                <tr key={r.ts + r.lane} className={`border-t border-[#30363d] ${r.blank ? "bg-red-950/20" : ""}`}>
                  <td className="px-3 py-1.5 text-gray-300">{r.ts.slice(11, 16)}</td>
                  <td className="px-3 py-1.5 text-gray-400">{r.lane}</td>
                  <td className="px-3 py-1.5 text-right text-gray-300">{r.processed}</td>
                  <td className={`px-3 py-1.5 text-right font-semibold ${r.sent > 0 ? "text-emerald-300" : "text-gray-500"}`}>{r.sent}</td>
                  <td className={`px-3 py-1.5 text-right ${r.errors > 0 ? "text-red-300" : "text-gray-500"}`}>{r.errors}</td>
                  <td className="px-3 py-1.5 text-right text-gray-400">{r.probeCredits}</td>
                  <td className="px-3 py-1.5 text-gray-500">{r.note}</td>
                </tr>
              ))}
              {lanes.runs.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-4 text-center text-gray-500">
                    {loading ? "Loading…" : "No lane runs in the audit window."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Row 4 — detections */}
      <section className="space-y-2">
        <h2 className="text-xs font-bold text-gray-400 tracking-wider">
          PULSE DETECTIONS {scan?.scanned_at && <span className="font-normal text-gray-600">· scanned {scan.scanned_at.slice(11, 16)}Z</span>}
        </h2>
        {detections.length === 0 ? (
          <div className="rounded-xl border border-[#30363d] px-4 py-6 text-center text-sm text-gray-400">
            {loading ? "Scanning…" : "🟢 Nothing detected."}
          </div>
        ) : (
          <div className="space-y-2">
            {detections.map((d) => (
              <div key={d.id} className="bg-[#1c2128] border border-[#30363d] rounded-xl p-3">
                <div className="flex items-center gap-2">
                  <span className={`text-[10px] font-bold tracking-wider px-2 py-0.5 rounded-full border ${SEV[d.severity] ?? SEV.info}`}>{d.severity.toUpperCase()}</span>
                  <span className="text-sm text-white font-semibold">{d.title}</span>
                </div>
                {d.suggested_action && <p className="mt-1 text-xs text-gray-400">{d.suggested_action}</p>}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
