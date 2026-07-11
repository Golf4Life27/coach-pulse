"use client";

// /queue — the same ONE conveyor as the landing (operator 2026-07-11:
// "merge the priorities strip, Act Now, and queue into a single feed").
// The route stays alive for deep links and muscle memory; the surface is
// identical by construction — one feed, one contract.

import ConveyorFeed from "@/components/conveyor/ConveyorFeed";

export default function QueuePage() {
  return (
    <div className="space-y-6">
      <ConveyorFeed />
    </div>
  );
}
