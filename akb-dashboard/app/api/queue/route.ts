import { getListings, getDeals } from "@/lib/airtable";
import { buildActionQueue } from "@/lib/actionQueue";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET() {
  try {
    const [listings, deals] = await Promise.all([getListings(), getDeals()]);
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
