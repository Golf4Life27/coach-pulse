"use client";

// Decision Card buttons — the tap-and-confirm client half of app/a/[token].
//
// POSTs { token, optionKey } to /api/maverick/act. That route looks
// optionKey up in the STORED card server-side and executes only the action
// that was already declared there — this component never sends an action
// type, a record id, or anything else that could change what happens.
//
// All buttons disable the instant one is tapped so a double-tap (or a
// flaky mobile connection retrying) can't fire the action twice — the
// server's single-use claim backs that up, but a mobile phone one-handed
// outdoors deserves not to see the same button twice.

import { useState } from "react";

interface ButtonOption {
  key: string;
  label: string;
  style: "primary" | "secondary" | "danger";
  confirmation: string;
}

const STYLE_CLASSES: Record<ButtonOption["style"], string> = {
  primary: "bg-neutral-900 text-white active:bg-neutral-700",
  secondary: "bg-neutral-100 text-neutral-900 border border-neutral-300 active:bg-neutral-200",
  danger: "bg-red-600 text-white active:bg-red-700",
};

type ActState =
  | { phase: "idle" }
  | { phase: "pending"; key: string }
  | { phase: "done"; confirmation: string }
  | { phase: "error"; message: string };

export default function CardActions({ token, options }: { token: string; options: ButtonOption[] }) {
  const [state, setState] = useState<ActState>({ phase: "idle" });

  if (state.phase === "done") {
    return (
      <div className="rounded-xl bg-green-50 border border-green-200 p-4 text-green-900 text-base">
        {state.confirmation}
      </div>
    );
  }

  async function choose(optionKey: string) {
    setState({ phase: "pending", key: optionKey });
    try {
      const res = await fetch("/api/maverick/act", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, optionKey }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        const reason = data?.reason ?? data?.error ?? `HTTP ${res.status}`;
        setState({ phase: "error", message: describeFailure(reason) });
        return;
      }
      setState({ phase: "done", confirmation: data.confirmation ?? "Done." });
    } catch {
      setState({ phase: "error", message: "Couldn't reach the dashboard. Check your connection and try again." });
    }
  }

  const disabled = state.phase === "pending";

  return (
    <div className="space-y-3">
      {options.map((opt) => (
        <button
          key={opt.key}
          type="button"
          disabled={disabled}
          onClick={() => choose(opt.key)}
          className={`w-full min-h-[48px] rounded-xl px-4 py-3 text-base font-semibold disabled:opacity-50 ${STYLE_CLASSES[opt.style]}`}
        >
          {disabled && state.phase === "pending" && state.key === opt.key ? "Working…" : opt.label}
        </button>
      ))}
      {state.phase === "error" && (
        <p className="text-sm text-red-700 mt-2">{state.message}</p>
      )}
    </div>
  );
}

function describeFailure(reason: string): string {
  switch (reason) {
    case "expired":
      return "This link expired before you tapped.";
    case "already_used":
      return "This link was already used.";
    case "not_found":
      return "This link is not valid.";
    case "unknown_option":
      return "That option isn't on this card anymore.";
    default:
      // Deliberately does NOT promise "nothing was changed": a failure from
      // the action executor lands AFTER the card is spent, so the write may
      // have partially happened. Telling him it definitely did not, and being
      // wrong, is worse than telling him to look.
      return `Something went wrong (${reason}). Check the record before retrying.`;
  }
}
