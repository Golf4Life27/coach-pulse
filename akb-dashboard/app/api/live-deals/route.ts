// Live Deals feed — every record in an active negotiation, any era.
// @agent: maverick
//
// GET → the operator's live pipeline: records currently in a negotiation
// status (Negotiating / Response Received / Counter Received / Offer
// Accepted), REGARDLESS of source version, with sourced money (contract
// price, list, doctrine ceiling) and a ball-in-court signal. Read-only, same
// trust boundary as /api/maverick/heartbeat — one filtered Airtable read,
// minimal fields, no KV, no paid APIs, safe to poll from the dashboard.

import { NextResponse } from "next/server";
import { NEGOTIATION_STATUS_LIST, rankLiveDeals, needsYouCount, type LiveDealRow } from "@/lib/live-deals";
import { resolveDisplayOffer } from "@/lib/deal-numbers";
import { decideCounter, type CounterDecision } from "@/lib/counter-decision";

export const runtime = "nodejs";
export const maxDuration = 30;

const AIRTABLE_PAT = process.env.AIRTABLE_PAT!;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
const LISTINGS_TABLE = "tbldMjKBgPiq45Jjs";

const FIELDS = [
  "Address",
  "Outreach_Status",
  "Contract_Offer_Price",
  "Rough_Opener_Amount",
  "Outreach_Offer_Price",
  "List_Price",
  "Underwritten_MAO",
  "Underwritten_Property_MAO",
  "Last_Inbound_At",
  "Last_Outbound_At",
  "Source_Version",
  "Draft_Reply_Text",
  "Draft_Reply_Meta",
  // COUNTER DECISION CARD (2026-09-18) — the facts decideCounter needs so a
  // Counter Received row (or a freshly classified counter) gets a concrete
  // recommendation instead of a dead-end "your judgment" hold.
  "Latest_Counter_Usd",
  "Buyer_Ceiling",
  "Your_MAO_V21",
  "Decision_Verdict",
  "Real_ARV_Median",
  "ARV_Confidence",
  "Est_Rehab_Mid",
  "Agent_Name",
];

interface RawRecord {
  id: string;
  createdTime: string;
  fields: Record<string, unknown>;
}

/** Single-selects arrive as {name} or a bare string; numbers as numbers. */
function str(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "name" in v) return String((v as { name?: unknown }).name ?? "") || null;
  return null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

async function fetchNegotiations(): Promise<RawRecord[]> {
  const formula = `OR(${NEGOTIATION_STATUS_LIST.map((s) => `{Outreach_Status}='${s}'`).join(",")})`;
  const out: RawRecord[] = [];
  let offset: string | undefined;
  do {
    const p = new URLSearchParams();
    p.set("filterByFormula", formula);
    for (const f of FIELDS) p.append("fields[]", f);
    p.set("pageSize", "100");
    if (offset) p.set("offset", offset);
    const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${LISTINGS_TABLE}?${p.toString()}`, {
      headers: { Authorization: `Bearer ${AIRTABLE_PAT}` },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Airtable ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    out.push(...(data.records as RawRecord[]));
    offset = data.offset;
  } while (offset && out.length < 500);
  return out;
}

/** The Draft_Reply_Meta mirror's classification, read defensively — a
 *  malformed/absent mirror is simply "no classification", never a throw. */
function draftClassificationOf(metaRaw: string | null): string | null {
  if (!metaRaw) return null;
  try {
    const meta = JSON.parse(metaRaw) as { classification?: unknown };
    return typeof meta.classification === "string" ? meta.classification : null;
  } catch {
    return null;
  }
}

export async function GET() {
  try {
    const records = await fetchNegotiations();
    const rows: LiveDealRow[] = records.map((r) => {
      const status = str(r.fields["Outreach_Status"]);
      const listUsd = num(r.fields["List_Price"]);
      const stickyUsd = num(r.fields["Outreach_Offer_Price"]);
      const ceilingUsd = num(r.fields["Buyer_Ceiling"]) ?? num(r.fields["Your_MAO_V21"]);
      const counterUsd = num(r.fields["Latest_Counter_Usd"]);
      const verdict = str(r.fields["Decision_Verdict"]);
      const arvUsd = num(r.fields["Real_ARV_Median"]);
      const arvConfidence = str(r.fields["ARV_Confidence"]);
      const rehabUsd = num(r.fields["Est_Rehab_Mid"]);
      const agentName = str(r.fields["Agent_Name"]);
      const agentFirstName = agentName ? agentName.trim().split(/\s+/)[0] || null : null;
      const draftReplyMeta = str(r.fields["Draft_Reply_Meta"]);

      // COUNTER DECISION CARD (2026-09-18, "I am doing all the thinking
      // again"): attach a bounded, fact-based recommendation for any row
      // that IS a live counter — either its status is Counter Received, or
      // the most recent classified inbound was a counter. Best-effort: a
      // failure here must never break the live-deals feed.
      let counterDecision: CounterDecision | null = null;
      if (status === "Counter Received" || draftClassificationOf(draftReplyMeta) === "counter") {
        try {
          counterDecision = decideCounter({
            counterUsd,
            stickyUsd,
            ceilingUsd,
            verdict,
            arvUsd,
            arvConfidence,
            rehabUsd,
            listUsd,
            agentFirstName,
          });
        } catch (err) {
          console.error("[live-deals] counter-decision failed:", err);
        }
      }

      return {
        id: r.id,
        address: str(r.fields["Address"]),
        status,
        // Doctrine-safe offer resolution (P1.1): contract → value-anchored
        // rough opener → legacy outreach. Never MAO_V1 (List×0.65). The card
        // resolves from fields only (no notes fetch); the deal room adds the
        // delivery-stamp authority on top.
        contractPrice: resolveDisplayOffer({
          contractOfferPrice: num(r.fields["Contract_Offer_Price"]),
          roughOpenerAmount: num(r.fields["Rough_Opener_Amount"]),
          outreachOfferPrice: stickyUsd,
        }).amount,
        listPrice: listUsd,
        ceiling: num(r.fields["Underwritten_MAO"]) ?? num(r.fields["Underwritten_Property_MAO"]),
        lastInboundAt: str(r.fields["Last_Inbound_At"]),
        lastOutboundAt: str(r.fields["Last_Outbound_At"]),
        sourceVersion: str(r.fields["Source_Version"]),
        draftReplyText: str(r.fields["Draft_Reply_Text"]),
        draftReplyMeta,
        counterDecision,
      };
    });
    const deals = rankLiveDeals(rows);
    return NextResponse.json({
      generated_at: new Date().toISOString(),
      total: deals.length,
      needs_you: needsYouCount(deals),
      deals,
    });
  } catch (err) {
    console.error("[live-deals] error:", err);
    return NextResponse.json({ error: "live_deals_failed", detail: String(err).slice(0, 200) }, { status: 500 });
  }
}
