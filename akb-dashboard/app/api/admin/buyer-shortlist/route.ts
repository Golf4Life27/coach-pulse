// DISPO — manual buyer shortlist for one deal. @agent: scout
//
// GET /api/admin/buyer-shortlist?recordId=recXXXXXXXXXXXXXX
//   ?top=N        how many to put in the call list (default 5)
//   ?price=N      override the price to match against (default: the record's
//                 contract price, else its outreach offer, else list price)
//   ?format=text  a phone-ready list instead of JSON
//
// READ-ONLY BY CONSTRUCTION. This route has no write path and no send path —
// it does not touch Airtable state, does not queue a message, and has no
// ?apply. That is not an oversight to be corrected later: shipping dispo by
// hand first is the point (operator instruction 2026-08-09). The blast lane,
// when it exists, will be a separate route that has to pass the send gate;
// this one exists so the operator can work five names on the phone today.

import { NextResponse } from "next/server";
import { getListing, getBuyers } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import { buildBuyerShortlist, type ShortlistSubject } from "@/lib/dispo/buyer-shortlist";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvProd, kvConfigured } from "@/lib/maverick/oauth/kv";

export const runtime = "nodejs";
export const maxDuration = 60;

function renderText(r: ReturnType<typeof buildBuyerShortlist>): string {
  const lines: string[] = [];
  lines.push(`BUYER SHORTLIST — ${r.subject.address}`);
  lines.push(
    `${r.subject.zip ?? "no zip"} · ${r.subject.state ?? "no state"} · ` +
      (r.subject.price != null ? `$${r.subject.price.toLocaleString()}` : "no price on record"),
  );
  lines.push("");
  if (r.top.length === 0) {
    lines.push("No callable buyers matched. See coverage below before assuming the matcher is wrong.");
  }
  r.top.forEach((b, i) => {
    lines.push(`${i + 1}. ${b.name}${b.company ? ` (${b.company})` : ""} — score ${b.score}`);
    lines.push(`   ${b.phone ?? b.email ?? "no contact on file"}`);
    lines.push(`   ${b.reasons.join(" · ")}`);
    lines.push("");
  });
  const c = r.coverage;
  lines.push(
    `Coverage: ${c.buyersConsidered} considered · ${c.withZipMatch} ZIP · ${c.withStateMatch} state · ` +
      `${c.withGeoMismatch} outside their area · ${c.withNoGeoData} no geo on file · ${c.withPhone} with a phone`,
  );
  if (c.outsideStatedBox > 0) {
    lines.push(`${c.outsideStatedBox} more sit outside their stated price box — in the JSON under "ranked".`);
  }
  return lines.join("\n");
}

async function handle(req: Request): Promise<Response> {
  const t0 = Date.now();
  const url = new URL(req.url);

  // Auth waterfall — same posture as every other admin route.
  const cookieHeader = req.headers.get("cookie");
  let authKind: "dashboard_session" | "oauth" | "cron" | "bearer_dev" | "none" = "none";
  if (hasDashboardSession(cookieHeader)) {
    authKind = "dashboard_session";
  } else {
    const env = readAuthEnv();
    const headers = readAuthHeaders(req);
    const authRequired = kvConfigured() || env.cronSecret !== null || env.bearerDevToken !== null;
    if (authRequired) {
      const auth = await authenticate(headers, env, kvProd);
      if (!auth.ok) {
        return NextResponse.json({ error: "unauthorized", reason: auth.reason }, { status: 401 });
      }
      authKind = auth.kind;
    }
  }

  const recordId = url.searchParams.get("recordId");
  if (!recordId) {
    return NextResponse.json(
      { error: "missing_record_id", reason: "Pass ?recordId=recXXXXXXXXXXXXXX — the deal to match buyers against." },
      { status: 400 },
    );
  }

  const listing = await getListing(recordId).catch(() => null);
  if (!listing) {
    return NextResponse.json({ error: "listing_not_found", recordId }, { status: 404 });
  }

  // Price precedence: what we'd actually assign at beats what we offered,
  // which beats the asking price. An override wins over all of it.
  const priceParam = Number(url.searchParams.get("price"));
  const price =
    Number.isFinite(priceParam) && priceParam > 0
      ? Math.floor(priceParam)
      : listing.contractOfferPrice ?? listing.outreachOfferPrice ?? listing.listPrice ?? null;

  const subject: ShortlistSubject = {
    recordId,
    address: listing.address,
    zip: listing.zip ?? null,
    state: listing.state ?? null,
    city: listing.city ?? null,
    price,
  };

  const topRaw = Number(url.searchParams.get("top"));
  const topN = Number.isFinite(topRaw) && topRaw > 0 ? Math.min(25, Math.floor(topRaw)) : 5;

  const buyers = await getBuyers();
  const result = buildBuyerShortlist({ subject, buyers, topN });

  await audit({
    agent: "scout",
    event: "buyer_shortlist_built",
    status: "confirmed_success",
    recordId,
    inputSummary: {
      auth_kind: authKind,
      address: listing.address,
      zip: subject.zip,
      state: subject.state,
      price,
      price_source:
        Number.isFinite(priceParam) && priceParam > 0
          ? "override"
          : listing.contractOfferPrice != null
            ? "contract"
            : listing.outreachOfferPrice != null
              ? "outreach_offer"
              : listing.listPrice != null
                ? "list"
                : "none",
    },
    outputSummary: { top: result.top.length, ...result.coverage },
    ms: Date.now() - t0,
  }).catch(() => {});

  if (url.searchParams.get("format") === "text") {
    return new NextResponse(renderText(result), {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  return NextResponse.json({
    ok: true,
    mode: "read_only",
    ...result,
    auth_kind: authKind,
    duration_ms: Date.now() - t0,
  });
}

export async function GET(req: Request): Promise<Response> {
  return handle(req);
}
