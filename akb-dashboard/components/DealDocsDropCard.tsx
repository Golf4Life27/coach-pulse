"use client";

// DEAL DOCS — drop an InvestorBase CSV or PropStream CMA PDF; the system
// does the reading (operator GO 2026-07-20, credential-free tier). The
// per-track evidence renders with one-tap STAMP buttons that write through
// the existing validated buyer-median endpoint — the operator's tap IS the
// manual entry the 2026-06-08 hard rule requires; the arithmetic is what
// got automated.
//
// RULED MODEL (2026-07-20, spine reczqg6SorHCL3PWb): evidence is the
// buyer's as-is ACQUISITION (flipper=Prior Sale, landlord=Most Recent),
// expressed $/sqft; the stamped dollar value = median $/sqft × the
// SUBJECT's sqft. Flat medians are context only, never stamped.

import { useCallback, useRef, useState } from "react";
import { showToast } from "@/components/Toast";

interface TrackEvidence {
  track: "flipper" | "landlord";
  n: number;
  medianPsf: number | null;
  minPsf: number | null;
  maxPsf: number | null;
  flatMedian: number | null;
  subjectSqft: number | null;
  /** medianPsf × subjectSqft — the value the Stamp writes. */
  appliedValue: number | null;
}

interface CsvResult {
  kind: "investorbase_csv";
  totalRows: number;
  flipperCount: number;
  landlordCount: number;
  subjectSqft: number | null;
  evidence: TrackEvidence[];
}

interface CmaResult {
  kind: "cma_pdf";
  extract: {
    avgSalePrice: number | null;
    compCount: number | null;
    estimatedValue: number | null;
    mortgageBalance: number | null;
    lastSalePrice: number | null;
    lastSaleDate: string | null;
    ownerName: string | null;
  };
  intelWritten: boolean;
}

type DropResult = CsvResult | CmaResult;

function usd(n: number | null | undefined): string {
  return n == null ? "—" : `$${Math.round(n).toLocaleString("en-US")}`;
}

