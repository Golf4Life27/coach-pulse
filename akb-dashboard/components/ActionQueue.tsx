"use client";

import { useEffect, useState, useCallback } from "react";
import { ActionCard, ActionQueueResult } from "@/lib/actionQueue";
import ResponseCard from "@/components/cards/ResponseCard";
import DealCard from "@/components/cards/DealCard";
import StaleCard from "@/components/cards/StaleCard";
import DDCard from "@/components/cards/DDCard";
import { showToast } from "@/components/Toast";

function renderCard(card: ActionCard, onComplete: () => void) {
  switch (card.kind) {
    case "deal":
      return <DealCard key={card.id} card={card} onActionComplete={onComplete} />;
    case "response":
      return (
        <ResponseCard key={card.id} card={card} onActionComplete={onComplete} />
      );
    case "dd":
      return <DDCard key={card.id} card={card} onActionComplete={onComplete} />;
    case "stale":
      return (
        <StaleCard key={card.id} card={card} onActionComplete={onComplete} />
      );
  }
}

export default function ActionQueue() {
  const [queue, setQueue] = useState<ActionQueueResult | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchQueue = useCallback(async () => {
    try {
      const res = await fetch("/api/queue");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: ActionQueueResult = await res.json();
      setQueue(data);
    } catch (err) {
      showToast(`Queue fetch failed: ${err}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchQueue();
    const interval = setInterval(fetchQueue, 60_000);
    return () => clearInterval(interval);
  }, [fetchQueue]);

  if (loading) {
    return (
      <div className="bg-[#1c2128] rounded-lg border border-[#30363d] p-8 text-center text-gray-500 animate-pulse">
        Loading queue...
      </div>
    );
  }

  if (!queue) return null;

  const openCount = queue.open.length;
  const heldCount = queue.held.length;

  if (openCount === 0 && heldCount === 0) {
    return (
      <div className="bg-[#1c2128] rounded-lg border border-emerald-500/30 p-8 text-center">
        <p className="text-emerald-400 font-semibold">All clear — system is running</p>
        <p className="text-xs text-gray-500 mt-1">
          No cards in the queue. The auto-fire pipeline is doing its job.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-3">
          Action Queue ({openCount})
        </h2>
        {openCount > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {queue.open.map((card) => renderCard(card, fetchQueue))}
          </div>
        ) : (
          <div className="bg-[#1c2128] rounded-lg border border-[#30363d] p-6 text-center text-gray-500 text-sm">
            No open cards. Held items below.
          </div>
        )}
      </section>

      {heldCount > 0 && (
        <section>
          <h2 className="text-sm font-bold text-gray-500 uppercase tracking-wider mb-3">
            Held ({heldCount})
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {queue.held.map((card) => renderCard(card, fetchQueue))}
          </div>
        </section>
      )}
    </div>
  );
}
