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

export const runtime = "nodejs";
export const maxDuration = 30;

const AIRTABLE_PAT = process.env.AIRTABLE_PAT!;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
const LISTINGS_TABLE = "tbldMjKBgPiq45Jjs";

const FIELDS = [
  "Address",
  "Outreach_Status",
  "Contract_Offer_Price",
  "Outreach_Offer_Price",
  "List_Price",
  "Underwritten_MAO",
  "Underwritten_Property_MAO",
  "Last_Inbound_At",
  "Last_Outbound_At",
  "Source_Version",
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

export async function GET() {
  try {
    const records = await fetchNegotiations();
    const rows: LiveDealRow[] = records.map((r) => ({
      id: r.id,
      address: str(r.fields["Address"]),
      status: str(r.fields["Outreach_Status"]),
      contractPrice: num(r.fields["Contract_Offer_Price"]) ?? num(r.fields["Outreach_Offer_Price"]),
      listPrice: num(r.fields["List_Price"]),
      ceiling: num(r.fields["Underwritten_MAO"]) ?? num(r.fields["Underwritten_Property_MAO"]),
      lastInboundAt: str(r.fields["Last_Inbound_At"]),
      lastOutboundAt: str(r.fields["Last_Outbound_At"]),
      sourceVersion: str(r.fields["Source_Version"]),
    }));
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
