// Back-of-funnel lane feed — the contract-lifecycle deals the operator must
// drive to close. @agent: maverick
//
// GET → every deal in a back-half Pipeline_Stage (under_contract / dispo_active
// / assignment_signed), plus a safety net for records still tagged
// Outreach_Status="Contract Signed" whose Pipeline_Stage was never advanced
// (the 3123 Sunbeam class), each mapped to its single most-pressing next move
// (verify executed contract → confirm EMD → dispo-or-terminate → run dispo →
// confirm closing). Read-only, same trust boundary as /api/live-deals: one
// filtered Airtable read, sourced numbers only, safe to poll.
//
// The items are ConveyorItem-shaped so they merge into the SAME ranked feed the
// Act Now page and Maverick dock already render — no parallel surface.

import { NextResponse } from "next/server";
import { contractLifecycleItems, isBackHalfStage, type ContractDealRow } from "@/lib/contract-lifecycle/model";

export const runtime = "nodejs";
export const maxDuration = 30;

const AIRTABLE_PAT = process.env.AIRTABLE_PAT!;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
const LISTINGS_TABLE = "tbldMjKBgPiq45Jjs";

const FIELDS = [
  "Address",
  "Pipeline_Stage",
  "Outreach_Status",
  "Contract_Offer_Price",
  "Deal_Spread",
  "Contract_Executed_At",
  "EMD_Due_At",
  "EMD_Received",
  "Option_Deadline",
  "Close_Date",
];

interface RawRecord {
  id: string;
  fields: Record<string, unknown>;
}

function str(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "name" in v) return String((v as { name?: unknown }).name ?? "") || null;
  return null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

async function fetchBackHalf(): Promise<RawRecord[]> {
  const formula =
    "OR(" +
    "{Pipeline_Stage}='under_contract'," +
    "{Pipeline_Stage}='dispo_active'," +
    "{Pipeline_Stage}='assignment_signed'," +
    "{Outreach_Status}='Contract Signed'" +
    ")";
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
  } while (offset && out.length < 300);
  return out;
}

export async function GET() {
  try {
    const records = await fetchBackHalf();
    const nowIso = new Date().toISOString();
    const rows: ContractDealRow[] = records.map((r) => {
      const pipelineStage = str(r.fields["Pipeline_Stage"]);
      const outreachStatus = str(r.fields["Outreach_Status"]);
      // Safety net for the 3123 Sunbeam class: a record still tagged
      // "Contract Signed" whose Pipeline_Stage was never advanced off a stale
      // value (e.g. dead) is coerced to under_contract so it still surfaces.
      const effectiveStage =
        isBackHalfStage(pipelineStage) ? pipelineStage : outreachStatus === "Contract Signed" ? "under_contract" : pipelineStage;
      return {
        recordId: r.id,
        address: str(r.fields["Address"]),
        pipelineStage: effectiveStage,
        contractPrice: num(r.fields["Contract_Offer_Price"]),
        dealSpread: num(r.fields["Deal_Spread"]),
        contractExecutedAt: str(r.fields["Contract_Executed_At"]),
        emdDueAt: str(r.fields["EMD_Due_At"]),
        emdReceived: r.fields["EMD_Received"] === true,
        optionDeadline: str(r.fields["Option_Deadline"]),
        closeDate: str(r.fields["Close_Date"]),
      };
    });
    const items = contractLifecycleItems(rows, nowIso);
    return NextResponse.json({ generated_at: nowIso, total: items.length, items });
  } catch (err) {
    console.error("[contract-lifecycle] error:", err);
    return NextResponse.json({ error: "contract_lifecycle_failed", detail: String(err).slice(0, 200) }, { status: 500 });
  }
}
