"use client";

// DEAL ROOM — one property, everything needed to decide, nothing else.
// Sources (all existing routes): /api/listings/[id], /api/deal-dossier/[id],
// /api/conversations/[id] (the verified feed), /api/admin/audit-tail?recordId=.
// Every number renders with provenance + consequence (design law #2).
// The gate section is built to become INV-023's surface when ops ships it.

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { DD_V3_ITEMS } from "@/types/jarvis";
import { useMaverickPanel } from "../../_lib/data";
import type {
  AuditEntry,
  AuditTailResponse,
  ConversationResponse,
  DossierResponse,
  ListingDetail,
  UnifiedMessage,
} from "../../_lib/types";
import { ago, money, timeStamp } from "../../_lib/format";

export default function DealRoomPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;

  const [listing, setListing] = useState<ListingDetail | null>(null);
  const [dossier, setDossier] = useState<DossierResponse | null>(null);
  const [convo, setConvo] = useState<ConversationResponse | null>(null);
  const [trail, setTrail] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    let dead = false;
    (async () => {
      setLoading(true);
      const grab = async <T,>(url: string): Promise<T | null> => {
        try {
          const r = await fetch(url, { cache: "no-store" });
          return r.ok ? ((await r.json()) as T) : null;
        } catch {
          return null;
        }
      };
      const [l, d, c, t] = await Promise.all([
        grab<ListingDetail>(`/api/listings/${id}`),
        grab<DossierResponse>(`/api/deal-dossier/${id}`),
        grab<ConversationResponse>(`/api/conversations/${id}`),
        grab<AuditTailResponse>(`/api/admin/audit-tail?recordId=${id}&limit=1000`),
      ]);
      if (dead) return;
      if (!l) setError("Listing not found or unreachable.");
      setListing(l);
      setDossier(d);
      setConvo(c);
      setTrail(t?.ok ? t.entries : null);
      setLoading(false);
    })();
    return () => {
      dead = true;
    };
  }, [id]);

  if (loading) {
    return <div className="h-64 animate-pulse rounded-xl border border-zinc-800 bg-zinc-900/40" />;
  }
  if (error || !listing) {
    return (
      <div className="rounded-xl border border-red-900/60 bg-red-950/30 px-4 py-6 text-center text-sm text-red-300">
        {error ?? "Listing not found."}
        <div className="mt-3">
          <Link href="/v2" className="text-xs font-bold text-cyan-400 hover:underline">
            ← back to Today
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Header listing={listing} />
      <NextAction listing={listing} dossier={dossier} />
      <Numbers listing={listing} dossier={dossier} />
      <Gate listing={listing} dossier={dossier} />
      <Thread convo={convo} listing={listing} />
      <Trail trail={trail} />
    </div>
  );
}

// ── Header ───────────────────────────────────────────────────────────────

function Header({ listing }: { listing: ListingDetail }) {
  const facts = [
    listing.bedrooms != null ? `${listing.bedrooms}bd` : null,
    listing.bathrooms != null ? `${listing.bathrooms}ba` : null,
    listing.buildingSqFt != null ? `${listing.buildingSqFt.toLocaleString()}sf` : null,
    listing.yearBuilt != null ? `${listing.yearBuilt}` : null,
  ].filter(Boolean);

  return (
    <header>
      <div className="mb-1 flex items-center gap-2 text-[10px] font-bold tracking-wider">
        <Link href="/v2" className="text-zinc-600 hover:text-zinc-300">
          ← TODAY
        </Link>
        {listing.outreachStatus && (
          <span className="rounded border border-amber-800/70 px-1.5 py-px text-amber-300">
            {listing.outreachStatus.toUpperCase()}
          </span>
        )}
        {listing.pipelineStage && (
          <span className="rounded border border-zinc-700 px-1.5 py-px text-zinc-400">
            {listing.pipelineStage.toUpperCase()}
          </span>
        )}
        {listing.doNotText && (
          <span className="rounded border border-red-800 px-1.5 py-px text-red-400">DO NOT TEXT</span>
        )}
      </div>
      <h1 className="text-lg font-black leading-tight text-white">{listing.address}</h1>
      <p className="text-xs text-zinc-500">
        {[listing.city, listing.state, listing.zip].filter(Boolean).join(", ")}
        {facts.length > 0 && <span className="text-zinc-600"> · {facts.join(" · ")}</span>}
        {listing.distressBucket && <span className="text-zinc-600"> · {listing.distressBucket}</span>}
      </p>
      <p className="mt-1 text-xs text-zinc-400">
        {listing.agentName ?? "agent unknown"}
        {listing.agentPhone && <span className="font-mono text-zinc-500"> · {listing.agentPhone}</span>}
        {listing.verificationUrl && (
          <>
            {" · "}
            <a
              href={listing.verificationUrl}
              target="_blank"
              rel="noreferrer"
              className="text-cyan-400 hover:underline"
            >
              listing ↗
            </a>
          </>
        )}
      </p>
    </header>
  );
}