export default function DealDocsDropCard({ recordId }: { recordId: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DropResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stamping, setStamping] = useState<string | null>(null);
  const [stamped, setStamped] = useState<Set<string>>(new Set());

  const upload = useCallback(
    async (file: File) => {
      setBusy(true);
      setError(null);
      setResult(null);
      try {
        const form = new FormData();
        form.append("file", file);
        const res = await fetch(`/api/deal-docs/${recordId}`, { method: "POST", body: form });
        const body = (await res.json()) as DropResult & { error?: string; detail?: string };
        if (!res.ok || body.error) {
          setError(body.detail ?? body.error ?? `HTTP ${res.status}`);
        } else {
          setResult(body);
          showToast("Parsed — evidence logged to the deal ledger");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [recordId],
  );

  const stampMedian = useCallback(
    async (e: TrackEvidence) => {
      // Stamp the SUBJECT-APPLIED value (median $/sqft × subject sqft) —
      // never the flat median (ruled model).
      if (e.appliedValue == null) return;
      setStamping(e.track);
      try {
        const res = await fetch(`/api/deal/${recordId}/buyer-median`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            value: e.appliedValue,
            source: "investorbase_manual",
            track: e.track,
            exportDate: new Date().toISOString().slice(0, 10),
            sampleSize: e.n,
          }),
        });
        const body = (await res.json()) as { error?: string; message?: string };
        if (!res.ok || body.error) {
          showToast(`Stamp refused: ${body.message ?? body.error ?? res.status}`);
        } else {
          setStamped((prev) => new Set(prev).add(e.track));
          showToast(`${e.track} ${usd(e.appliedValue)} stamped ($${e.medianPsf}/sqft × ${e.subjectSqft} sqft, n=${e.n})`);
        }
      } catch (err) {
        showToast(`Stamp failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setStamping(null);
      }
    },
    [recordId],
  );

  return (
    <div className="bg-[#1c2128] rounded-lg border border-[#30363d] p-4 space-y-2 text-xs">
      <h3 className="text-sm font-bold text-gray-300 uppercase tracking-wider">Deal Docs</h3>
      <p className="text-gray-500">
        Drop an InvestorBase buyers CSV or a PropStream CMA PDF — evidence parses in, provenance logs to the ledger.
      </p>
      <input
        ref={inputRef}
        type="file"
        accept=".csv,.pdf"
        className="hidden"
        onChange={(ev) => {
          const f = ev.target.files?.[0];
          if (f) void upload(f);
          ev.target.value = "";
        }}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        className="w-full min-h-[44px] rounded-lg border border-dashed border-[#3d444d] text-gray-300 hover:bg-[#161b22] disabled:opacity-50"
      >
        {busy ? "Parsing…" : "Choose file (.csv / .pdf)"}
      </button>

      {error && <div className="text-amber-400">Couldn&apos;t ingest: {error}</div>}

      {result?.kind === "investorbase_csv" && (
        <div className="space-y-2">
          <p className="text-gray-400">
            {result.totalRows} buyers · {result.flipperCount} flipper / {result.landlordCount} landlord
            {result.subjectSqft != null && <span className="text-gray-500"> · subject {result.subjectSqft.toLocaleString()} sqft</span>}
          </p>
          {result.subjectSqft == null && (
            <p className="text-amber-400">
              Subject sqft unknown — $/sqft evidence can&apos;t be applied. Fix the listing&apos;s sqft first.
            </p>
          )}
          {result.evidence.map((e) => (
            <div key={e.track} className="flex items-center justify-between bg-[#0d1117] border border-[#30363d] rounded px-2 py-1.5">
              <div>
                <span className="text-gray-500 capitalize">{e.track} acquisition</span>
                <p className="text-white font-medium">
                  {e.medianPsf != null ? `$${e.medianPsf}/sqft` : "—"}
                  {e.appliedValue != null && <> → {usd(e.appliedValue)}</>}{" "}
                  <span className="text-gray-500">(n={e.n}{e.minPsf != null ? `, $${e.minPsf}–$${e.maxPsf}/sqft` : ""})</span>
                </p>
              </div>
              <button
                type="button"
                disabled={e.appliedValue == null || stamping === e.track || stamped.has(e.track)}
                onClick={() => void stampMedian(e)}
                className="min-h-[36px] px-3 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white font-bold"
              >
                {stamped.has(e.track) ? "Stamped ✓" : stamping === e.track ? "Stamping…" : "Stamp"}
              </button>
            </div>
          ))}
          <p className="text-[10px] text-gray-600">
            As-is acquisitions (flipper=Prior Sale, landlord=Most Recent), ≤18mo, $10k–$250k, as $/sqft ×
            subject sqft. Stamping writes the validated γ-path (source=investorbase_manual + export date) —
            your tap is the ruling.
          </p>
        </div>
      )}

      {result?.kind === "cma_pdf" && (
        <div className="grid grid-cols-2 gap-2">
          <div><span className="text-gray-500">Comp avg</span><p className="text-white font-medium">{usd(result.extract.avgSalePrice)} <span className="text-gray-500">({result.extract.compCount ?? "—"} comps)</span></p></div>
          <div><span className="text-gray-500">Est. value</span><p className="text-white font-medium">{usd(result.extract.estimatedValue)}</p></div>
          <div><span className="text-gray-500">Owner</span><p className="text-white">{result.extract.ownerName ?? "—"}</p></div>
          <div><span className="text-gray-500">Open mortgage</span><p className="text-white font-medium">{usd(result.extract.mortgageBalance)}</p></div>
          <div><span className="text-gray-500">Last sale</span><p className="text-white">{usd(result.extract.lastSalePrice)}{result.extract.lastSaleDate ? ` · ${result.extract.lastSaleDate}` : ""}</p></div>
          <div><span className="text-gray-500">Property_Intel</span><p className="text-white">{result.intelWritten ? "hydrated ✓" : "not written"}</p></div>
        </div>
      )}
    </div>
  );
}
