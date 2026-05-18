"use client";

/**
 * Scribe deal-detail commentary panel (Phase 5.3 + 5.4).
 *
 * Daily UX Spec §7.1: "Related-deal recall ... when Maverick remembers
 * context across deals" + envelope-status surfacing. This panel reads
 * the shared briefing via useBriefing() (Phase 9.4 discipline — no new
 * call paths) and finds the envelope matching the deal's `envelopeId`
 * field.
 *
 * Three states:
 *   1. envelopeId set + envelope found in briefing →
 *      render status + awaiting recipient + last action + deep link
 *      + "Send reminder" button (only when awaiting a non-Alex recipient)
 *      + "Untrack" affordance
 *   2. envelopeId set but no matching envelope in briefing (stale or
 *      outside the 30-day look-back) → render the GUID + a hint that
 *      the briefing window doesn't cover it + Untrack
 *   3. envelopeId null → render the "Track in Scribe" affordance:
 *      input + Track button. Writes via /api/maverick/track-envelope.
 *
 * When DocuSign isn't configured (briefing.docusign.configured=false),
 * the panel renders a single-line "Scribe credentials pending" note
 * regardless of envelopeId state — clear honest signal, never fakes.
 */

import { useState } from "react";
import { useBriefing } from "./BriefingProvider";
import type { EnvelopeSummary } from "@/lib/docusign";

export interface ScribeDealCommentaryProps {
  recordId: string;
  envelopeId: string | null;
}

