"use client";

// SELLER BASIS — who owns it, what they paid, what they owe. The card that
// decodes "double it" BEFORE the first offer goes out (7714 E Canfield,
// 2026-07-20: a corporate flipper with a $108,750 bridge note couldn't
// accept any number below payoff — learned after three bumps; never again).
//
// Data: /api/seller-basis/[recordId] — ATTOM ownership + open-mortgage
// intel, 7d KV cache (one paid pull per deal per week). A failed pull
// renders the reason, never a blank (Positive Confirmation on UI).

import { useCallback, useEffect, useState } from "react";

interface SellerBasisPayload {
  basis: {
    ownerName: string | null;
    corporateOwner: boolean | null;
    lastSalePrice: number | null;
    lastSaleDate: string | null;
    loanAmount: number | null;
    lender: string | null;
    loanDate: string | null;
    fetchedAt: string;
  } | null;
  read: {
    stamped_opener: number | null;
    seller_floor_hint: number | null;
    opener_below_seller_floor: boolean | null;
    basis_vs_opener: number | null;
  };
  cache?: string;
  error?: string;
  detail?: string;
}

function usd(n: number | null | undefined): string {
  return n == null ? "—" : `$${Math.round(n).toLocaleString("en-US")}`;
}

export default function SellerBasisCard({ recordId }: { recordId: string }) {
  const [data, setData] = useState<SellerBasisPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (refresh = false) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/seller-basis/${recordId}${refresh ? "?refresh=1" : ""}`);
        const body = (await res.json()) as SellerBasisPayload;
        if (!res.ok || body.error) {
          setError(body.detail ?? body.error ?? `HTTP ${res.status}`);
          setData(null);
        } else {
          setData(body);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [recordId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="bg-[#1c2128] rounded-lg border border-[#30363d] p-4 space-y-2 text-xs">
      <div className="flex justify-between items-center">
        <h3 className="text-sm font-bold text-gray-300 uppercase tracking-wider">Seller Basis</h3>
        <button
          type="button"
          onClick={() => void load(true)}
          className="text-[10px] text-gray-500 hover:text-gray-300"
          title="Fresh ATTOM pull (paid call; otherwise cached 7 days)"
        >
          Refresh
        </button>
      </div>

      {loading && <div className="text-gray-500 animate-pulse py-2">Reading the deed + lien record…</div>}

      {!loading && error && (
        <div className="text-amber-400 py-1">
          Couldn&apos;t read seller basis ({error}). Not proof of a clean seller — retry or check ATTOM entitlement.
        </div>
      )}

      {!loading && !error && !data?.basis && (
        <div className="text-gray-500 py-1">ATTOM has no usable ownership record for this parcel.</div>
      )}

      {!loading && !error && data?.basis && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <span className="text-gray-500">Owner</span>
              <p className="text-white font-medium">
                {data.basis.ownerName ?? "—"}
                {data.basis.corporateOwner ? " 🏢" : ""}
              </p>
            </div>
            <div>
              <span className="text-gray-500">They paid</span>
              <p className="text-white font-medium">
                {usd(data.basis.lastSalePrice)}
                {data.basis.lastSaleDate ? <span className="text-gray-500"> · {data.basis.lastSaleDate.slice(0, 10)}</span> : null}
              </p>
            </div>
            <div>
              <span className="text-gray-500">Open loan (original)</span>
              <p className="text-white font-medium">
                {usd(data.basis.loanAmount)}
                {data.basis.loanDate ? <span className="text-gray-500"> · {data.basis.loanDate.slice(0, 10)}</span> : null}
              </p>
            </div>
            <div>
              <span className="text-gray-500">Lender</span>
              <p className="text-white">{data.basis.lender ?? "—"}</p>
            </div>
          </div>

          {data.read.opener_below_seller_floor === true && (
            <div className="bg-red-950/40 border border-red-500/40 rounded px-2 py-1.5 text-red-300">
              ⚠ Your opener ({usd(data.read.stamped_opener)}) is BELOW their open note ({usd(data.read.seller_floor_hint)}).
              They likely cannot accept without bringing cash or a short sale — negotiate the structure, not the number.
            </div>
          )}
          {data.read.opener_below_seller_floor === false && data.read.seller_floor_hint != null && (
            <div className="bg-emerald-950/40 border border-emerald-500/30 rounded px-2 py-1.5 text-emerald-300">
              Opener clears their open note — a payoff-feasible deal on paper.
            </div>
          )}
          <p className="text-[10px] text-gray-600">
            Loan amount is the recorded ORIGINAL, an upper bound on payoff (≈payoff for bridge/interest-only notes).
            Pulled {data.basis.fetchedAt.slice(0, 10)}{data.cache === "hit" ? " (cached)" : ""}.
          </p>
        </>
      )}
    </div>
  );
}
