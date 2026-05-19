// Phase 14 / Phase 10 P.4 — Voice-drift detector.
//
// Reads recent synthesizer audit events (events ending in
// `_synthesized` or matching the migration event labels) and surfaces
// three drift classes:
//
//   1. model_fallback — Anthropic served a different model than the
//      registry specified. The synthesizer's audit row sets
//      outputSummary.model_matches_registry: false when this happens.
//      Trigger: quota fallback, model deprecation routing, Anthropic
//      overload substitution. Operator may need to confirm pricing /
//      capability didn't shift.
//
//   2. disabled_agent_invoked — A migration accidentally points at a
//      registered-but-disabled voice entry. Surfaces as a synthesizer
//      confirmed_failure with the "disabled" error. Pulse promotes
//      to critical immediately — disabled entries shouldn't be hit.
//
//   3. missing_registry_entry — A synthesize() call referenced an
//      agent name without a registry entry. Caught at type-check
//      time by VoiceAgent union, but defensive at runtime: an
//      audit event with agent matching the synthesizer suffix
//      pattern but no entry in VOICE_REGISTRY.

import type { AuditEntry } from "@/lib/audit-log";
import { VOICE_REGISTRY, type VoiceAgent } from "@/lib/maverick/voice-registry";
import type { PulseDetection, PulseSeverity } from "../types";
import type { PulseDetectorInput } from "../detector-input";

const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_FALLBACK_WARNING_COUNT = 1;
const DEFAULT_FALLBACK_CRITICAL_COUNT = 5;
const SYNTHESIZED_SUFFIX = "_synthesized";

function readWindow(env: Record<string, string | undefined>): number {
  const raw = env.PULSE_VOICE_DRIFT_WINDOW_HOURS;
  if (!raw) return DEFAULT_WINDOW_HOURS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WINDOW_HOURS;
  return n;
}

