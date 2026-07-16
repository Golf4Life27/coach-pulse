"use client";

// PRE-CONTRACT GATE banner (operator 2026-07-16). The red/amber/green stop
// surface in the deal room: before you contract, is this deal underwritten,
// priced within the ceiling for its chosen exit, DD'd, and market-fresh — or
// are you overriding with eyes open? Exit-aware, waivable, never a hard block.

import { useCallback, useEffect, useState } from "react";
import { showToast } from "@/components/Toast";
import { EXIT_LABELS, type ExitStrategy, type PreContractGate } from "@/lib/pre-contract-gate/model";

interface Payload {
  gate: PreContractGate;
  exit: ExitStrategy | null;
  waivers: Record<string, string>;
  address: string | null;
}

const STATUS_STYLE: Record<PreContractGate["status"], string> = {
  clear: "border-emerald-500/50 bg-emerald-950/25",
  warn: "border-amber-500/50 bg-amber-950/25",
  waived: "border-orange-500/50 bg-orange-950/25",
  blocked: "border-red-500/60 bg-red-950/35",
};
const CHECK_ICON: Record<"pass" | "warn" | "fail", string> = { pass: "✓", warn: "!", fail: "✕" };
const CHECK_COLOR: Record<"pass" | "warn" | "fail", string> = {
  pass: "text-emerald-400",
  warn: "text-amber-400",
  fail: "text-red-400",
};
const EXITS: ExitStrategy[] = ["cash_flip", "wholesale", "rental", "creative"];

export default function PreContractGate({ recordId }: { recordId: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/pre-contract-gate/${recordId}`, { cache: "no-store" });
      if (res.ok) setData((await res.json()) as Payload);
    } catch {
      /* silent — the gate is an aid, not the page */
    }
  }, [recordId]);

  useEffect(() => {
    load();
  }, [load]);

  const patch = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      try {
        const res = await fetch(`/api/pre-contract-gate/${recordId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const out = await res.json().catch(() => ({}));
        if (res.ok) setData(out as Payload);
        else showToast(out.error || "Update failed");
      } catch {
        showToast("Update failed");
      } finally {
        setBusy(false);
      }
    },
    [recordId],
  );

  if (!data) return null;
  const { gate, exit, waivers } = data;

  return (
    <section className={`rounded-xl border ${STATUS_STYLE[gate.status]} p-4`}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h3 className="text-sm font-bold text-white">{gate.headline}</h3>
        <label className="flex items-center gap-2 text-[11px] text-gray-400">
          Exit
          <select
            value={exit ?? ""}
            disabled={busy}
            onChange={(e) => patch({ exit: e.target.value })}
            className="bg-[#0d1117] border border-[#30363d] rounded-lg px-2 py-1.5 text-[12px] text-white focus:outline-none focus:border-emerald-500 disabled:opacity-50"
          >
            <option value="" disabled>
              choose…
            </option>
            {EXITS.map((x) => (
              <option key={x} value={x}>
                {EXIT_LABELS[x]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <ul className="mt-3 space-y-2">
        {gate.checks.map((c) => {
          const effective = c.waived && c.status === "fail" ? "waived" : c.status;
          return (
            <li key={c.id} className="flex items-start gap-2.5 text-[12px]">
              <span className={`mt-0.5 font-bold ${c.waived && c.status === "fail" ? "text-orange-400" : CHECK_COLOR[c.status]}`}>
                {c.waived && c.status === "fail" ? "⤳" : CHECK_ICON[c.status]}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-gray-200">{c.label}</span>
                  {c.waived && c.status === "fail" && (
                    <span className="text-[9px] uppercase tracking-wide text-orange-400 font-bold">waived</span>
                  )}
                </div>
                <p className="text-gray-400 leading-snug">{c.detail}</p>
                {c.waived && waivers[c.id] && (
                  <p className="text-[11px] text-orange-300/80 italic mt-0.5">“{waivers[c.id]}”</p>
                )}
                {/* Waive / un-waive controls on failing, waivable checks. */}
                {c.status === "fail" && c.waivable && !c.waived && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      const reason = window.prompt(`Override "${c.label}" with eyes open. Reason (logged):`);
                      if (reason && reason.trim()) patch({ waive: { id: c.id, reason: reason.trim() } });
                    }}
                    className="mt-1 text-[11px] text-gray-400 hover:text-orange-300 underline underline-offset-2"
                  >
                    Waive with reason
                  </button>
                )}
                {c.waived && c.status === "fail" && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => patch({ unwaive: c.id })}
                    className="mt-1 text-[11px] text-gray-500 hover:text-gray-300 underline underline-offset-2"
                  >
                    Remove waiver
                  </button>
                )}
                {effective === "warn" && !c.waived && <span className="sr-only">caution</span>}
              </div>
            </li>
          );
        })}
      </ul>

      {gate.status === "blocked" && (
        <p className="mt-3 text-[11px] text-red-300/80">
          Clear or waive the blocker{gate.blockers === 1 ? "" : "s"} before you contract or wire. The gate never stops you —
          it just makes sure you&apos;re never blind.
        </p>
      )}
    </section>
  );
}
