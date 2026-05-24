// Browser polling convention (Phase 11.7) — visibility-gated interval.
// @agent: maverick (Phase 11.7 INSERT 5/17)
//
// Start a polling interval that only fires `onTick` when the document is
// visible, and refires immediately when the tab returns from hidden.
// Returns a cleanup function for the consumer's useEffect.
//
// Architecturally critical: backgrounded-tab `setInterval` is throttled by
// browsers (Chromium clamps to 1/min then to multi-minute cadence after
// extended background time). Without a visibility guard, an unattended
// dashboard tab continues hitting expensive server endpoints at a
// throttled-but-non-zero cadence — the exact shape of the 5/17 ~4.8M-token
// burn. See AKB_MASTER_CHECKLIST Phase 11.6.
//
// Pure-function: all browser globals (document, setInterval) are injected
// so this can be unit-tested without jsdom.

export interface VisibilityPollingDoc {
  visibilityState: DocumentVisibilityState;
  addEventListener: (type: "visibilitychange", listener: () => void) => void;
  removeEventListener: (type: "visibilitychange", listener: () => void) => void;
}

export interface VisibilityPollingDeps {
  intervalMs: number;
  onTick: () => void;
  // Browser document. Defaults to the global. Injectable for tests +
  // SSR safety (returns no-op when no document is available).
  doc?: VisibilityPollingDoc | null;
  // Timer fns. Default to globals; injectable for fake-timer tests.
  setIntervalFn?: (cb: () => void, ms: number) => unknown;
  clearIntervalFn?: (id: unknown) => void;
}

/**
 * Start a visibility-gated polling loop. Returns a cleanup function that
 * cancels the interval + removes the visibilitychange listener.
 *
 * Behavior:
 *   - Interval fires every `intervalMs`; tick invokes `onTick` only when
 *     `doc.visibilityState === "visible"`.
 *   - On `visibilitychange` to "visible", `onTick` is invoked immediately
 *     so users returning to the tab see fresh data without waiting a
 *     full interval.
 *   - When no document is available (SSR, no-DOM env), returns a no-op
 *     cleanup; `onTick` is never invoked.
 */
export function startVisibilityGatedPolling(
  deps: VisibilityPollingDeps,
): () => void {
  const doc =
    deps.doc ??
    (typeof document !== "undefined"
      ? (document as unknown as VisibilityPollingDoc)
      : null);
  if (!doc) return () => {};

  const setInt =
    deps.setIntervalFn ??
    ((cb: () => void, ms: number) =>
      setInterval(cb, ms) as unknown as unknown);
  const clearInt =
    deps.clearIntervalFn ??
    ((id: unknown) => clearInterval(id as ReturnType<typeof setInterval>));

  const tick = () => {
    if (doc.visibilityState === "visible") {
      deps.onTick();
    }
  };

  const onVisibilityChange = () => {
    if (doc.visibilityState === "visible") {
      deps.onTick();
    }
  };

  const id = setInt(tick, deps.intervalMs);
  doc.addEventListener("visibilitychange", onVisibilityChange);

  return () => {
    clearInt(id);
    doc.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
