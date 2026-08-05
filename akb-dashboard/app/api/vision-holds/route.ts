// Vision holds — the conveyor's "vision couldn't read the house" lane.
// @agent: appraiser
//
// GET /api/vision-holds → { items: VisionHoldRow[] }
//
// Returns ONLY Vision_Queue_State = "vision_failed": records where an opener
// held because its rehab would have been a 30%-of-ARV guess (the 256
// Westchester defect), the drain cron then tried vision, and vision could not
// resolve it — no photos, or the call threw.
//
// `needs_vision` is deliberately NOT returned. Those are machine work: the
// opener-vision-drain cron clears them twice a day with nobody looking, and
// surfacing them would recreate the exact pile this lane exists to prevent.
// The surface's own law is "if it renders, it needs you."
//
// Read-only. Auth mirrors the other conveyor sources (dashboard cookie /
// CRON_SECRET / OAuth waterfall).

import { NextResponse } from "next/server";
import { getListings } from "@/lib/airtable";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import type { VisionHoldRow } from "@/lib/conveyor/model";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Pull the drain cron's failure note out of the record's notes tail, so the
 *  card can say WHY vision failed rather than a generic "couldn't read it".
 *  Null when no marker is present — never guessed. */
function failureReasonFromNotes(notes: string | null | undefined): string | null {
  if (!notes) return null;
  if (/no_photos_available/.test(notes)) return "no_photos_available";
  const m = notes.match(/vision_error:\s*([^\n|]+)/);
  return m ? `vision_error: ${m[1].trim().slice(0, 120)}` : null;
}

export async function GET(req: Request) {
  const cookieHeader = req.headers.get("cookie");
  if (!hasDashboardSession(cookieHeader)) {
    const env = readAuthEnv();
    const headers = readAuthHeaders(req);
    const authRequired = kvConfigured() || env.cronSecret !== null || env.bearerDevToken !== null;
    if (authRequired) {
      const auth = await authenticate(headers, env, kvProd);
      if (!auth.ok) return NextResponse.json({ error: "unauthorized", reason: auth.reason }, { status: 401 });
    }
  }

  let listings;
  try {
    listings = await getListings({ includeLegacy: true });
  } catch (err) {
    return NextResponse.json(
      { error: "listings_fetch_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  const items: VisionHoldRow[] = listings
    .filter((l) => l.visionQueueState === "vision_failed")
    .map((l) => ({
      recordId: l.id,
      address: l.address,
      listPrice: l.listPrice ?? null,
      failureReason: failureReasonFromNotes(l.notes),
      heldAt: l.lastVerified ?? null,
    }));

  return NextResponse.json({
    items,
    // The machine-work count, for the backlog rail. Never rendered as cards.
    needs_vision: listings.filter((l) => l.visionQueueState === "needs_vision").length,
  });
}
