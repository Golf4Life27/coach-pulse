// Deal Dossier builder — one-shot, source-record-first, Section-7 verbatim.
// @agent: orchestrator
//
// GET /api/admin/build-dossier?recordId=rec...&deal=2&floor=52000
//
// Pulls the source record + ATTOM characteristics/assessor/sold comps/
// sales history, computes conservative + pessimistic MAO, renders the
// dossier markdown (with Section 7 verbatim from Verification_Notes),
// and writes a row to the Deal_Dossiers table. REPORT-ONLY (no Airtable
// listing writes; only the dossier row).
//
// TEMP scoped public exemption: operator-authorized for ONE specific
// recordId (recO7XFKcUVTTxMcB = 12724 Strathmoor) for the Deal #002 fire.
// RE-LOCK in the next commit.

import { NextResponse } from "next/server";
import { getListing } from "@/lib/airtable";
import {
  fetchPropertyCharacteristics,
  fetchAssessor,
  fetchSalesComparables,
  fetchSalesHistory,
  buildAddress2,
  synthesizeArv,
} from "@/lib/attom/property";
import { computePessimisticMao, classifyRehabTier } from "@/lib/markets/pessimistic-mao";
import { defaultInvestorCapFor } from "@/lib/landlord-hydrate";
import { listMarkets } from "@/lib/markets/registry";
import { resolveCumulativeDom } from "@/lib/attom/cumulative-dom";
import { renderDossierHeader, renderSection7, extractContactEvents } from "@/lib/outreach/dossier";
import { detectL3DollarAmounts } from "@/lib/outreach/l3-amount-detector";
import { audit } from "@/lib/audit-log";
import {
  authenticate,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";

export const runtime = "nodejs";
export const maxDuration = 120;

const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
const LISTINGS_TABLE = "tbldMjKBgPiq45Jjs";
const DOSSIERS_TABLE = "tblCu0rSBhd5V3g0x";
const AIRTABLE_PAT = process.env.AIRTABLE_PAT;

async function handle(req: Request) {
  const t0 = Date.now();
  const env = readAuthEnv();
  const headers = readAuthHeaders(req);
  const auth = await authenticate(headers, env, kvProd);
  const url = new URL(req.url);
  const recordId = url.searchParams.get("recordId") ?? "";
  // Re-locked 2026-06-07 after Deal #002 fire.
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (auth.kind !== "cron" && auth.kind !== "oauth") return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (auth.kind === "oauth" && !kvConfigured()) return NextResponse.json({ error: "kv_not_configured" }, { status: 500 });

  if (!recordId.startsWith("rec")) return NextResponse.json({ error: "bad_record_id" }, { status: 400 });
  const dealNumberRaw = url.searchParams.get("deal");
  const dealNumber = dealNumberRaw ? parseInt(dealNumberRaw, 10) : 0;
  const stickyFloorRaw = url.searchParams.get("floor");
  const stickyFloor = stickyFloorRaw ? parseInt(stickyFloorRaw, 10) : null;

  const listing = await getListing(recordId);
  if (!listing) return NextResponse.json({ error: "record_missing" }, { status: 404 });

  const addr1 = listing.address ?? "";
  const addr2 = buildAddress2(listing.city ?? "", listing.state ?? "", listing.zip ?? "");
  const [chars, assess, sales, comps] = await Promise.all([
    fetchPropertyCharacteristics({ address1: addr1, address2: addr2 }).catch(() => null),
    fetchAssessor({ address1: addr1, address2: addr2 }).catch(() => null),
    fetchSalesHistory({ address1: addr1, address2: addr2 }).catch(() => null),
    fetchSalesComparables({ street: addr1, city: listing.city ?? "", state: listing.state ?? "", zip: listing.zip ?? "", subjectSqft: listing.buildingSqFt ?? null, minComps: 5, maxComps: 20, searchRadiusMi: 1 }).catch(() => null),
  ]);

  const market = listMarkets().find((m) => (listing.zip ?? "").startsWith(m.zip_prefixes[0])) ?? listMarkets().find((m) => m.id === "detroit_mi") ?? null;
  const arvPctMax = market?.buyer_params?.arv_pct_max ?? 0.6461;

  const syn = comps?.data && comps.data.length > 0
    ? synthesizeArv(comps.data, { subjectSqft: listing.buildingSqFt ?? null, subjectZip: listing.zip ?? null })
    : null;

  // Pessimistic rehab = HIGH end of the persisted band (Rehab_Est_High is
  // populated when vision wrote a band; fall back to mid × 1.3 when only mid).
  const rehabMid = (listing.estRehabMid ?? listing.estRehab ?? null) as number | null;
  const rehabHigh = (listing as { estRehabHigh?: number | null }).estRehabHigh ?? (rehabMid != null ? Math.round(rehabMid * 1.3) : null);

  // Rehab scope tier from line-items JSON narrative.
  const rehabJson = (listing as { rehabLineItemsJson?: string | null }).rehabLineItemsJson ?? "";
  const scopeText = typeof rehabJson === "string" ? rehabJson : "";
  const scopeTier = classifyRehabTier({
    visionCondition: scopeText.includes('"vision_condition"') ? (scopeText.match(/"vision_condition"\s*:\s*"([^"]+)"/)?.[1] ?? null) : null,
    visionConfidence: listing.rehabConfidenceScore ?? null,
    scopeText,
  });

  // Pessimistic MAO: conservative ARV × ARV%Max − rehabHigh − fee, vs sticky floor.
  const pess = computePessimisticMao({
    conservativeArv: syn?.arvConservative ?? syn?.arv ?? null,
    rehabHigh,
    arvPctMax,
    stickyFloor,
  });

  const cap = defaultInvestorCapFor(listing.state, listing.zip);
  const cumDom = resolveCumulativeDom({
    mlsDomV2: typeof listing.dom === "number" ? listing.dom : null,
  });

  // Section 7 — verbatim prior contact.
  const events = extractContactEvents(listing.notes);
  const l3 = events.filter((e) => e.direction === "inbound").map((e) => detectL3DollarAmounts(e.body)).flatMap((d) => d.amounts);

  // Render the dossier markdown.
  const header = renderDossierHeader({
    dealNumber,
    recordId,
    baseId: BASE_ID,
    tableId: LISTINGS_TABLE,
    address: listing.address ?? "",
    city: listing.city ?? null,
    state: listing.state ?? null,
    zip: listing.zip ?? null,
    agentName: (listing as { agentName?: string | null }).agentName ?? null,
    agentPhone: (listing as { agentPhone?: string | null }).agentPhone ?? null,
    listPrice: listing.listPrice ?? null,
    stickyFloor,
  });

  const compsLines = (syn?.renovatedComps ?? []).map((c) => `- ${c.address ?? "?"} | ${c.zip ?? "?"} | ${c.distanceMi != null ? c.distanceMi.toFixed(2) : "?"}mi | ${c.sqft ?? "?"}sf | $${c.saleAmount.toLocaleString()} | ${(c.saleDate ?? "").slice(0, 10)} | **$${c.ppsf}/sf**`).join("\n");
  const lastSale = sales?.data?.lastSale;

  const md = [
    header,
    "",
    "## 1 — Market + Buy-Box",
    `- **Market**: ${market?.label ?? "(unmatched)"} — ARV%Max ${(arvPctMax * 100).toFixed(2)}%, Max_Rehab $${(market?.buyer_params?.max_rehab_usd ?? 0).toLocaleString()}${market?.buyer_params?.max_price_usd != null ? `, Max_Price $${market.buyer_params.max_price_usd.toLocaleString()}` : ""}`,
    `- **Sourced investor-required cap (state/zip default)**: ${cap != null ? `${(cap * 100).toFixed(2)}%` : "(unsourced; HOLD)"}`,
    "",
    "## 2 — Subject",
    `- Beds/Baths/Sqft/Year: ${chars?.data?.beds ?? "-"}/${chars?.data?.baths ?? "-"}/${chars?.data?.sqft ?? "-"}sf/${chars?.data?.yearBuilt ?? "-"}`,
    `- Property type: ${chars?.data?.propertyType ?? "-"}`,
    "",
    "## 3 — Conservative-Tier ARV (renovated cluster + nearest-weighted P25)",
    syn ? `- **Central ARV** (cluster median × sqft): $${(syn.arv ?? 0).toLocaleString()} @ $${syn.renovatedMedianPpsf}/sf` : "- ARV: NOT COMPUTED (no comps returned)",
    syn?.arvConservative != null ? `- **Conservative ARV** (nearest-weighted P25): **$${syn.arvConservative.toLocaleString()} @ $${syn.conservativeMedianPpsf}/sf**` : "- Conservative ARV: null (distance/sqft data missing)",
    syn ? `- Zip benchmark $/sf: $${syn.zipBenchmarkPpsf ?? "-"} (${syn.zipBenchmarkComps} in-zip comps); guard: **${syn.guardStatus}**` : "",
    "",
    "## 4 — Rehab (vision)",
    `- **Median Est_Rehab**: $${(rehabMid ?? 0).toLocaleString()} (conf ${listing.rehabConfidenceScore ?? "-"})`,
    `- **Pessimistic (HIGH band)**: $${(rehabHigh ?? 0).toLocaleString()}`,
    `- **Scope → ARV tier**: **${scopeTier.tier}** — ${scopeTier.reason}`,
    scopeTier.hardStops.length > 0 ? `- Hard stops: ${scopeTier.hardStops.join("; ")}` : "",
    "",
    "## 5 — Seller Basis + Title",
    lastSale ? `- **Last sale**: $${lastSale.saleAmount?.toLocaleString() ?? "-"} on ${lastSale.saleDate?.slice(0, 10) ?? "-"} (deed: ${lastSale.deedType ?? "-"}, title-risk: **${lastSale.titleRisk}**)` : "- Last sale: ATTOM saleshistory returned no events",
    `- **Title-risk in any event**: ${sales?.data?.titleRiskAny ? "⚠ YES — DD item" : "no"}`,
    "",
    "## 6 — Cumulative DOM",
    `- ${cumDom.reason}${cumDom.relistSuspected ? " — ⚠ relist suspected, treat as lower bound" : ""}`,
    "",
    renderSection7(events),
    "",
    "## 8 — Pessimistic-Bound MAO Verdict",
    `- **Pessimistic MAO**: ${pess.pessimisticMao != null ? `$${pess.pessimisticMao.toLocaleString()}` : "n/a"}`,
    `- **Verdict**: **${pess.verdict}**${pess.marginOverFloor != null ? ` (margin over sticky floor: $${pess.marginOverFloor.toLocaleString()})` : ""}`,
    `- ${pess.reason}`,
    "",
    "## 9 — Comp Audit (renovated cluster)",
    compsLines || "_no renovated comps_",
    "",
    "## 10 — L3 Amount Detections",
    l3.length > 0
      ? l3.map((a) => `- $${a.amountUsd.toLocaleString()} — token \`${a.token}\` — context: "${a.context}"`).join("\n")
      : "_no dollar-amount replies on record_",
  ].filter(Boolean).join("\n");

  // Write to Deal_Dossiers.
  let written = false;
  let writeError: string | null = null;
  if (AIRTABLE_PAT) {
    const writeUrl = `https://api.airtable.com/v0/${BASE_ID}/${DOSSIERS_TABLE}`;
    const res = await fetch(writeUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${AIRTABLE_PAT}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        records: [{
          fields: {
            Deal_Number: dealNumber,
            Source_Record_Id: recordId,
            Address: listing.address ?? "",
            Dossier_Markdown: md.slice(0, 90_000),
            Sticky_Floor: stickyFloor,
            Pessimistic_MAO: pess.pessimisticMao,
            Verdict: pess.verdict,
            Awaiting: "Alex review",
            Created_At: new Date().toISOString(),
          },
        }],
        typecast: true,
      }),
    });
    written = res.ok;
    if (!res.ok) writeError = `${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`;
  }

  await audit({
    agent: "orchestrator",
    event: "deal_dossier_built",
    status: "confirmed_success",
    recordId,
    inputSummary: { deal: dealNumber, sticky_floor: stickyFloor, auth: auth.ok ? auth.kind : "?" },
    outputSummary: { verdict: pess.verdict, pessimistic_mao: pess.pessimisticMao, written, write_error: writeError, duration_ms: Date.now() - t0 },
  });

  return NextResponse.json({
    ok: true,
    deal_number: dealNumber,
    record_id: recordId,
    address: listing.address,
    conservative_arv: syn?.arvConservative ?? syn?.arv ?? null,
    rehab_high: rehabHigh,
    pessimistic_mao: pess.pessimisticMao,
    sticky_floor: stickyFloor,
    verdict: pess.verdict,
    margin_over_floor: pess.marginOverFloor,
    scope_tier: scopeTier.tier,
    title_risk: lastSale?.titleRisk ?? null,
    cumulative_dom: cumDom.cumulativeDom,
    l3_amounts: l3.map((a) => a.amountUsd),
    contact_event_count: events.length,
    written_to_airtable: written,
    write_error: writeError,
    dossier_markdown: md,
  });
}

export async function GET(req: Request) { return handle(req); }
export async function POST(req: Request) { return handle(req); }
