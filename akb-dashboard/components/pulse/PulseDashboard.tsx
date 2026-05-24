"use client";

// Phase 14 / O.3 — Pulse approval-style dashboard.
//
// Mirrors the SentinelApprovalQueue shape: list of cards with
// expand-on-click detail + a manual scan button. Pulse is read-only
// (no auto-remediation per Phase 14 charter); operator sees the
// detections, suggested actions, and source data. Acting on a
// detection happens elsewhere (Sentinel for inbound, Crier for
// outreach, manual checks for infrastructure).

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { showToast } from "@/components/Toast";
import type { PulseDetection, PulseSeverity } from "@/lib/pulse/types";

const SEVERITY_STYLE: Record<
  PulseSeverity,
  { border: string; pillBg: string; pillFg: string; label: string }
> = {
  critical: {
    border: "border-red-700/60",
    pillBg: "bg-red-500/15",
    pillFg: "text-red-300",
    label: "CRITICAL",
  },
  warning: {
    border: "border-orange-700/60",
    pillBg: "bg-orange-500/15",
    pillFg: "text-orange-300",
    label: "WARNING",
  },
  info: {
    border: "border-emerald-700/60",
    pillBg: "bg-emerald-500/15",
    pillFg: "text-emerald-300",
    label: "INFO",
  },
};

