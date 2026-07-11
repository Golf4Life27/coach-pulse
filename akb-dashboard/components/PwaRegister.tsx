"use client";

// Registers the (deliberately cache-free) service worker so the cockpit is
// installable. Failures are silent — the site works identically without it.

import { useEffect } from "react";

export default function PwaRegister() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);
  return null;
}
