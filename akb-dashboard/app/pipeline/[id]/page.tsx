"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { Listing } from "@/lib/types";
import { parseConversation } from "@/lib/notes";
import ConversationThread from "@/components/ConversationThread";
import PropertyDetailsPanel from "@/components/PropertyDetailsPanel";

export default function PipelineDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const id = params?.id;
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    fetch(`/api/listings/${id}`)
      .then((r) =>
        r.ok ? r.json() : r.json().then((d) => Promise.reject(d.error ?? `HTTP ${r.status}`)),
      )
      .then((data: Listing) => {
        if (!cancelled) setListing(data);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [params?.id]);

  if (loading) {
    return (
      <div className="text-gray-400 animate-pulse py-20 text-center">
        Loading...
      </div>
    );
  }

  if (error || !listing) {
    return (
      <div className="py-20 text-center">
        <p className="text-red-400 mb-4">{error ?? "Listing not found"}</p>
        <button
          type="button"
          onClick={() => router.back()}
          className="text-blue-400 hover:underline text-sm"
        >
          ← back
        </button>
      </div>
    );
  }

  const entries = parseConversation(listing.notes);

  return (
    <div className="space-y-6">
      <div>
        <button
          type="button"
          onClick={() => router.back()}
          className="text-xs text-gray-500 hover:text-gray-300 mb-2"
        >
          ← back
        </button>
        <h1 className="text-xl font-bold text-white">{listing.address}</h1>
        <p className="text-gray-500 text-sm">
          {listing.city ?? ""}
          {listing.state ? `, ${listing.state}` : ""}
          {listing.zip ? ` ${listing.zip}` : ""}
        </p>
      </div>

      <section className="bg-[#1c2128] rounded-lg border border-[#30363d] p-4">
        <h2 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-4">
          Conversation
        </h2>
        <ConversationThread entries={entries} />
      </section>

      <PropertyDetailsPanel listing={listing} />
    </div>
  );
}