interface ScanResponse {
  scanned_at: string;
  elapsed_ms: number;
  audit_log_size: number;
  listings_examined: number;
  test_count: number | null;
  previous_test_count: number | null;
  transitions: { new: string[]; resolved: string[]; steady: string[] };
  spine_writes: string[];
  detections: PulseDetection[];
  state: {
    active: Record<
      string,
      { detection: PulseDetection; first_seen_at: string }
    >;
    last_scan_at: string | null;
    test_count_anchor: number | null;
  };
}

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const hours = Math.max(0, (Date.now() - t) / 3_600_000);
  if (hours < 1) return "<1h ago";
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function DetectionCard({
  detection,
  firstSeenAt,
}: {
  detection: PulseDetection;
  firstSeenAt: string;
}) {
  const [open, setOpen] = useState(false);
  const style = SEVERITY_STYLE[detection.severity];

  return (
    <div className={`bg-[#161b22] rounded-lg border ${style.border} p-3 space-y-1.5`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left flex items-start gap-2"
      >
        <span
          className={`flex-shrink-0 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${style.pillBg} ${style.pillFg}`}
        >
          {style.label}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-white leading-tight">
            {detection.title}
          </div>
          <div className="text-[10px] text-gray-500 mt-0.5">
            {detection.detector_id} · active {formatRelative(firstSeenAt)}
          </div>
        </div>
        <span className="text-[10px] text-gray-500 flex-shrink-0">
          {open ? "▴" : "▾"}
        </span>
      </button>

      {open && (
        <div className="space-y-2 pt-1 border-t border-[#30363d]">
          <p className="text-[11px] text-gray-300 whitespace-pre-wrap">
            {detection.description}
          </p>
          {detection.suggested_action && (
            <div className="bg-[#0d1117] border-l-2 border-blue-500/40 rounded px-2 py-1.5">
              <div className="text-[9px] uppercase tracking-wider text-blue-400 mb-0.5">
                Suggested action
              </div>
              <p className="text-[11px] text-gray-200 whitespace-pre-wrap">
                {detection.suggested_action}
              </p>
            </div>
          )}
          {detection.source_data && (
            <details className="group">
              <summary className="text-[10px] text-gray-500 cursor-pointer hover:text-gray-300">
                Source data
              </summary>
              <pre className="text-[10px] text-gray-400 mt-1 p-2 bg-[#0d1117] rounded overflow-x-auto whitespace-pre">
                {JSON.stringify(detection.source_data, null, 2)}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

export default function PulseDashboard() {
  const [scan, setScan] = useState<ScanResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runScan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/agents/pulse/scan", { cache: "no-store" });
      const data = (await res.json()) as ScanResponse | { error?: string; detail?: string };
      if (!res.ok || "error" in data) {
        throw new Error(("detail" in data && data.detail) || ("error" in data && data.error) || `HTTP ${res.status}`);
      }
      setScan(data as ScanResponse);
      const transitions = (data as ScanResponse).transitions;
      const summary =
        transitions.new.length === 0 && transitions.resolved.length === 0
          ? "Scan complete · no transitions"
          : `+${transitions.new.length} fired / -${transitions.resolved.length} resolved`;
      showToast(summary, "success");
    } catch (err) {
      setError(String(err).slice(0, 300));
      showToast(`Pulse scan failed: ${String(err).slice(0, 80)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    runScan();
  }, [runScan]);

  const detections = scan?.detections ?? [];
  const state = scan?.state;
  const activeEntries = state ? Object.values(state.active) : [];

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-bold text-white">Pulse · Self-monitoring</h1>
          <p className="text-[11px] text-gray-500">
            Anomaly detectors over Phase 4 / 13 / 16. Surface only — no auto-remediation.
            Click a detection to expand detail + suggested action.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {scan?.scanned_at && (
            <span className="text-[10px] text-gray-500">
              Scanned {formatRelative(scan.scanned_at)}
              {scan.elapsed_ms != null ? ` · ${scan.elapsed_ms}ms` : ""}
            </span>
          )}
          <button
            type="button"
            onClick={runScan}
            disabled={loading}
            className="text-xs bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white px-3 py-1.5 rounded"
          >
            {loading ? "Scanning…" : "Scan now"}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/40 rounded px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      {scan && (
        <div className="grid grid-cols-3 gap-2">
          <SummaryCell
            label="Critical"
            count={detections.filter((d) => d.severity === "critical").length}
            style={SEVERITY_STYLE.critical}
          />
          <SummaryCell
            label="Warning"
            count={detections.filter((d) => d.severity === "warning").length}
            style={SEVERITY_STYLE.warning}
          />
          <SummaryCell
            label="Info"
            count={detections.filter((d) => d.severity === "info").length}
            style={SEVERITY_STYLE.info}
          />
        </div>
      )}

      {scan && detections.length === 0 && !loading && (
        <div className="bg-[#161b22] rounded-lg border border-[#30363d] p-6 text-center text-sm text-gray-500">
          All clear. {scan.transitions.resolved.length > 0 && `${scan.transitions.resolved.length} detection(s) resolved this scan.`}
        </div>
      )}

      <div className="space-y-2">
        {detections.map((d) => {
          // Pull first_seen_at out of the persisted state when available;
          // fresh fires this scan use detected_at as their first-seen anchor.
          const entry = activeEntries.find((e) => e.detection.id === d.id);
          const firstSeen = entry?.first_seen_at ?? d.detected_at;
          return <DetectionCard key={d.id} detection={d} firstSeenAt={firstSeen} />;
        })}
      </div>

      {scan && (
        <details className="group">
          <summary className="text-[10px] text-gray-500 cursor-pointer hover:text-gray-300">
            Scan metadata
          </summary>
          <pre className="text-[10px] text-gray-400 mt-1 p-2 bg-[#0d1117] rounded overflow-x-auto whitespace-pre">
            {JSON.stringify(
              {
                audit_log_size: scan.audit_log_size,
                listings_examined: scan.listings_examined,
                test_count: scan.test_count,
                test_count_anchor: scan.state.test_count_anchor,
                transitions: scan.transitions,
                spine_writes: scan.spine_writes,
              },
              null,
              2,
            )}
          </pre>
        </details>
      )}

      <p className="text-[10px] text-gray-600">
        Pulse runs daily via cron. Manual scan above. See{" "}
        <Link href="/pipeline" className="text-blue-400 hover:underline">
          /pipeline
        </Link>{" "}
        for acting on stale-data-drift detections.
      </p>
    </section>
  );
}

function SummaryCell({
  label,
  count,
  style,
}: {
  label: string;
  count: number;
  style: (typeof SEVERITY_STYLE)[PulseSeverity];
}) {
  return (
    <div
      className={`rounded-lg border ${style.border} px-3 py-2 ${count === 0 ? "opacity-50" : ""}`}
    >
      <div className={`text-[10px] uppercase tracking-wider ${style.pillFg}`}>
        {label}
      </div>
      <div className={`text-2xl font-bold ${style.pillFg}`}>{count}</div>
    </div>
  );
}