// ── Single recommended next action (rule-derived, reasoning shown) ───────

function NextAction({ listing, dossier }: { listing: ListingDetail; dossier: DossierResponse | null }) {
  const { openWithQuery } = useMaverickPanel();

  const inbound = listing.lastInboundAt ? new Date(listing.lastInboundAt).getTime() : 0;
  const outbound = Math.max(
    listing.lastOutboundAt ? new Date(listing.lastOutboundAt).getTime() : 0,
    listing.lastOutreachDate ? new Date(listing.lastOutreachDate).getTime() : 0,
  );
  const gate = gateItems(listing, dossier);
  const missing = gate.filter((g) => !g.ok);
  const daysSilent = outbound ? Math.floor((Date.now() - Math.max(inbound, outbound)) / 86_400_000) : null;

  let action: string;
  let why: string;
  if (inbound > outbound) {
    action = `Reply to ${listing.agentName ?? "the agent"}.`;
    why = `Inbound ${ago(listing.lastInboundAt)} is newer than our last outbound (${ago(
      listing.lastOutboundAt ?? listing.lastOutreachDate,
    )}). Negotiation cap ${money(effectiveCap(listing, dossier))} — see the numbers below for where that comes from.`;
  } else if (missing.length > 0) {
    action = `Do not advance the offer — underwrite gate is missing ${missing.length} of 4 hard items.`;
    why = `Missing: ${missing.map((m) => m.label).join(", ")}. Operator rule: comps/ARV, rehab, CMA, and buyer ceiling must ALL be present before an offer moves (SYSTEM_HANDOFF hard gate).`;
  } else if (daysSilent != null && daysSilent >= 3) {
    action = `Re-touch ${listing.agentName ?? "the agent"} — ${daysSilent} days silent.`;
    why = `Gate is complete and the thread has gone quiet. Sticky offer ${money(
      listing.outreachOfferPrice,
    )} stays the number on record.`;
  } else {
    action = "No decision needed — monitoring.";
    why = "Gate is complete and the conversation is current. The cadence engine owns the next touch.";
  }

  return (
    <section className="rounded-xl border border-cyan-900/50 bg-[#0a121a] p-3.5">
      <p className="mb-1 text-[10px] font-black tracking-[0.2em] text-cyan-400">NEXT ACTION</p>
      <p className="text-sm font-bold leading-snug text-zinc-100">{action}</p>
      <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">{why}</p>
      <div className="mt-2.5 flex gap-2">
        <button
          onClick={() => openWithQuery(listing.address)}
          className="rounded-md border border-cyan-800/70 px-2.5 py-1 text-[10px] font-bold tracking-wider text-cyan-300 hover:bg-cyan-950/40"
        >
          RECALL THIS DEAL
        </button>
        <a
          href={`/pipeline/${listing.id}`}
          className="rounded-md border border-zinc-700 px-2.5 py-1 text-[10px] font-bold tracking-wider text-zinc-500 hover:text-zinc-300"
          title="acting on the deal (send / mark / advance) still lives in v1 for now"
        >
          ACT IN V1 →
        </a>
      </div>
    </section>
  );
}

