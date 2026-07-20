// Seller Basis — the "why is the seller countering like that" card.
// @agent: appraiser
//
// GET /api/seller-basis/<recordId>          → cached read (7d KV) or fresh pull
// GET /api/seller-basis/<recordId>?refresh=1 → force a fresh paid pull
//
// Pulls ATTOM ownership + open-mortgage intel for the listing and renders
// the seller's probable FLOOR next to our stamped opener. Born from the
// Canfield decode (2026-07-20): the seller's "double it" was their bridge-
// loan payoff, learned only after three bumps. This surfaces it BEFORE the
// first offer. Auth-gated (paid call behind it); one paid pull per record
// per week via the KV cache.

import { NextResponse } from "next/server";
import { getListing } from "@/lib/airtable";
import { getSellerBasis, type SellerBasis } from "@/lib/seller-basis/attom-ownership";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";

export const runtime = "nodejs";
export const maxDuration = 30;

const CACHE_TTL_S = 7 * 24 * 3600;
const cacheKey = (recordId: string) => `seller-basis:${recordId}`;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ recordId: string }> },
) {
  const { recordId } = await params;
  if (!recordId || !recordId.startsWith("rec")) {
    return NextResponse.json({ error: "invalid_record_id" }, { status: 400 });
  }

  const cookieHeader = req.headers.get("cookie");
  if (!hasDashboardSession(cookieHeader)) {
    const env = readAuthEnv();
    const headers = readAuthHeaders(req);
    const authRequired = kvConfigured() || env.cronSecret !== null || env.bearerDevToken !== null;
    if (authRequired) {
      const auth = await authenticate(headers, env, kvProd);
      if (!auth.ok) {
        return NextResponse.json({ error: "unauthorized", reason: auth.reason }, { status: 401 });
      }
    }
  }

  const url = new URL(req.url);
  const refresh = url.searchParams.get("refresh") === "1";

  if (!refresh && kvConfigured()) {
    try {
      const cached = await kvProd.get(cacheKey(recordId));
      if (cached) {
        return NextResponse.json({ ...(JSON.parse(cached) as object), cache: "hit" });
      }
    } catch {
      /* cache miss path below; a KV blip must not block the read */
    }
  }

  try {
    const listing = await getListing(recordId);
    if (!listing) return NextResponse.json({ error: "listing_not_found" }, { status: 404 });
    if (!listing.address || !listing.city || !listing.state || !listing.zip) {
      return NextResponse.json({ error: "listing_missing_address_fields" }, { status: 422 });
    }

    const basis = await getSellerBasis({
      address: listing.address,
      city: listing.city,
      state: listing.state,
      zip: listing.zip,
      recordId,
    });

    // The seller-floor read: their open note is the price below which they
    // write a check to close. Original loan amount is an UPPER BOUND on
    // payoff for amortizing notes and ≈payoff for bridge/interest-only —
    // labeled honestly, never presented as an exact payoff.
    const opener =
      listing.contractOfferPrice ?? listing.roughOpenerAmount ?? listing.outreachOfferPrice ?? null;
    const payload: { basis: SellerBasis | null; read: Record<string, unknown> } = {
      basis,
      read: {
        stamped_opener: opener,
        seller_floor_hint: basis?.loanAmount ?? null,
        opener_below_seller_floor:
          basis?.loanAmount != null && opener != null ? opener < basis.loanAmount : null,
        basis_vs_opener:
          basis?.lastSalePrice != null && opener != null ? opener - basis.lastSalePrice : null,
      },
    };

    if (kvConfigured()) {
      try {
        await kvProd.setEx(cacheKey(recordId), JSON.stringify(payload), CACHE_TTL_S);
      } catch {
        /* best-effort cache */
      }
    }
    return NextResponse.json({ ...payload, cache: refresh ? "refreshed" : "miss" });
  } catch (err) {
    // Entitlement failures land here VISIBLY (the operator's tier is proven
    // for /sale/snapshot only) — the card renders the reason, never a blank.
    return NextResponse.json(
      { error: "seller_basis_failed", detail: String(err).slice(0, 300) },
      { status: 502 },
    );
  }
}
