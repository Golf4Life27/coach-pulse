import { describe, it, expect, vi } from "vitest";
import {
  startVisibilityGatedPolling,
  type VisibilityPollingDoc,
} from "./visibility-polling";

function makeFakeDoc(initial: DocumentVisibilityState = "visible"): {
  doc: VisibilityPollingDoc;
  setVisibility: (s: DocumentVisibilityState) => void;
  listeners: Array<() => void>;
} {
  let state: DocumentVisibilityState = initial;
  const listeners: Array<() => void> = [];
  const doc: VisibilityPollingDoc = {
    get visibilityState() {
      return state;
    },
    addEventListener: (_t, cb) => {
      listeners.push(cb);
    },
    removeEventListener: (_t, cb) => {
      const i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
  return {
    doc,
    setVisibility: (s) => {
      state = s;
    },
    listeners,
  };
}

function makeFakeTimers() {
  const intervals: Array<{ id: number; cb: () => void; ms: number }> = [];
  let nextId = 1;
  return {
    setIntervalFn: (cb: () => void, ms: number) => {
      const entry = { id: nextId++, cb, ms };
      intervals.push(entry);
      return entry.id;
    },
    clearIntervalFn: (id: unknown) => {
      const i = intervals.findIndex((e) => e.id === id);
      if (i >= 0) intervals.splice(i, 1);
    },
    tickAll: () => {
      // Snapshot so cleanup during a tick can't mutate iteration.
      [...intervals].forEach((e) => e.cb());
    },
    intervals,
  };
}

describe("startVisibilityGatedPolling", () => {
  it("invokes onTick when interval fires and document is visible", () => {
    const onTick = vi.fn();
    const { doc } = makeFakeDoc("visible");
    const timers = makeFakeTimers();
    startVisibilityGatedPolling({
      intervalMs: 90_000,
      onTick,
      doc,
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });

    timers.tickAll();
    timers.tickAll();

    expect(onTick).toHaveBeenCalledTimes(2);
  });

  it("does NOT invoke onTick when interval fires and document is hidden", () => {
    const onTick = vi.fn();
    const { doc } = makeFakeDoc("hidden");
    const timers = makeFakeTimers();
    startVisibilityGatedPolling({
      intervalMs: 90_000,
      onTick,
      doc,
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });

    timers.tickAll();
    timers.tickAll();
    timers.tickAll();

    expect(onTick).not.toHaveBeenCalled();
  });

  it("invokes onTick immediately when tab returns from hidden to visible", () => {
    const onTick = vi.fn();
    const { doc, setVisibility, listeners } = makeFakeDoc("hidden");
    const timers = makeFakeTimers();
    startVisibilityGatedPolling({
      intervalMs: 90_000,
      onTick,
      doc,
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });

    // Hidden → no tick fires.
    timers.tickAll();
    expect(onTick).not.toHaveBeenCalled();

    // Tab returns to foreground.
    setVisibility("visible");
    listeners.forEach((l) => l());

    expect(onTick).toHaveBeenCalledTimes(1);
  });

  it("does NOT invoke onTick on visibilitychange to hidden", () => {
    const onTick = vi.fn();
    const { doc, setVisibility, listeners } = makeFakeDoc("visible");
    const timers = makeFakeTimers();
    startVisibilityGatedPolling({
      intervalMs: 90_000,
      onTick,
      doc,
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });

    setVisibility("hidden");
    listeners.forEach((l) => l());

    expect(onTick).not.toHaveBeenCalled();
  });

  it("cleanup cancels the interval AND removes the visibilitychange listener", () => {
    const onTick = vi.fn();
    const { doc, listeners, setVisibility } = makeFakeDoc("visible");
    const timers = makeFakeTimers();
    const cleanup = startVisibilityGatedPolling({
      intervalMs: 90_000,
      onTick,
      doc,
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });

    expect(timers.intervals.length).toBe(1);
    expect(listeners.length).toBe(1);

    cleanup();

    expect(timers.intervals.length).toBe(0);
    expect(listeners.length).toBe(0);

    // Post-cleanup activity must be a no-op.
    timers.tickAll();
    setVisibility("hidden");
    setVisibility("visible");
    expect(onTick).not.toHaveBeenCalled();
  });

  it("returns a no-op when no document is available (SSR safety)", () => {
    const onTick = vi.fn();
    const timers = makeFakeTimers();
    const cleanup = startVisibilityGatedPolling({
      intervalMs: 90_000,
      onTick,
      doc: null,
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });

    expect(timers.intervals.length).toBe(0);
    cleanup(); // must not throw
    expect(onTick).not.toHaveBeenCalled();
  });

  it("burn-scenario regression: a 48hr backgrounded tab invokes onTick zero times", () => {
    // Simulates Alex's Saturday-Sunday scenario: tab opens visible, gets
    // backgrounded immediately, sits hidden for 48 hours. Browser-throttled
    // ticks fire every few minutes the entire time. Visibility guard must
    // result in zero onTick invocations until the tab is re-foregrounded.
    const onTick = vi.fn();
    const { doc, setVisibility, listeners } = makeFakeDoc("visible");
    const timers = makeFakeTimers();
    startVisibilityGatedPolling({
      intervalMs: 90_000,
      onTick,
      doc,
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });

    // User backgrounds the tab.
    setVisibility("hidden");
    listeners.forEach((l) => l());
    expect(onTick).not.toHaveBeenCalled();

    // Simulate ~48hr of browser-throttled ticks (480 cycles in the real
    // burn). Pre-fix: each would have invoked onTick. Post-fix: zero.
    for (let i = 0; i < 500; i++) timers.tickAll();
    expect(onTick).not.toHaveBeenCalled();

    // User returns to tab on Monday.
    setVisibility("visible");
    listeners.forEach((l) => l());
    expect(onTick).toHaveBeenCalledTimes(1);
  });
});
