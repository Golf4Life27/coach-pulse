"use client";

// PUBLIC DEAL PAGE (2026-09-05) — the buyer-facing page for one deal. Reached
// via a link Alex texts/emails to wholesale buyers; no login. Data comes
// from /api/public/deal/[recordId] (server-side allowlist — see
// lib/dispo/public-deal.ts). This component renders ONLY what that endpoint
// returns; it must never fetch or display anything else about the listing.
//
// Deliberately NOT the dashboard palette: white/neutral, big touch targets,
// legible on a phone held by someone who has never seen this app before.
// components/Navigation.tsx and components/MobileTabBar.tsx return null on
// this path (see those files); this wrapper also escapes the dashboard
// shell's dark body + centered-column layout with a fixed full-viewport
// panel, since app/layout.tsx is shared with the authenticated dashboard
// and out of scope here.

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { formatCurrency } from "@/lib/utils";

interface PublicDealView {
  recordId: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  yearBuilt: number | null;
  propertyType: string | null;
  assignmentPrice: number | null;
  optionDeadline: string | null;
  closeDate: string | null;
  photos: string[];
  headline: string;
}

type LoadState =
  | { status: "loading" }
  | { status: "not_found" }
  | { status: "error" }
  | { status: "ready"; deal: PublicDealView };

function formatDateLong(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Whole days from today (local, midnight-to-midnight) to the deadline. */
function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const target = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(target.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

function factList(deal: PublicDealView): { label: string; value: string }[] {
  const facts: { label: string; value: string }[] = [];
  if (deal.beds != null) facts.push({ label: "Beds", value: String(deal.beds) });
  if (deal.baths != null) facts.push({ label: "Baths", value: String(deal.baths) });
  if (deal.sqft != null) facts.push({ label: "Sq Ft", value: deal.sqft.toLocaleString() });
  if (deal.yearBuilt != null) facts.push({ label: "Year Built", value: String(deal.yearBuilt) });
  if (deal.propertyType) facts.push({ label: "Type", value: deal.propertyType });
  return facts;
}

export default function PublicDealPage() {
  const params = useParams<{ recordId: string }>();
  const recordId = params?.recordId ?? "";
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [activePhoto, setActivePhoto] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (!recordId) return;
    fetch(`/api/public/deal/${recordId}`, { cache: "no-store" })
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 404) {
          setState({ status: "not_found" });
          return;
        }
        if (!res.ok) {
          setState({ status: "error" });
          return;
        }
        const deal = (await res.json()) as PublicDealView;
        setState({ status: "ready", deal });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [recordId]);

  return (
    <div
      className="fixed inset-0 z-[60] overflow-y-auto bg-white text-neutral-900"
      style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}
    >
      {state.status === "loading" && (
        <div className="flex min-h-full items-center justify-center px-6 py-24 text-neutral-400">
          Loading deal…
        </div>
      )}

      {state.status === "not_found" && (
        <div className="flex min-h-full flex-col items-center justify-center gap-2 px-6 py-24 text-center">
          <p className="text-lg font-semibold text-neutral-800">This deal isn&apos;t available.</p>
          <p className="text-sm text-neutral-500">It may have sold or the link may be out of date.</p>
        </div>
      )}

      {state.status === "error" && (
        <div className="flex min-h-full flex-col items-center justify-center gap-2 px-6 py-24 text-center">
          <p className="text-lg font-semibold text-neutral-800">Something went wrong.</p>
          <p className="text-sm text-neutral-500">Please try reloading this page.</p>
        </div>
      )}

      {state.status === "ready" && <DealBody deal={state.deal} activePhoto={activePhoto} setActivePhoto={setActivePhoto} />}
    </div>
  );
}

