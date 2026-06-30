// Seed-sweep — the frontier onboarder. @agent: scout/appraiser
//
// GET /api/admin/seed-sweep[?apply=1&limit=N&zips=a,b&state=GA]
//
// WHY: listings-intake auto-seeds new ZIPs inline, but that seed shares the
// $25/day DAILY_INTAKE_BUDGET_USD meter with STEADY-STATE backfill/federation
// RentCast pricing. On a busy day (crons live), the steady-state pricing drains
// the meter and the FRONTIER seed gets starved (decideAutoSeed → budget_
// exhausted), so a freshly-cast metro never becomes priceable — every listing
// rejects `market_not_priceable` (observed 2026-06-30: Atlanta/Indy/Birmingham
// crawled 900+ listings, accepted 0, all unseeded). That starvation is the bug
// the daily-budget header itself warns against ("the cap governs FRONTIER
// growth, never steady-state pricing") — but the shared meter conflates them.
//
// THIS ROUTE is the deliberate fix: seed active-but-unseeded registry ZIPs
// DIRECTLY, bounded by ?limit (the spend control = at most `limit` comp pulls),
// so it can't be starved by steady-state spend. Once a ZIP is seeded, every
// listing in it prices for FREE forever (seed-once / price-infinite). Casting a
// new metro becomes hands-off: add ZIPs to the registry → this sweep onboards
// them (a daily cron runs it; operator/Claude can trigger on-demand).
//
// DRY by default (lists which ZIPs WOULD seed, ZERO spend). ?apply=1 seeds.
// Per ZIP: 1 RentCast listings fetch (representative subject) + 1 comp pull
// (runAutoSeed) ≈ $0.40. Restricted states are excluded twice (getActiveIntake
// Rows filters them, decideAutoSeed re-checks). Seed-quality + DONT_PRICE
// sentinels are handled inside runAutoSeed (thin/noisy comps → covered, not a
// fabricated number).
//
// Auth posture: no app-level auth (same convention as /api/admin/appraiser-
// backfill) — access control at the Vercel deployment layer. DRY-by-default +
// the ?limit cap bound the blast radius.

import { NextResponse } from "next/server";
import { getActiveIntakeRows } from "@/lib/zip-registry";
import { listArvSeededZips } from "@/lib/zip-arv-seed-store";
import { fetchListingsByZip } from "@/lib/crawler/sources/rentcast";
import { decideAutoSeed, runAutoSeed } from "@/lib/crawler/auto-seed";
import { audit } from "@/lib/audit-log";

export const runtime = "nodejs";
export const maxDuration = 300;

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
// Stop starting new seeds this late into the 300s lambda so in-flight comp
// pulls + the trailing audit finish cleanly; the rest roll to the next run.
const WALL_CLOCK_BUDGET_MS = 270_000;

export async function GET(req: Request) {
  const t0 = Date.now();
  const url = new URL(req.url);
  const apply = url.searchParams.get("apply") === "1";
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Math.min(
    MAX_LIMIT,
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : DEFAULT_LIMIT,
  );
  const stateScope = (url.searchParams.get("state") ?? "").trim().toUpperCase();
  const zipScope = new Set(
    (url.searchParams.get("zips") ?? "")
      .split(",")
      .map((z) => z.trim())
      .filter((z) => /^\d{5}$/.test(z)),
  );

  let activeRows: Awaited<ReturnType<typeof getActiveIntakeRows>>;
  let seeded: Set<string>;
  try {
    [activeRows, seeded] = await Promise.all([getActiveIntakeRows(), listArvSeededZips()]);
  } catch (err) {
    return NextResponse.json(
      { error: "registry_or_seed_read_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  // Active (registry already excludes restricted + non-launch/active), unseeded,
  // de-duped by ZIP, with the optional state/zip scope applied.
  const seenZip = new Set<string>();
  const unseeded = activeRows.filter((r) => {
    if (!/^\d{5}$/.test(r.zip)) return false;
    if (seeded.has(r.zip)) return false;
    if (seenZip.has(r.zip)) return false;
    if (zipScope.size > 0 && !zipScope.has(r.zip)) return false;
    if (stateScope && (r.state ?? "").trim().toUpperCase() !== stateScope) return false;
    seenZip.add(r.zip);
    return true;
  });
  const batch = unseeded.slice(0, limit);

  if (!apply) {
    return NextResponse.json({
      mode: "dry_run",
      apply_available: true,
      note: "No spend. ?apply=1 to seed (~$0.40/ZIP: 1 listings fetch + 1 comp pull). Bounded by ?limit, NOT the shared daily-intake meter — so steady-state pricing can't starve the frontier.",
      active_total: activeRows.length,
      already_seeded: seeded.size,
      unseeded_total: unseeded.length,
      batch_size: batch.length,
      batch: batch.map((r) => ({ zip: r.zip, state: r.state, market: r.market })),
      duration_ms: Date.now() - t0,
    });
  }

  // ── Apply: seed each unseeded ZIP from a representative listing ──────────
  const results: Array<Record<string, unknown>> = [];
  let seededCount = 0;
  let dontPriced = 0;
  let noSubject = 0;
  let errors = 0;

  for (const r of batch) {
    if (Date.now() - t0 > WALL_CLOCK_BUDGET_MS) {
      results.push({ zip: r.zip, action: "skipped_wall_clock" });
      continue;
    }
    const zip = r.zip;

    let listings: Awaited<ReturnType<typeof fetchListingsByZip>>;
    try {
      listings = await fetchListingsByZip(zip);
    } catch (err) {
      errors++;
      results.push({ zip, action: "listings_fetch_error", error: String(err).slice(0, 160) });
      continue;
    }
    const rep = listings.candidates?.[0];

    // canSeed: true — this route is deliberately limit-bounded, so it bypasses
    // the shared daily meter (the thing that starved the inline intake seed).
    // The other gates (zip/restricted/already-seeded/subject) still apply.
    const decision = decideAutoSeed({
      zip,
      state: r.state,
      alreadySeeded: false,
      canSeed: true,
      hasRepresentativeSubject: !!(rep && rep.address),
    });
    if (!decision.seed) {
      if (decision.reason === "no_representative_subject") noSubject++;
      results.push({ zip, action: "skipped", reason: decision.reason });
      continue;
    }

    const res = await runAutoSeed({
      address: rep!.address!,
      city: rep!.city ?? "",
      state: rep!.state ?? r.state ?? "",
      zip,
      bedrooms: rep!.beds ?? null,
      bathrooms: rep!.bathrooms ?? null,
      squareFootage: rep!.squareFootage ?? null,
    });
    if (res.seeded) {
      seededCount++;
      results.push({
        zip,
        action: "seeded",
        market: r.market,
        per_sqft: res.renovatedPerSqft,
        comps: res.compCount,
        confidence: res.confidence,
      });
    } else if (res.dontPrice) {
      dontPriced++;
      results.push({ zip, action: "dont_price", reason: res.reason });
    } else {
      errors++;
      results.push({ zip, action: "seed_error", reason: res.reason });
    }
  }

  const summary = {
    batch: batch.length,
    seeded: seededCount,
    dont_priced: dontPriced,
    no_subject: noSubject,
    errors,
    unseeded_remaining: Math.max(0, unseeded.length - batch.length),
  };

  await audit({
    agent: "scout",
    event: "seed_sweep_run",
    status: "confirmed_success",
    inputSummary: { limit, state: stateScope || null, zips: [...zipScope] },
    outputSummary: summary,
    ms: Date.now() - t0,
  });

  return NextResponse.json({ mode: "apply", summary, results, duration_ms: Date.now() - t0 });
}
