"use client";

// Read-only consumer of /api/pricing-intelligence/[zip]. Renders flipper
// vs landlord Your_MAO side-by-side with a recommended-track chip and
// creative-finance flag. No Airtable writes — math is fetched fresh per
// render (5-min stale-while-revalidate via fetch cache).
//
// Renders inside DealCard once we have ARV + rehab + a ZIP we can parse
// from the address. When inputs are insufficient, surfaces a tight
// explanation rather than silently dropping — Principle compliance.

import { useEffect, useState } from "react";
import { formatCurrency } from "@/lib/utils";

interface FlipperResult {
  arv: number;
  rehab: number;
  closing_costs: number;
  buyer_profit: number;
  investor_mao: number;
  wholesale_fee: number;
  your_mao: number;
}

interface LandlordResult {
  rent_monthly: number;
  gross_annual: number;
  noi: number;
  cap_rate: number;
  landlord_max_offer: number;
  rehab: number;
  closing_costs: number;
  buyer_profit: number;
  wholesale_fee: number;
  your_mao: number;
}

interface PricingResponse {
  market: string;
  recommended_track: "flipper" | "landlord" | "neither" | "tie";
  creative_finance_flag: boolean;
  flipper: FlipperResult | null;
  landlord: LandlordResult | null;
  your_mao_flipper: number | null;
  your_mao_landlord: number | null;
  delta_landlord_minus_flipper: number | null;
  methodology_notes: string[];
  rent_source: string;
  rent_error: string | null;
}

interface Props {
  zip: string;
  address: string;
  city: string | null;
  state: string | null;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  arv_mid: number;
  rehab_mid: number;
}

export default function TwoTrackPricing(props: Props) {
  const [data, setData] = useState<PricingResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const params = new URLSearchParams({
      address: props.address,
      arv_mid: String(props.arv_mid),
      rehab_mid: String(props.rehab_mid),
    });
    if (props.city) params.set("city", props.city);
    if (props.state) params.set("state", props.state);
    if (props.beds != null) params.set("beds", String(props.beds));
    if (props.baths != null) params.set("baths", String(props.baths));
    if (props.sqft != null) params.set("sqft", String(props.sqft));

    let cancelled = false;
    setLoading(true);
    fetch(`/api/pricing-intelligence/${props.zip}?${params.toString()}`)
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(body.error || `HTTP ${res.status}`);
          setData(null);
        } else {
          const json = (await res.json()) as PricingResponse;
          setData(json);
          setError(null);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setError(String(err));
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    props.zip,
    props.address,
    props.city,
    props.state,
    props.beds,
    props.baths,
    props.sqft,
    props.arv_mid,
    props.rehab_mid,
  ]);

  if (loading) {
    return (
      <div className="mt-3 border-t border-[#30363d] pt-3 text-xs text-gray-500 animate-pulse">
        Loading dual-track pricing...
      </div>
    );
  }

  if (error) {
    return (
      <div className="mt-3 border-t border-[#30363d] pt-3">
        <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Dual-Track Pricing</div>
        <div className="bg-amber-900/20 border border-amber-500/40 rounded p-2 text-xs text-amber-300">
          <span className="font-semibold">Unavailable:</span> {error}
        </div>
      </div>
    );
  }

  if (!data) return null;

  const flipperWins = data.recommended_track === "flipper";
  const landlordWins = data.recommended_track === "landlord";
  const tie = data.recommended_track === "tie";
  const neither = data.recommended_track === "neither";

  return (
    <div className="mt-3 border-t border-[#30363d] pt-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] text-gray-500 uppercase tracking-wider">
          Dual-Track Pricing · {data.market}
        </div>
        {data.creative_finance_flag && (
          <span
            title="Landlord MAO exceeds flipper MAO above threshold — seller-finance / sub-to candidate."
            className="px-2 py-0.5 rounded text-[10px] font-bold bg-purple-500/20 text-purple-300 border border-purple-500/40"
          >
            CREATIVE FIN.
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <TrackBlock
          label="Flipper"
          highlight={flipperWins}
          dimmed={landlordWins || neither}
          yourMao={data.your_mao_flipper}
          subline={
            data.flipper
              ? `Profit ${formatCurrency(data.flipper.buyer_profit)} · Fee ${formatCurrency(data.flipper.wholesale_fee)}`
              : "—"
          }
        />
        <TrackBlock
          label="Landlord"
          highlight={landlordWins}
          dimmed={flipperWins || neither}
          yourMao={data.your_mao_landlord}
          subline={
            data.landlord
              ? `Rent ${formatCurrency(data.landlord.rent_monthly)}/mo · Cap ${(data.landlord.cap_rate * 100).toFixed(1)}%`
              : data.rent_error ?? "No rent data"
          }
        />
      </div>

      <div className="mt-2 flex items-center justify-between text-[10px]">
        <span className="text-gray-500">
          {tie
            ? "Tie within $1K — either track viable"
            : neither
              ? "Neither track profitable at current inputs"
              : `Recommend ${data.recommended_track.toUpperCase()}`}
          {data.delta_landlord_minus_flipper != null && !neither && !tie && (
            <span className="text-gray-600">
              {" "}· Δ {formatCurrency(Math.abs(data.delta_landlord_minus_flipper))}
            </span>
          )}
        </span>
        <span className="text-gray-600 italic">rent: {data.rent_source}</span>
      </div>
    </div>
  );
}

function TrackBlock({
  label,
  highlight,
  dimmed,
  yourMao,
  subline,
}: {
  label: string;
  highlight: boolean;
  dimmed: boolean;
  yourMao: number | null;
  subline: string;
}) {
  const negative = yourMao != null && yourMao < 0;
  const valueColor = negative
    ? "text-red-400"
    : highlight
      ? "text-emerald-400"
      : dimmed
        ? "text-gray-500"
        : "text-white";
  const borderColor = highlight
    ? "border-emerald-500/50"
    : dimmed
      ? "border-[#30363d]/40"
      : "border-[#30363d]";

  return (
    <div
      className={`rounded border ${borderColor} bg-[#161b22] p-2 ${dimmed ? "opacity-60" : ""}`}
    >
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-[10px] text-gray-400 uppercase tracking-wider">{label}</span>
        {highlight && (
          <span className="text-[9px] text-emerald-400 font-bold">★ PICK</span>
        )}
      </div>
      <div className={`text-sm font-semibold ${valueColor}`}>
        {yourMao != null ? formatCurrency(yourMao) : "—"}
      </div>
      <div className="text-[10px] text-gray-500 mt-0.5 truncate" title={subline}>
        {subline}
      </div>
    </div>
  );
}

// Exported helper — extracts a 5-digit ZIP from the trailing portion of
// an address. Returns null if no ZIP is found. Lives here (not in
// utils.ts) because it's only used by the Two-Track render and the
// fallback semantics matter to the consumer.
export function extractZipFromAddress(addr: string | null | undefined): string | null {
  if (!addr) return null;
  const match = addr.match(/\b(\d{5})(?:-\d{4})?\b\s*$/);
  return match ? match[1] : null;
}
