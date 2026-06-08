// Deal File reader — the latest underwrite (Deal_Dossiers) for a property.
//
// GET /api/deal-dossier/<recordId>
//
// Wire #1 of the dashboard reconciliation (SYSTEM_HANDOFF.md): the dossier
// is written by /api/admin/build-dossier but nothing displayed it. This
// route reads the MOST RECENT Deal_Dossiers row for a source record so the
// deal page can show the verdict + worst-case max offer + full underwrite.
// Read-only; no Airtable writes.

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
const DOSSIERS_TABLE = "tblCu0rSBhd5V3g0x";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id || !id.startsWith("rec")) {
    return NextResponse.json({ error: "Invalid record id", id }, { status: 400 });
  }
  if (!AIRTABLE_PAT) {
    return NextResponse.json({ error: "airtable_not_configured" }, { status: 500 });
  }

  // Latest dossier for this source record (Created_At desc, take 1).
  const formula = `{Source_Record_Id}='${id}'`;
  const url =
    `https://api.airtable.com/v0/${BASE_ID}/${DOSSIERS_TABLE}` +
    `?filterByFormula=${encodeURIComponent(formula)}` +
    `&sort%5B0%5D%5Bfield%5D=Created_At&sort%5B0%5D%5Bdirection%5D=desc&maxRecords=1`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${AIRTABLE_PAT}` },
      cache: "no-store",
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return NextResponse.json({ error: "airtable_error", status: res.status, detail: detail.slice(0, 200) }, { status: 502 });
    }
    const data = (await res.json()) as { records?: Array<{ id: string; fields: Record<string, unknown> }> };
    const rec = data.records?.[0];
    if (!rec) return NextResponse.json({ found: false });

    const f = rec.fields;
    const mao = typeof f.Pessimistic_MAO === "number" ? f.Pessimistic_MAO : null;
    const floor = typeof f.Sticky_Floor === "number" ? f.Sticky_Floor : null;
    const markdown = typeof f.Dossier_Markdown === "string" ? f.Dossier_Markdown : null;
    // CMA signal for the offer-readiness checklist: the Deal File carries an
    // Operator-CMA section that is either populated or the explicit
    // "_no operator CMA overrides supplied_" placeholder.
    const hasOperatorCma = markdown != null
      && markdown.includes("Operator-CMA Overrides")
      && !markdown.includes("_no operator CMA overrides supplied_");
    return NextResponse.json({
      found: true,
      dossierRecordId: rec.id,
      dealNumber: typeof f.Deal_Number === "number" ? f.Deal_Number : null,
      address: typeof f.Address === "string" ? f.Address : null,
      verdict: typeof f.Verdict === "string" ? f.Verdict : null,
      pessimisticMao: mao,
      stickyFloor: floor,
      marginOverFloor: mao != null && floor != null ? mao - floor : null,
      awaiting: typeof f.Awaiting === "string" ? f.Awaiting : null,
      createdAt: typeof f.Created_At === "string" ? f.Created_At : null,
      hasOperatorCma,
      markdown,
    });
  } catch (err) {
    return NextResponse.json({ error: "fetch_failed", detail: String(err) }, { status: 500 });
  }
}
