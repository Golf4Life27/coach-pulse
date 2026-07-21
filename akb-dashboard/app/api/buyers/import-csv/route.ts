// Nightly / bulk InvestorBase buyers import. Thin route over the shared
// importer (lib/buyer-intel/buyers-import) — one code path with the per-deal
// Deal Docs drop, so the two never diverge.

import { NextResponse } from "next/server";
import { importInvestorBaseBuyers } from "@/lib/buyer-intel/buyers-import";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: Request) {
  let csvText: string;
  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("multipart/form-data")) {
    try {
      const formData = await req.formData();
      const file = formData.get("file");
      if (!file || typeof file === "string") {
        return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
      }
      csvText = await (file as Blob).text();
    } catch (err) {
      return NextResponse.json({ error: "Failed to read upload", detail: String(err) }, { status: 400 });
    }
  } else {
    csvText = await req.text();
  }

  if (!csvText.trim()) {
    return NextResponse.json({ error: "Empty CSV" }, { status: 400 });
  }

  let result;
  try {
    result = await importInvestorBaseBuyers(csvText);
  } catch (err) {
    return NextResponse.json({ error: "Airtable upsert failed", detail: String(err) }, { status: 502 });
  }

  if (result.total === 0 && result.errors.some((e) => e.reason.startsWith("csv_parse_failed"))) {
    return NextResponse.json({ error: "CSV parse failed", details: result.errors }, { status: 400 });
  }

  return NextResponse.json({
    total: result.total,
    created: result.created,
    updated: result.updated,
    skipped: result.skipped,
    errors: result.errors,
  });
}