export default function ScribeDealCommentary({
  recordId,
  envelopeId,
}: ScribeDealCommentaryProps) {
  const { briefing, refetch } = useBriefing();
  const docusign = briefing?.structured.external_signals.docusign;
  const configured = docusign?.configured ?? false;

  // Local state for the Track / Untrack / Send-reminder operations.
  const [trackInput, setTrackInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reminderStatus, setReminderStatus] = useState<string | null>(null);

  // Credentials-not-configured rendering — single line, no buttons.
  // Alex sees this until DOCUSIGN_INTEGRATION_KEY / DOCUSIGN_USER_ID /
  // DOCUSIGN_PRIVATE_KEY are provisioned in Vercel env.
  if (!configured) {
    return (
      <div className="bg-[#1c2128] rounded-lg border border-[#30363d] p-3">
        <h3 className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">
          Scribe
        </h3>
        <p className="text-[11px] text-gray-500 italic">
          DocuSign credentials pending (Phase 12.x).
        </p>
      </div>
    );
  }

  const envelope = envelopeId
    ? (docusign?.envelopes ?? []).find((e) => e.envelopeId === envelopeId) ??
      null
    : null;

  const handleTrack = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/maverick/track-envelope/${recordId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ envelope_id: trackInput.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.reason ?? data.error ?? `HTTP ${res.status}`);
      }
      setTrackInput("");
      // Force a briefing refresh so the panel re-renders with the new
      // envelope state without waiting for the next 90s poll. Phase
      // 11.7 visibility-polling stays intact.
      refetch();
      // Trigger a full page-level refetch by reloading — listing.envelopeId
      // is fetched via /api/listings/[id] (not the briefing), so the
      // parent must re-fetch. Soft reload preserves scroll position.
      if (typeof window !== "undefined") window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleUntrack = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/maverick/track-envelope/${recordId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ envelope_id: null }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (typeof window !== "undefined") window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleSendReminder = async () => {
    if (!envelopeId) return;
    setError(null);
    setReminderStatus(null);
    setBusy(true);
    try {
      const res = await fetch(
        `/api/maverick/docusign-send-reminder/${envelopeId}`,
        { method: "POST" },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message ?? data.error ?? `HTTP ${res.status}`);
      }
      setReminderStatus("Reminder sent");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // No envelope tracked → render the Track affordance.
  if (!envelopeId) {
    return (
      <div className="bg-[#1c2128] rounded-lg border border-[#30363d] p-3 space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">
            Scribe
          </h3>
        </div>
        <p className="text-[11px] text-gray-500 italic">No envelope tracked for this deal.</p>
        <div className="flex gap-2">
          <input
            type="text"
            value={trackInput}
            onChange={(e) => setTrackInput(e.target.value)}
            placeholder="Paste DocuSign envelope GUID"
            className="flex-1 bg-[#0d1117] border border-[#30363d] rounded px-2 py-1.5 text-[11px] text-white focus:outline-none focus:border-emerald-500 placeholder-gray-600 font-mono"
            disabled={busy}
          />
          <button
            type="button"
            onClick={handleTrack}
            disabled={busy || trackInput.trim().length < 8}
            className="bg-emerald-700 hover:bg-emerald-600 text-white text-[11px] font-semibold px-3 py-1.5 rounded disabled:opacity-50"
          >
            {busy ? "..." : "Track"}
          </button>
        </div>
        {error && <p className="text-[10px] text-red-400">{error}</p>}
      </div>
    );
  }

  // Envelope tracked but not found in briefing (outside 30-day window
  // or DocuSign API down on the last refresh).
  if (!envelope) {
    return (
      <div className="bg-[#1c2128] rounded-lg border border-[#30363d] p-3 space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">
            Scribe
          </h3>
          <button
            type="button"
            onClick={handleUntrack}
            disabled={busy}
            className="text-[10px] text-gray-500 hover:text-gray-300 disabled:opacity-50"
          >
            Untrack
          </button>
        </div>
        <p className="text-[11px] text-gray-300 font-mono break-all">{envelopeId}</p>
        <p className="text-[10px] text-gray-500 italic">
          Envelope not in the current briefing window (30 days). May be older
          than the look-back or DocuSign API was unreachable on the last
          refresh.
        </p>
        {error && <p className="text-[10px] text-red-400">{error}</p>}
      </div>
    );
  }

  // Envelope tracked + found — full rendering.
  const tierColor = envelopeStatusColor(envelope);
  const awaitingHours = envelope.awaiting_hours;
  const canSendReminder = envelope.awaiting_recipient_email !== null && !envelope.awaiting_is_alex;

  return (
    <div
      className={`bg-[#1c2128] rounded-lg border ${tierColor.border} p-3 space-y-2`}
    >
      <div className="flex items-center justify-between">
        <h3 className={`text-[10px] font-bold uppercase tracking-wider ${tierColor.text}`}>
          Scribe — {envelope.status}
        </h3>
        <button
          type="button"
          onClick={handleUntrack}
          disabled={busy}
          className="text-[10px] text-gray-500 hover:text-gray-300 disabled:opacity-50"
        >
          Untrack
        </button>
      </div>
      {envelope.subject && (
        <p className="text-[11px] text-gray-300 truncate">{envelope.subject}</p>
      )}
      {envelope.awaiting_recipient_name && (
        <p className="text-[11px] text-gray-400">
          Awaiting{" "}
          <span className="text-gray-200">{envelope.awaiting_recipient_name}</span>
          {envelope.awaiting_is_alex && (
            <span className="ml-1 text-orange-300">(you)</span>
          )}
          {awaitingHours !== null && (
            <span className="ml-1 text-gray-500">
              · {formatAwaiting(awaitingHours)}
            </span>
          )}
        </p>
      )}
      <div className="flex gap-2 flex-wrap items-center pt-1">
        <a
          href={envelope.deep_link_url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[11px] bg-[#30363d] hover:bg-[#3d444d] text-gray-300 px-2 py-1 rounded"
        >
          Open in DocuSign
        </a>
        {canSendReminder && (
          <button
            type="button"
            onClick={handleSendReminder}
            disabled={busy}
            className="text-[11px] bg-blue-700 hover:bg-blue-600 text-white px-2 py-1 rounded disabled:opacity-50"
          >
            {busy ? "..." : "Send reminder"}
          </button>
        )}
        {reminderStatus && (
          <span className="text-[10px] text-emerald-400">{reminderStatus}</span>
        )}
      </div>
      {error && <p className="text-[10px] text-red-400">{error}</p>}
    </div>
  );
}

function envelopeStatusColor(e: EnvelopeSummary): { border: string; text: string } {
  if (e.status === "completed") return { border: "border-emerald-800", text: "text-emerald-400" };
  if (e.status === "voided" || e.status === "declined" || e.status === "timedout") {
    return { border: "border-red-800", text: "text-red-400" };
  }
  // In-flight — orange when awaiting Alex past 24h, neutral otherwise.
  if (e.awaiting_is_alex && e.awaiting_hours !== null && e.awaiting_hours > 24) {
    return { border: "border-orange-700", text: "text-orange-400" };
  }
  return { border: "border-[#30363d]", text: "text-gray-300" };
}

function formatAwaiting(hours: number): string {
  if (hours < 1) return "<1h";
  if (hours < 24) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}
