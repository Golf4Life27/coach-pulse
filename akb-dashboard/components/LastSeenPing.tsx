"use client";

// Pings the server-side last-seen marker (KV) so the escalation cron knows
// whether the operator has actually been in the cockpit — the old
// localStorage stamp was invisible to the server. Throttled to one ping per
// 5 minutes; fires on mount and whenever the tab regains visibility.

import { useEffect } from "react";

const THROTTLE_MS = 5 * 60_000;
let lastPing = 0;

function ping() {
  const now = Date.now();
  if (now - lastPing < THROTTLE_MS) return;
  lastPing = now;
  fetch("/api/ui/last-seen", { method: "POST" }).catch(() => {});
}

export default function LastSeenPing() {
  useEffect(() => {
    ping();
    const onVisible = () => {
      if (document.visibilityState === "visible") ping();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);
  return null;
}
