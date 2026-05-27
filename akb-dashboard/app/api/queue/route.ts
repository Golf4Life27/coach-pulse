import { getListings, getDeals } from "@/lib/airtable";
import { buildActionQueue } from "@/lib/actionQueue";

export const runtime = "nodejs";
export const maxDuration = 30;

// Defaults to the v2 active surface (INV-LEGACY-BACKSTOP); ?include_legacy=true for the full base.
export async function GET(req: Request) {
  try {
    const includeLegacy = new URL(req.url).searchParams.get("include_legacy") === "true";
    const [listings, deals] = await Promise.all([getListings({ includeLegacy }), getDeals()]);
    const queue = buildActionQueue(listings, deals);
    return Response.json(queue);
  } catch (err) {
    console.error("[queue] error:", err);
    return Response.json(
      { error: "Failed to build queue", detail: String(err) },
      { status: 500 },
    );
  }
}