function readIntThreshold(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

/** Pure: filter audit events to those produced by the synthesizer
 *  within the rolling window. Match by event suffix (_synthesized)
 *  OR by the explicit overrides used during P.2 migration. */
export function filterSynthesizerEvents(
  audit: AuditEntry[],
  windowHours: number,
  now: Date,
): AuditEntry[] {
  const cutoff = now.getTime() - windowHours * 3_600_000;
  const explicitLabels = new Set([
    "jarvis_brief_synthesized",
    "maverick_chat_synthesized",
    "rehab_calibrated",
    "sentinel_classified",
    "sentinel_drafted",
    "crier_reply_drafted",
    "scout_warmup_drafted",
    "scout_outreach_drafted",
  ]);
  return audit.filter((e) => {
    const t = new Date(e.ts).getTime();
    if (!Number.isFinite(t) || t < cutoff) return false;
    if (e.event.endsWith(SYNTHESIZED_SUFFIX)) return true;
    if (explicitLabels.has(e.event)) return true;
    return false;
  });
}

interface FallbackSample {
  agent: string;
  expected_model: string;
  actual_model: string;
  ts: string;
  event: string;
}

/** Pure: scan synthesizer events for model-fallback signals.
 *  outputSummary.model_matches_registry === false is the canonical
 *  signal. Returns samples grouped by agent. */
export function findModelFallbacks(events: AuditEntry[]): FallbackSample[] {
  const out: FallbackSample[] = [];
  for (const e of events) {
    if (e.status !== "confirmed_success") continue;
    const out_ = e.outputSummary as Record<string, unknown> | undefined;
    if (!out_) continue;
    if (out_.model_matches_registry !== false) continue;
    const expected = (e.inputSummary as Record<string, unknown> | undefined)?.model;
    const actual = out_.actual_model;
    if (typeof expected !== "string" || typeof actual !== "string") continue;
    out.push({
      agent: e.agent,
      expected_model: expected,
      actual_model: actual,
      ts: e.ts,
      event: e.event,
    });
  }
  return out;
}

/** Pure: scan synthesizer events for invocations of disabled
 *  agents. The synthesizer's getVoiceEntry throws "disabled" error
 *  string when this happens; the failure audit captures it. */
export function findDisabledAgentInvocations(events: AuditEntry[]): Array<{
  agent: string;
  ts: string;
  event: string;
}> {
  const out: Array<{ agent: string; ts: string; event: string }> = [];
  for (const e of events) {
    if (e.status !== "confirmed_failure") continue;
    const error =
      (e.outputSummary as Record<string, unknown> | undefined)?.error;
    if (typeof error !== "string") continue;
    if (!error.toLowerCase().includes("disabled")) continue;
    out.push({ agent: e.agent, ts: e.ts, event: e.event });
  }
  return out;
}

/** Pure: scan synthesizer events for invocations against unknown
 *  agents (no registry entry). Belt-and-suspenders — type system
 *  catches this at compile time, but runtime defense in case of
 *  union-type bypass or string-coerced caller. */
export function findMissingRegistryEntries(events: AuditEntry[]): Array<{
  agent: string;
  ts: string;
}> {
  const knownAgents = new Set(Object.keys(VOICE_REGISTRY) as VoiceAgent[]);
  const seen = new Map<string, string>();
  for (const e of events) {
    if (knownAgents.has(e.agent as VoiceAgent)) continue;
    if (!seen.has(e.agent)) seen.set(e.agent, e.ts);
  }
  return Array.from(seen, ([agent, ts]) => ({ agent, ts }));
}

export function detectVoiceDrift(input: PulseDetectorInput): PulseDetection[] {
  const windowHours = readWindow(input.env);
  const events = filterSynthesizerEvents(input.audit_log, windowHours, input.now());
  const fires: PulseDetection[] = [];

  // ── 1. Model-fallback class ─────────────────────────────────────────
  const fallbacks = findModelFallbacks(events);
  if (fallbacks.length > 0) {
    const warningCount = readIntThreshold(
      input.env,
      "PULSE_VOICE_DRIFT_FALLBACK_WARNING",
      DEFAULT_FALLBACK_WARNING_COUNT,
    );
    const criticalCount = readIntThreshold(
      input.env,
      "PULSE_VOICE_DRIFT_FALLBACK_CRITICAL",
      DEFAULT_FALLBACK_CRITICAL_COUNT,
    );
    if (fallbacks.length >= warningCount) {
      const severity: PulseSeverity =
        fallbacks.length >= criticalCount ? "critical" : "warning";
      const byAgent: Record<string, number> = {};
      for (const f of fallbacks) byAgent[f.agent] = (byAgent[f.agent] ?? 0) + 1;
      fires.push({
        id: "voice_drift_model_fallback",
        detector_id: "voice_drift",
        severity,
        title: `${fallbacks.length} model fallback${fallbacks.length === 1 ? "" : "s"} in ${windowHours}h (Anthropic served non-registry model)`,
        description: `Anthropic returned a model different from what the registry specified. Per-agent counts: ${Object.entries(byAgent).map(([a, c]) => `${a}=${c}`).join(", ")}. Common causes: quota fallback (Opus → Sonnet on overload), model deprecation routing, capacity-driven substitution. Operator should confirm pricing + capability shifts haven't impacted output quality.`,
        suggested_action:
          severity === "critical"
            ? "Investigate Anthropic dashboard for quota / overload alerts. Confirm output quality hasn't regressed on the affected agent(s). Update voice-registry to the fallback model if the substitution is permanent."
            : "Watch for next scan. If fallback rate climbs, escalate to investigation.",
        detected_at: input.now().toISOString(),
        source_data: {
          window_hours: windowHours,
          fallback_count: fallbacks.length,
          per_agent: byAgent,
          warning_threshold: warningCount,
          critical_threshold: criticalCount,
          // Cap sample to keep audit row + Spine row size bounded.
          sample: fallbacks.slice(0, 5),
        },
      });
    }
  }

  // ── 2. Disabled-agent-invoked class (always critical) ──────────────
  const disabled = findDisabledAgentInvocations(events);
  if (disabled.length > 0) {
    const byAgent: Record<string, number> = {};
    for (const d of disabled) byAgent[d.agent] = (byAgent[d.agent] ?? 0) + 1;
    fires.push({
      id: "voice_drift_disabled_agent",
      detector_id: "voice_drift",
      severity: "critical",
      title: `Disabled agent invoked ${disabled.length} time${disabled.length === 1 ? "" : "s"} (migration mistake)`,
      description: `A synthesize() call referenced a voice-registry entry marked disabled. Per-agent counts: ${Object.entries(byAgent).map(([a, c]) => `${a}=${c}`).join(", ")}. Disabled entries should never be hit; this signals a migration mistake or a regression that needs immediate code-level investigation.`,
      suggested_action:
        "Locate the call site by grep'ing for the agent name + synthesize(). Either enable the registry entry (if the agent is now in scope) or fix the call site to point at the correct agent.",
      detected_at: input.now().toISOString(),
      source_data: {
        window_hours: windowHours,
        invocation_count: disabled.length,
        per_agent: byAgent,
        sample: disabled.slice(0, 5),
      },
    });
  }

  // ── 3. Missing-registry-entry class (always critical) ─────────────
  const missing = findMissingRegistryEntries(events);
  if (missing.length > 0) {
    fires.push({
      id: "voice_drift_missing_registry",
      detector_id: "voice_drift",
      severity: "critical",
      title: `${missing.length} synthesizer call${missing.length === 1 ? "" : "s"} against unknown agent (no registry entry)`,
      description: `An audit event tagged as a synthesizer call uses an agent name not present in VOICE_REGISTRY: ${missing.map((m) => m.agent).join(", ")}. This should be caught by the VoiceAgent type union at compile time, so runtime occurrence indicates either a string-coerced caller bypassed the type system or a registry deletion left orphaned calls.`,
      suggested_action: "Add the missing registry entry OR fix the caller to use a registered agent name. Audit recent commits for voice-registry deletions.",
      detected_at: input.now().toISOString(),
      source_data: {
        window_hours: windowHours,
        missing,
      },
    });
  }

  return fires;
}