function effectiveCap(listing: ListingDetail, dossier: DossierResponse | null): number | null {
  return (
    dossier?.pessimisticMao ??
    listing.underwrittenMao ??
    listing.investorMao ??
    listing.mao ??
    null
  );
}

// ── Numbers, why-attached. No figure without provenance + consequence. ───

interface Figure {
  label: string;
  value: number | null | undefined;
  suffix?: string;
  provenance: string;
  consequence?: string;
  missing?: string; // consequence text when value is absent
}

function Numbers({ listing, dossier }: { listing: ListingDetail; dossier: DossierResponse | null }) {
  const figures: Figure[] = [
    {
      label: "LIST",
      value: listing.listPrice,
      provenance: `Airtable List_Price · DOM ${listing.dom ?? "—"}`,
    },
    {
      label: "OPENER SENT",
      value: listing.outreachOfferPrice,
      provenance: `sticky 65%-of-list captured at send (${timeStamp(listing.lastOutreachDate)}); never recomputed`,
      missing: "no opener on record — nothing has been sent on this property",
    },
    {
      label: "UNDERWRITTEN MAO",
      value: listing.underwrittenMao,
      provenance: "Underwritten_MAO — underwrite-station ceiling; the opener-vs-MAO guard reads this at send time",
      missing: "no underwrite ceiling — opener guard falls back to MAO_V1",
    },
    {
      label: "DOSSIER MAO",
      value: dossier?.found ? dossier.pessimisticMao : null,
      provenance: dossier?.found
        ? `Deal_Dossiers #${dossier.dealNumber ?? "?"} (${timeStamp(dossier.createdAt)}) · verdict ${dossier.verdict ?? "—"} · sticky floor ${money(dossier.stickyFloor)}`
        : "Deal_Dossiers",
      missing: "no dossier built — worst-case max offer hasn't been computed",
    },
    {
      label: "ARV",
      value: listing.realArvMedian,
      provenance: `${listing.arvCompCount ?? "?"} comps · ${listing.arvConfidence ?? "?"} confidence · range ${money(listing.realArvLow)}–${money(listing.realArvHigh)} · validated ${timeStamp(listing.arvValidatedAt)}`,
      consequence:
        listing.arvConfidence === "LOW" ? "LOW confidence — treat the resale ceiling as unproven" : undefined,
      missing: "no comp-backed ARV — blocks the offer gate",
    },
    {
      label: "REHAB",
      value: listing.estRehab,
      provenance: `Est_Rehab · source ${listing.rehabSource ?? "?"} · range ${money(listing.estRehabLow)}–${money(listing.estRehabHigh)} · ${timeStamp(listing.rehabEstimatedAt)}`,
      missing: "no rehab estimate — blocks the offer gate",
    },
    {
      label: "RENT",
      value: listing.estimatedMonthlyRent,
      suffix: "/mo",
      provenance: "RentCast AVM — feeds the landlord-track MAO ((rent×12)/cap − rehab − fee)",
      missing: "no rent signal — landlord track unpriced",
    },
    {
      label: "CONTRACT OFFER",
      value: listing.contractOfferPrice,
      provenance: "Contract_Offer_Price — DD-stage number; V2.1 floor, >75%-of-list trips a caution",
      missing: "unset by design until the DD gate (INV-023) sets it",
    },
  ];

  return (
    <section>
      <h2 className="mb-2 text-[11px] font-black tracking-[0.2em] text-zinc-400">THE NUMBERS</h2>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {figures.map((f) => (
          <div key={f.label} className="rounded-lg border border-zinc-800 bg-[#0b0e13] p-2.5">
            <p className="text-[9px] font-bold tracking-[0.15em] text-zinc-500">{f.label}</p>
            <p
              className={`font-mono text-base font-semibold ${
                f.value != null ? "text-zinc-100" : "text-zinc-600"
              }`}
            >
              {money(f.value)}
              {f.value != null && f.suffix ? <span className="text-[10px] text-zinc-500">{f.suffix}</span> : null}
            </p>
            <p className="mt-1 text-[9px] leading-relaxed text-zinc-600">
              {f.value != null ? f.provenance : (f.missing ?? f.provenance)}
            </p>
            {f.value != null && f.consequence && (
              <p className="mt-0.5 text-[9px] font-bold text-amber-400">{f.consequence}</p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

// ── Offer-readiness gate + DD checklist (becomes INV-023's surface) ──────

interface GateItem {
  label: string;
  ok: boolean;
  evidence: string;
}

function gateItems(listing: ListingDetail, dossier: DossierResponse | null): GateItem[] {
  return [
    {
      label: "Comps / ARV",
      ok: listing.realArvMedian != null,
      evidence:
        listing.realArvMedian != null
          ? `${money(listing.realArvMedian)} median, ${listing.arvCompCount ?? "?"} comps, ${listing.arvConfidence ?? "?"}`
          : "Real_ARV_Median empty",
    },
    {
      label: "Rehab estimate",
      ok: listing.estRehab != null,
      evidence:
        listing.estRehab != null
          ? `${money(listing.estRehab)} via ${listing.rehabSource ?? "unknown source"}`
          : "Est_Rehab empty",
    },
    {
      label: "Operator CMA",
      ok: dossier?.hasOperatorCma === true,
      evidence:
        dossier?.hasOperatorCma === true
          ? "CMA overrides present in the Deal File"
          : dossier?.found
            ? "Deal File says no operator CMA supplied"
            : "no Deal File yet",
    },
    {
      label: "Buyer ceiling",
      ok: listing.investorMao != null || listing.underwrittenMao != null,
      evidence:
        listing.investorMao != null
          ? `Investor_MAO ${money(listing.investorMao)}`
          : listing.underwrittenMao != null
            ? `Underwritten_MAO ${money(listing.underwrittenMao)}`
            : "no buyer-side ceiling on record",
    },
  ];
}

function Gate({ listing, dossier }: { listing: ListingDetail; dossier: DossierResponse | null }) {
  const hard = gateItems(listing, dossier);
  const hardOk = hard.filter((g) => g.ok).length;
  const checked = new Set(listing.ddChecklist ?? []);
  const ddDone = DD_V3_ITEMS.filter((i) => checked.has(i)).length;
  const [showDd, setShowDd] = useState(false);

  return (
    <section>
      <h2 className="mb-2 text-[11px] font-black tracking-[0.2em] text-zinc-400">
        OFFER GATE
        <span className="ml-2 font-normal tracking-normal text-zinc-600">
          hard checklist {hardOk}/4 · DD V3 {ddDone}/12 — this panel becomes INV-023&apos;s surface
        </span>
      </h2>
      <div className="grid gap-2 sm:grid-cols-2">
        {hard.map((g) => (
          <div
            key={g.label}
            className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 ${
              g.ok ? "border-emerald-900/50 bg-emerald-950/15" : "border-red-900/50 bg-red-950/15"
            }`}
          >
            <span className={`mt-0.5 text-sm ${g.ok ? "text-emerald-400" : "text-red-400"}`}>
              {g.ok ? "✓" : "✗"}
            </span>
            <div>
              <p className="text-xs font-bold text-zinc-200">{g.label}</p>
              <p className="text-[10px] leading-relaxed text-zinc-500">{g.evidence}</p>
            </div>
          </div>
        ))}
      </div>

      <button
        onClick={() => setShowDd(!showDd)}
        className="mt-2 text-[10px] font-bold tracking-wider text-zinc-600 hover:text-zinc-300"
      >
        {showDd ? "▾" : "▸"} DD V3 CHECKLIST ({ddDone}/12)
      </button>
      {showDd && (
        <div className="mt-2 grid gap-1 sm:grid-cols-2">
          {DD_V3_ITEMS.map((item) => {
            const ok = checked.has(item);
            return (
              <div key={item} className="flex items-center gap-2 rounded border border-zinc-800/70 px-2.5 py-1.5 text-[11px]">
                <span className={ok ? "text-emerald-400" : "text-zinc-700"}>{ok ? "✓" : "○"}</span>
                <span className={ok ? "text-zinc-300" : "text-zinc-500"}>{item}</span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ── The thread — verified feed (/api/conversations), strict timestamp order ─

function Thread({ convo, listing }: { convo: ConversationResponse | null; listing: ListingDetail }) {
  if (!convo) {
    return (
      <section>
        <h2 className="mb-2 text-[11px] font-black tracking-[0.2em] text-zinc-400">THREAD</h2>
        <p className="rounded-lg border border-zinc-800 px-3 py-2 text-xs text-zinc-600">
          Conversation feed unreachable right now (verified Quo + Gmail + notes merge).
        </p>
      </section>
    );
  }
  return (
    <section>
      <h2 className="mb-2 text-[11px] font-black tracking-[0.2em] text-zinc-400">
        THREAD
        <span className="ml-2 font-normal tracking-normal text-zinc-600">
          {convo.messageCount} msgs · {convo.quoCount} sms / {convo.emailCount} email / {convo.notesCount} notes —
          verified feed, each text confirmed by id
        </span>
      </h2>
      {convo.messages.length === 0 ? (
        <p className="rounded-lg border border-zinc-800 px-3 py-2 text-xs text-zinc-600">
          No messages attributed to this property yet
          {listing.agentPhone ? "" : " (no agent phone on record)"}.
        </p>
      ) : (
        <div className="space-y-1.5">
          {convo.messages.map((m) => (
            <Bubble key={m.id} m={m} />
          ))}
        </div>
      )}
    </section>
  );
}

function Bubble({ m }: { m: UnifiedMessage }) {
  const isIn = m.direction === "inbound";
  const isSys = m.direction === "system";
  return (
    <div className={`flex ${isIn ? "justify-start" : "justify-end"}`}>
      <div
        className={`max-w-[85%] rounded-lg border px-3 py-2 ${
          isSys
            ? "border-zinc-800 bg-zinc-900/40"
            : isIn
              ? "border-amber-900/50 bg-amber-950/20"
              : "border-cyan-900/50 bg-[#0a141c]"
        }`}
      >
        <p className="mb-0.5 flex items-center gap-1.5 text-[9px] font-bold tracking-wider text-zinc-600">
          <span
            className={`rounded border px-1 py-px ${
              m.source === "quo"
                ? "border-emerald-800 text-emerald-400"
                : m.source === "email"
                  ? "border-violet-800 text-violet-400"
                  : "border-zinc-700 text-zinc-500"
            }`}
          >
            {m.source === "quo" ? "SMS" : m.source.toUpperCase()}
          </span>
          {isIn ? m.from : "AKB"} · {timeStamp(m.timestamp)}
        </p>
        {m.subject && <p className="text-[11px] font-bold text-zinc-300">{m.subject}</p>}
        <p className="whitespace-pre-wrap text-xs leading-relaxed text-zinc-200">{m.body}</p>
      </div>
    </div>
  );
}

// ── Record trail — who wrote what on this record (KV audit_log) ──────────

function Trail({ trail }: { trail: AuditEntry[] | null }) {
  const [open, setOpen] = useState(false);
  if (!trail || trail.length === 0) return null;
  return (
    <section>
      <button
        onClick={() => setOpen(!open)}
        className="text-[10px] font-bold tracking-[0.15em] text-zinc-600 hover:text-zinc-300"
      >
        {open ? "▾" : "▸"} RECORD TRAIL ({trail.length} audit events in KV window)
      </button>
      {open && (
        <div className="mt-2 space-y-1">
          {trail.slice(0, 30).map((e, i) => (
            <div key={i} className="flex items-baseline gap-2 rounded border border-zinc-800/70 px-2.5 py-1.5 text-[11px]">
              <span
                className={
                  e.status === "confirmed_success"
                    ? "text-emerald-400"
                    : e.status === "confirmed_failure"
                      ? "text-red-400"
                      : "text-amber-400"
                }
              >
                ●
              </span>
              <span className="font-bold text-zinc-400">{e.agent}</span>
              <span className="text-zinc-500">{e.event}</span>
              <span className="ml-auto shrink-0 font-mono text-[10px] text-zinc-600">{timeStamp(e.ts)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
