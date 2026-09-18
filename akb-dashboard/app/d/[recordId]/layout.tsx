// PUBLIC DEAL PAGE — Open Graph / Twitter card metadata (2026-09-18).
//
// Server component so the link preview a buyer's phone renders (texted or
// pasted into a group) is generated before any client JS runs. Built ONLY
// from PublicDealView (publicDealView / publicDealSummary) — never the raw
// Listing — so a preview card can never surface the street address, the
// list price, or anything else off the buyer-safe allowlist.

import type { Metadata } from "next";
import { getListing } from "@/lib/airtable";
import { publicDealView, publicDealSummary } from "@/lib/dispo/public-deal";

export const runtime = "nodejs";

const RECORD_ID_RE = /^rec[A-Za-z0-9]{14}$/;

const NOT_AVAILABLE: Metadata = {
  title: "Deal not available",
  openGraph: { title: "Deal not available" },
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ recordId: string }>;
}): Promise<Metadata> {
  const { recordId } = await params;
  if (!RECORD_ID_RE.test(recordId)) return NOT_AVAILABLE;

  try {
    const listing = await getListing(recordId, { fresh: true });
    if (!listing) return NOT_AVAILABLE;

    const view = publicDealView(listing);
    if (!view) return NOT_AVAILABLE;

    const title = view.headline;
    const description = publicDealSummary(view);
    const images = view.photos.slice(0, 1);

    return {
      title,
      description,
      openGraph: {
        title,
        description,
        type: "website",
        ...(images.length > 0 ? { images } : {}),
      },
      twitter: {
        card: images.length > 0 ? "summary_large_image" : "summary",
        title,
        description,
      },
    };
  } catch (err) {
    console.error("[d/layout] metadata lookup failed:", String(err).slice(0, 200));
    return NOT_AVAILABLE;
  }
}

export default function PublicDealLayout({ children }: { children: React.ReactNode }) {
  return children;
}