function DealBody({
  deal,
  activePhoto,
  setActivePhoto,
}: {
  deal: PublicDealView;
  activePhoto: number;
  setActivePhoto: (i: number) => void;
}) {
  const facts = factList(deal);
  const closeDateLabel = formatDateLong(deal.closeDate);
  const optionDaysLeft = daysUntil(deal.optionDeadline);
  const optionDeadlineLabel = formatDateLong(deal.optionDeadline);

  return (
    <div className="mx-auto max-w-xl pb-16">
      {/* Photo gallery — graceful empty state: address only, no broken art */}
      {deal.photos.length > 0 ? (
        <div>
          <div className="aspect-[4/3] w-full bg-neutral-100">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={deal.photos[activePhoto] ?? deal.photos[0]}
              alt={deal.address}
              className="h-full w-full object-cover"
            />
          </div>
          {deal.photos.length > 1 && (
            <div className="flex gap-2 overflow-x-auto px-4 py-3">
              {deal.photos.map((url, i) => (
                <button
                  key={url + i}
                  type="button"
                  onClick={() => setActivePhoto(i)}
                  className={`h-16 w-20 flex-shrink-0 overflow-hidden rounded-lg border-2 ${
                    i === activePhoto ? "border-emerald-600" : "border-transparent"
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={url} alt="" className="h-full w-full object-cover" />
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="flex aspect-[4/3] w-full items-center justify-center bg-neutral-100">
          <p className="px-6 text-center text-sm text-neutral-400">Photos coming soon</p>
        </div>
      )}

      <div className="px-4 pt-5">
        <h1 className="text-xl font-bold leading-snug text-neutral-900">{deal.headline}</h1>
        <p className="mt-1 text-sm text-neutral-500">
          {[deal.city, deal.state, deal.zip].filter(Boolean).join(", ")}
        </p>

        {/* Facts row */}
        {facts.length > 0 && (
          <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-5">
            {facts.map((f) => (
              <div key={f.label} className="rounded-lg bg-neutral-50 px-2 py-2.5 text-center">
                <div className="text-sm font-semibold text-neutral-900">{f.value}</div>
                <div className="text-[10px] uppercase tracking-wide text-neutral-400">{f.label}</div>
              </div>
            ))}
          </div>
        )}

        {/* Price block */}
        <div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-4">
          <div className="text-2xl font-extrabold text-emerald-900">
            {formatCurrency(deal.assignmentPrice)}
          </div>
          <div className="mt-1 text-sm font-medium text-emerald-800">
            Cash &middot; As-is{closeDateLabel ? ` · Close by ${closeDateLabel}` : ""}
          </div>
          {optionDeadlineLabel && (
            <div className="mt-2 text-xs text-emerald-700">
              Inspection period ends {optionDeadlineLabel}
              {optionDaysLeft != null && (
                <span className="ml-1 font-semibold">
                  {optionDaysLeft > 0
                    ? `— ${optionDaysLeft} day${optionDaysLeft === 1 ? "" : "s"} left`
                    : optionDaysLeft === 0
                      ? "— today"
                      : "— closed"}
                </span>
              )}
            </div>
          )}
        </div>

        <IntakeForm deal={deal} />
      </div>
    </div>
  );
}

function IntakeForm({ deal }: { deal: PublicDealView }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/buyers/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          email,
          phone: phone || undefined,
          targetZips: deal.zip || undefined,
          maxPrice: maxPrice ? Number(maxPrice) : undefined,
          notes: `Deal page: ${deal.address}${message ? ` — ${message}` : ""}`,
        }),
      });
      if (!res.ok) {
        setError("Couldn't submit — please try again.");
        return;
      }
      setSubmitted(true);
    } catch {
      setError("Couldn't submit — please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <div className="mt-6 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-6 text-center">
        <p className="text-base font-semibold text-emerald-900">
          Got it — Alex will text you the details.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mt-6 space-y-3 border-t border-neutral-100 pt-5">
      <h2 className="text-sm font-bold uppercase tracking-wide text-neutral-500">
        Interested? Get the details
      </h2>
      <input
        type="text"
        required
        placeholder="Full name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="w-full rounded-lg border border-neutral-300 px-3 py-3 text-base text-neutral-900 placeholder-neutral-400 focus:border-emerald-500 focus:outline-none"
      />
      <input
        type="email"
        required
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="w-full rounded-lg border border-neutral-300 px-3 py-3 text-base text-neutral-900 placeholder-neutral-400 focus:border-emerald-500 focus:outline-none"
      />
      <input
        type="tel"
        placeholder="Phone (optional)"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        className="w-full rounded-lg border border-neutral-300 px-3 py-3 text-base text-neutral-900 placeholder-neutral-400 focus:border-emerald-500 focus:outline-none"
      />
      <input
        type="number"
        placeholder="Max price for this deal (optional)"
        value={maxPrice}
        onChange={(e) => setMaxPrice(e.target.value)}
        className="w-full rounded-lg border border-neutral-300 px-3 py-3 text-base text-neutral-900 placeholder-neutral-400 focus:border-emerald-500 focus:outline-none"
      />
      <textarea
        placeholder="Message (optional)"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        rows={3}
        className="w-full rounded-lg border border-neutral-300 px-3 py-3 text-base text-neutral-900 placeholder-neutral-400 focus:border-emerald-500 focus:outline-none"
      />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded-lg bg-emerald-600 py-3.5 text-base font-semibold text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
      >
        {submitting ? "Submitting…" : "I want this deal"}
      </button>
    </form>
  );
}
