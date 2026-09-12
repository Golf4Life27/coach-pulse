"use client";

// DISPO PACKAGE PAGE (2026-09-12) — the operator's staging area for the buyer
// hunt. Behind the dashboard password like the rest of /pipeline (see
// components/AuthGate.tsx: PUBLIC_PATH_PREFIXES is /buyer-intake, /d/, /a/ —
// /pipeline is NOT in it and must not be added).
//
// Everything on this page comes from /api/dispo/package/[recordId], which
// composes it from the buyer-safe projection only. Nothing here fetches the raw
// listing, so no ARV, rehab, contract price, fee or agent detail is one careless
// edit away from a Facebook group. The print stylesheet prints the one-pager
// and nothing else.

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import DispoCopyBlock from "@/components/DispoCopyBlock";

interface DispoPackageResponse {
  ok: true;
  dealUrl: string;
  disclosure: string;
  onePager: {
    title: string;
    facts: Array<{ label: string; value: string }>;
    body: string[];
  };
  posts: {
    facebookGroup: string;
    marketplaceTitle: string;
    marketplaceDescription: string;
    dmReply: string;
    sms: string;
  };
  photos: string[];
  dispoPublic: boolean;
  contractExecutedAt: string | null;
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; detail: string }
  | { status: "ready"; pkg: DispoPackageResponse };

const PRINT_CSS = `
@media print {
  nav, .print-hide { display: none !important; }
  html, body { background: #ffffff !important; color: #000000 !important; }
  .print-sheet { background: #ffffff !important; border: none !important; color: #000000 !important; box-shadow: none !important; }
  .print-sheet * { color: #000000 !important; background: transparent !important; border-color: #999999 !important; }
  @page { margin: 0.6in; }
}
`;

function formatDate(iso: string | null): string {
  if (!iso) return "not recorded";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function DispoPackagePage() {
  const params = useParams<{ id: string }>();
  const recordId = params?.id ?? "";
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    if (!recordId) return;
    let cancelled = false;
    fetch(`/api/dispo/package/${recordId}`, { cache: "no-store", credentials: "same-origin" })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          const detail = await res
            .json()
            .then((d: { error?: string }) => d.error ?? `HTTP ${res.status}`)
            .catch(() => `HTTP ${res.status}`);
          setState({ status: "error", detail });
          return;
        }
        const pkg = (await res.json()) as DispoPackageResponse;
        setState({ status: "ready", pkg });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ status: "error", detail: String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [recordId]);

  return (
    <div className="max-w-4xl mx-auto py-2 space-y-4">
      <style>{PRINT_CSS}</style>

      <div className="print-hide">
        <Link href={`/pipeline/${recordId}`} className="text-xs text-gray-500 hover:text-gray-300">
          &larr; Back to the deal room
        </Link>
      </div>

      {state.status === "loading" && (
        <div className="text-gray-500 text-sm animate-pulse py-12 text-center">Building the package...</div>
      )}

      {state.status === "error" && (
        <div className="bg-red-500/10 border border-red-500/40 rounded px-4 py-3 text-sm text-red-300">
          Couldn&apos;t build the package ({state.detail}).
        </div>
      )}

      {state.status === "ready" && <PackageBody pkg={state.pkg} />}
    </div>
  );
}

function PackageBody({ pkg }: { pkg: DispoPackageResponse }) {
  return (
    <>
      {/* Header — says out loud whether the link the copy points at is live. */}
      <div className="bg-[#1c2128] rounded-lg border border-[#30363d] p-4 print-hide">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-bold text-white">{pkg.onePager.title}</h1>
            <p className="text-xs text-gray-500 mt-1">
              Contract executed: {formatDate(pkg.contractExecutedAt)}
            </p>
            <a
              href={pkg.dealUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-blue-400 hover:underline break-all"
            >
              {pkg.dealUrl}
            </a>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`text-[11px] font-bold px-2 py-1 rounded ${
                pkg.dispoPublic
                  ? "bg-emerald-500/20 text-emerald-400"
                  : "bg-amber-500/20 text-amber-400"
              }`}
            >
              Dispo_Public: {pkg.dispoPublic ? "on" : "off"}
            </span>
            <button
              type="button"
              onClick={() => window.print()}
              className="bg-[#30363d] hover:bg-[#3d444d] text-gray-200 text-xs px-3 py-1.5 rounded"
            >
              Print / Save as PDF
            </button>
          </div>
        </div>
        {!pkg.dispoPublic && (
          <p className="mt-3 text-[11px] text-amber-300">
            The deal link 404s for buyers until Dispo_Public is on. Post the copy after you flip it.
          </p>
        )}
      </div>

      {/* ── The one-pager. The only section that prints. ── */}
      <div className="print-sheet bg-[#1c2128] rounded-lg border border-[#30363d] p-6">
        <h2 className="text-xl font-bold text-white">{pkg.onePager.title}</h2>
        {pkg.onePager.facts.length > 0 && (
          <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-2">
            {pkg.onePager.facts.map((f) => (
              <div key={f.label} className="rounded border border-[#30363d] px-2 py-2 text-center">
                <div className="text-sm font-semibold text-white">{f.value}</div>
                <div className="text-[10px] uppercase tracking-wide text-gray-500">{f.label}</div>
              </div>
            ))}
          </div>
        )}
        <div className="mt-4 space-y-3">
          {pkg.onePager.body.map((p, i) => (
            <p
              key={i}
              className={
                i === pkg.onePager.body.length - 1
                  ? "text-[11px] leading-relaxed text-gray-500"
                  : "text-sm leading-relaxed text-gray-300"
              }
            >
              {p}
            </p>
          ))}
        </div>
      </div>

      {/* ── Channel-ready copy blocks. ── */}
      <div className="space-y-3 print-hide">
        <DispoCopyBlock
          label="Facebook group post"
          hint="Paste as-is. One group at a time, at a human pace."
          text={pkg.posts.facebookGroup}
        />
        <DispoCopyBlock label="Marketplace title" hint="80 characters max" text={pkg.posts.marketplaceTitle} />
        <DispoCopyBlock
          label="Marketplace description"
          hint="900 characters max"
          text={pkg.posts.marketplaceDescription}
        />
        <DispoCopyBlock
          label="DM reply"
          hint={'The answer to a comment of "interested"'}
          text={pkg.posts.dmReply}
        />
        <DispoCopyBlock
          label="SMS template"
          hint="Template only. Nothing on this page sends it — paste it into Quo yourself."
          text={pkg.posts.sms}
        />
      </div>

      {/* ── Photos: the buyer-safe URLs, for uploading to a post. ── */}
      <div className="bg-[#1c2128] rounded-lg border border-[#30363d] p-4 print-hide">
        <h3 className="text-sm font-bold text-gray-300 uppercase tracking-wider mb-3">
          Photos ({pkg.photos.length})
        </h3>
        {pkg.photos.length === 0 ? (
          <p className="text-xs text-gray-500">
            No photos on the record yet. A post with no photos gets scrolled past.
          </p>
        ) : (
          <div className="space-y-2">
            {pkg.photos.map((url) => (
              <div key={url} className="flex items-center gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={url} alt="" className="h-14 w-20 flex-shrink-0 object-cover rounded bg-[#0d1117]" />
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-blue-400 hover:underline break-all"
                >
                  {url}
                </a>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
