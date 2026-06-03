import { NextResponse } from "next/server";
import { getListings } from "@/lib/airtable";

// Defaults to the v2 active surface (INV-LEGACY-BACKSTOP). Pass
// ?include_legacy=true to include the v1 legacy backstop records.
//
// Operator-visibility filter (Spine recUS0oHqXLtEM3lG Track B,
// 2026-06-02): records at Pipeline_Stage="dead" are EXCLUDED by
// default. The dashboard's pipeline board / pipeline table consume
// from here, so flipping this single filter cleans the operator's
// default view without changes to client components. Opt-in to see
// dead records via ?include_dead=true.
//
// Pipeline_Stage is the source of truth (Spec v1, backfilled
// 2026-06-02). outreachStatus-based exclusion is intentionally NOT
// applied here — engine writes are the only legitimate "dead" signal.
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const includeLegacy = url.searchParams.get("include_legacy") === "true";
    const includeDead = url.searchParams.get("include_dead") === "true";
    const all = await getListings({ includeLegacy });
    const listings = includeDead
      ? all
      : all.filter((l) => (l.pipelineStage ?? "").trim() !== "dead");
    return NextResponse.json(listings);
  } catch (error) {
    console.error("Failed to fetch listings:", error);
    return NextResponse.json(
      { error: "Failed to fetch listings" },
      { status: 500 }
    );
  }
}
