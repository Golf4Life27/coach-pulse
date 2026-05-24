"use client";

// Read-only consumer of /api/pricing-intelligence/[zip]. Renders flipper
// vs landlord Your_MAO side-by-side. NEVER returns null silently when
// inputs are partial — surfaces the gap explicitly per the Positive
// Confirmation Principle (§Rule 5 — swallowed errors forbidden).
//
// Fallback ZIP: when propertyAddress doesn't contain a 5-digit ZIP, we
// derive a city+state-default ZIP so the pricing endpoint can still
// resolve the correct market via prefix match (cap rate, uplift). Rent
// lookup is skipped in that case because RentCast needs a real address;
// the landlord track surfaces "no rent data" rather than guessing.

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
  address: string | null;
  city: string | null;
  state: string | null;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  arv_mid: number | null;
  rehab_mid: number | null;
}

// Default ZIP per city+state combo. Used when the address string doesn't
// include a parseable ZIP. The exact ZIP doesn't matter for pricing math
// because cap_rate + uplift configs key off the 2-digit prefix (48/38/
// 78/75/77). Real addresses still go through unchanged.
const CITY_STATE_FALLBACK_ZIP: Record<string, string> = {
  "san antonio|tx": "78201",
  "dallas|tx": "75201",
  "houston|tx": "77002",
  "detroit|mi": "48201",
  "memphis|tn": "38103",
};

function normalizeState(s: string | null | undefined): string | null {
  if (!s) return null;
  const lower = s.trim().toLowerCase();
  const map: Record<string, string> = {
    texas: "tx",
    michigan: "mi",
    tennessee: "tn",
    "tx": "tx",
    "mi": "mi",
    "tn": "tn",
  };
  return map[lower] ?? (lower.length === 2 ? lower : null);
}

function resolveZip(
  address: string | null | undefined,
  city: string | null | undefined,
  state: string | null | undefined,
): { zip: string | null; source: "address" | "city_state_fallback" | "none" } {
  if (address) {
    const match = address.match(/\b(\d{5})(?:-\d{4})?\b/);
    if (match) return { zip: match[1], source: "address" };
  }
  const stateNorm = normalizeState(state);
  if (city && stateNorm) {
    const key = `${city.trim().toLowerCase()}|${stateNorm}`;
    const fallback = CITY_STATE_FALLBACK_ZIP[key];
    if (fallback) return { zip: fallback, source: "city_state_fallback" };
  }
  return { zip: null, source: "none" };
}

export default function TwoTrackPricing(props: Props) {
  const { zip, source: zipSource } = resolveZip(props.address, props.city, props.state);

  const hasArv = props.arv_mid != null && props.arv_mid > 0;
  const hasRehab = props.rehab_mid != null && props.rehab_mid >= 0;
  const canCompute = zip != null && hasArv && hasRehab;

  const [data, setData] = useState<PricingResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!canCompute || zip == null) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }

    const params = new URLSearchParams({
      arv_mid: String(props.arv_mid!),
      rehab_mid: String(props.rehab_mid!),
    });
    // Only pass address when ZIP came from the address itself; the
    // city+state fallback ZIP is not a real anchor and would mislead
    // RentCast's rent lookup.
    if (zipSource === "address" && props.address) {
      params.set("address", props.address);
    }
    if (props.city) params.set("city", props.city);
    const stateNorm = normalizeState(props.state);
    if (stateNorm) params.set("state", stateNorm.toUpperCase());
    if (props.beds != null) params.set("beds", String(props.beds));
    if (props.baths != null) params.set("baths", String(props.baths));
    if (props.sqft != null) params.set("sqft", String(props.sqft));

    let cancelled = false;
    setLoading(true);
    fetch(`/api/pricing-intelligence/${zip}?${params.toString()}`)
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(body.error || `HTTP ${res.status}`);
          setData(null);
        } else {
          setData((await res.json()) as PricingResponse);
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
    zip,
    zipSource,
    canCompute,
    props.address,
    props.city,
    props.state,
    props.beds,
    props.baths,
    props.sqft,
    props.arv_mid,
    props.rehab_mid,
  ]);

  // ── Empty-state branches (always render, never silently hide) ─────
  const missing: string[] = [];
  if (zip == null) missing.push("ZIP (not in address, city+state didn't map)");
  if (!hasArv) missing.push("ARV");
  if (!hasRehab) missing.push("Est. Repairs");

  if (!canCompute) {
    return (
      <div className="mt-3 border-t border-[#30363d] pt-3">
        <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">
          Dual-Track Pricing
        </div>
        <div className="bg-[#161b22] border border-[#30363d] rounded p-2.5 text-xs text-gray-400">
          <p className="font-semibold text-gray-300 mb-1">Setup required</p>
          <p>
            Missing: <span className="text-amber-300">{missing.join(" · ")}</span>
          </p>
          <p className="mt-1 text-[10px] text-gray-500">
            Run Phase 4A (/api/arv-validate/[recordId]) + Phase 4B (/api/photo-analysis/[recordId])
            to populate ARV + repairs.
          </p>
        </div>
      </div>
    );
  }

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
        <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">
          Dual-Track Pricing
        </div>
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
          {zipSource === "city_state_fallback" && (
            <span
              title="ZIP not in property address; using city+state default. Rent lookup skipped."
              className="ml-1 text-amber-400"
            >
              (ZIP est.)
            </span>
          )}
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
