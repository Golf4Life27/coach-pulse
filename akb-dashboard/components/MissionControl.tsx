"use client";

/**
 * Mission Control — the live "machine in motion" belt (operator spec
 * 2026-07-04: "seeing things in action helps").
 *
 * Four stations (CRAWLED → ACCEPTED → SENT → REPLIES) with today's hero
 * count + yesterday beneath; animated dots flow along the lanes between
 * stations whenever today's upstream count > 0 (density by volume). Cron
 * heartbeats (intake / send / next slot countdown) render as status dots
 * ALWAYS paired with text — never color alone. A live event tape shows the
 * day's sends, replies, and quarantines.
 *
 * Motion is decoration, numbers are the data (dataviz doctrine): hero
 * figures wear text tokens; status colors are reserved semantics; the
 * animation honors prefers-reduced-motion.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { DayBuckets, Freshness, TapeEvent } from "@/lib/maverick/heartbeat";

interface Heartbeat {
  last: string | null;
  freshness: Freshness;
}

interface HeartbeatPayload {
  generated_at: string;
  stations: {
    crawled: DayBuckets;
    accepted: DayBuckets;
    sent: DayBuckets;
    replies: DayBuckets;
  };
  heartbeats: { intake: Heartbeat; send: Heartbeat; next_send_slot: string };
  tape: TapeEvent[];
}

const FRESH_STYLE: Record<Freshness, { dot: string; text: string; label: string }> = {
  ok: { dot: "bg-emerald-400", text: "text-emerald-300", label: "on schedule" },
  late: { dot: "bg-amber-300", text: "text-amber-300", label: "running late" },
  stale: { dot: "bg-red-400 animate-pulse", text: "text-red-300", label: "STALE — check crons" },
  never: { dot: "bg-gray-500", text: "text-gray-400", label: "no data" },
};

const TAPE_ICON: Record<TapeEvent["kind"], string> = {
  sent: "📤",
  reply: "💬",
  quarantined: "🛡️",
};

function timeCT(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Chicago",
  });
}

function laneDots(count: number): number {
  if (count <= 0) return 0;
  if (count < 5) return 2;
  if (count < 15) return 3;
  return 5;
}

function Station({ label, icon, b }: { label: string; icon: string; b: DayBuckets }) {
  return (
    <div className="flex flex-col items-center min-w-[86px]">
      <div className="text-lg leading-none">{icon}</div>
      <div className="text-2xl font-bold text-white tabular-nums mt-1">{b.today}</div>
      <div className="text-[10px] uppercase tracking-wider text-gray-500">{label}</div>
      <div className="text-[10px] text-gray-600 tabular-nums">yday {b.yesterday}</div>
    </div>
  );
}

function Lane({ upstreamToday }: { upstreamToday: number }) {
  const n = laneDots(upstreamToday);
  return (
    <div className="relative flex-1 h-[3px] bg-[#21262d] rounded-full overflow-hidden mx-1 self-center" aria-hidden>
      {Array.from({ length: n }).map((_, i) => (
        <span
          key={i}
          className="mc-dot absolute top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-blue-400/90"
          style={{ animationDelay: `${(i * 2.2) / Math.max(1, n)}s` }}
        />
      ))}
    </div>
  );
}

export default function MissionControl() {
  const [data, setData] = useState<HeartbeatPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/maverick/heartbeat", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as HeartbeatPayload);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    load();
    timer.current = setInterval(load, 90_000); // refresh every 90s
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      if (timer.current) clearInterval(timer.current);
      clearInterval(tick);
    };
  }, [load]);

  const countdown = (() => {
    if (!data) return null;
    const ms = new Date(data.heartbeats.next_send_slot).getTime() - now;
    if (ms <= 0) return "firing…";
    const h = Math.floor(ms / 3600_000);
    const m = Math.round((ms % 3600_000) / 60_000);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  })();

  return (
    <section className="border border-[#30363d] rounded-lg bg-[#0d1117] overflow-hidden">
      {/* Scoped keyframes for the belt dots; disabled under reduced motion. */}
      <style>{`
        @keyframes mcFlow { 0% { left: -6%; opacity: 0; } 12% { opacity: 1; } 88% { opacity: 1; } 100% { left: 103%; opacity: 0; } }
        .mc-dot { animation: mcFlow 2.4s linear infinite; }
        @media (prefers-reduced-motion: reduce) { .mc-dot { animation: none; left: 45%; } }
      `}</style>

      <div className="flex items-center justify-between px-4 py-2.5 border-b border-[#30363d] bg-[#161b22]">
        <div className="flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full ${data ? FRESH_STYLE[data.heartbeats.intake.freshness].dot : "bg-gray-500"}`}
          />
          <h2 className="text-sm font-bold text-white tracking-wide">MISSION CONTROL — TODAY&apos;S RUN</h2>
        </div>
        <button type="button" onClick={load} className="text-[11px] text-gray-500 hover:text-gray-300 transition-colors">
          refresh
        </button>
      </div>

      {error ? (
        <div className="px-4 py-4 text-xs text-red-400">
          Heartbeat failed: {error}{" "}
          <button type="button" onClick={load} className="underline text-gray-400 hover:text-gray-200">
            retry
          </button>
        </div>
      ) : !data ? (
        <div className="px-4 py-4 text-xs text-gray-500">Listening for the machine…</div>
      ) : (
        <>
          {/* The belt. */}
          <div className="flex items-stretch px-4 py-4 overflow-x-auto">
            <Station label="Crawled" icon="🕷️" b={data.stations.crawled} />
            <Lane upstreamToday={data.stations.crawled.today} />
            <Station label="Accepted" icon="🛡️" b={data.stations.accepted} />
            <Lane upstreamToday={data.stations.accepted.today} />
            <Station label="Sent" icon="📤" b={data.stations.sent} />
            <Lane upstreamToday={data.stations.sent.today} />
            <Station label="Replies" icon="💬" b={data.stations.replies} />
          </div>

          {/* Heartbeats — status dot ALWAYS paired with text. */}
          <div className="flex flex-wrap gap-x-5 gap-y-1.5 px-4 pb-3 text-[11px]">
            <span className="flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full ${FRESH_STYLE[data.heartbeats.intake.freshness].dot}`} />
              <span className="text-gray-500">intake</span>
              <span className={FRESH_STYLE[data.heartbeats.intake.freshness].text}>
                {timeCT(data.heartbeats.intake.last)} · {FRESH_STYLE[data.heartbeats.intake.freshness].label}
              </span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full ${FRESH_STYLE[data.heartbeats.send.freshness].dot}`} />
              <span className="text-gray-500">last send</span>
              <span className={FRESH_STYLE[data.heartbeats.send.freshness].text}>
                {timeCT(data.heartbeats.send.last)}
              </span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
              <span className="text-gray-500">next send slot</span>
              <span className="text-blue-300 tabular-nums">{countdown}</span>
            </span>
          </div>

          {/* Live tape. */}
          {data.tape.length > 0 && (
            <div className="border-t border-[#21262d] px-4 py-2.5 max-h-36 overflow-y-auto">
              <ul className="space-y-1">
                {data.tape.map((e, i) => (
                  <li key={`${e.ts}-${i}`} className="text-[11px] font-mono text-gray-400 flex gap-2">
                    <span className="text-gray-600 tabular-nums flex-shrink-0">{timeCT(e.ts)}</span>
                    <span aria-hidden>{TAPE_ICON[e.kind]}</span>
                    <span className={e.kind === "reply" ? "text-emerald-300" : e.kind === "quarantined" ? "text-amber-300" : ""}>
                      {e.line}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}
