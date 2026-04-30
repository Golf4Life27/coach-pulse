"use client";

import { useState } from "react";
import { Listing } from "@/lib/types";
import { ALL_DD_ITEMS } from "@/lib/actionQueue";
import { formatCurrency } from "@/lib/utils";

interface Props {
  listing: Listing;
}

function Field({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex justify-between gap-4 items-start">
      <span className="text-gray-500 shrink-0">{label}</span>
      <span className="text-white text-right">{value}</span>
    </div>
  );
}

export default function PropertyDetailsPanel({ listing }: Props) {
  const [open, setOpen] = useState(false);
  const checked = new Set(listing.ddChecklist ?? []);
  const ddCount = checked.size;
  const ddTotal = ALL_DD_ITEMS.length;

  return (
    <section className="bg-[#1c2128] rounded-lg border border-[#30363d]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-[#1f242c] transition-colors"
      >
        <span className="text-sm font-bold text-gray-400 uppercase tracking-wider">
          Property Details
        </span>
        <span className="text-gray-500 text-lg leading-none">
          {open ? "−" : "+"}
        </span>
      </button>
      {open && (
        <div className="border-t border-[#30363d] p-4 space-y-3 text-sm">
          <Field label="Address" value={listing.address} />
          <Field label="Agent" value={listing.agentName ?? "—"} />
          {listing.agentPhone && (
            <Field
              label="Phone"
              value={
                <a
                  href={`tel:${listing.agentPhone}`}
                  className="text-blue-400 hover:underline"
                >
                  {listing.agentPhone}
                </a>
              }
            />
          )}
          <Field
            label="List Price"
            value={formatCurrency(listing.listPrice)}
          />
          <Field
            label="MAO"
            value={
              <span className="text-emerald-400">
                {formatCurrency(listing.mao)}
              </span>
            }
          />
          <Field label="DOM" value={listing.dom ?? "—"} />
          <Field
            label="Outreach Status"
            value={listing.outreachStatus ?? "—"}
          />
          <Field
            label="Last Contacted"
            value={
              listing.lastOutreachDate
                ? listing.lastOutreachDate.slice(0, 10)
                : "—"
            }
          />
          <Field
            label="DD Checklist"
            value={
              <div>
                <div className="text-gray-300 mb-1">
                  {ddCount}/{ddTotal} complete
                </div>
                <div className="space-y-0.5">
                  {ALL_DD_ITEMS.map((item) => (
                    <div
                      key={item}
                      className={`text-xs ${
                        checked.has(item) ? "text-emerald-400" : "text-gray-500"
                      }`}
                    >
                      {checked.has(item) ? "✓" : "·"} {item}
                    </div>
                  ))}
                </div>
              </div>
            }
          />
        </div>
      )}
    </section>
  );
}
