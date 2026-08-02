// Freshness re-verify pass (operator 2026-06-08, item 1).
//
// GET /api/admin/freshness-reverify
//   default        DRY-RUN: report which records are due for re-verify
//                  (active, has a cached Verification_URL, actionable
//                  market, Last_Verified stale/absent), oldest-first.
//   ?apply=1       re-scrape the known URL (1 Firecrawl credit each via
//                  verifyListingByUrl — NO discovery search), then stamp
//                  Last_Verified=now + Live_Status (Active / Off Market).
//   ?limit=N       cap re-verifies (default 15, max 50).
//   ?max_age_hours=N  freshness window (default 48).
//
// Purpose: keep the outreach-eligible set CONFIRMED-LIVE within the window
// without paying the 2-credit discovery search. A listing only becomes
// outreach-fresh (lib/outreach-freshness) after this pass re-confirms it
// Active. Paused/excluded markets are skipped — no credits on deals we
// can't price or assign (lib/markets/actionable).
//
// Auth: dashboard cookie / CRON_SECRET / OAuth waterfall.

import { NextResponse } from "next/server";
import { getListings, updateListingRecord } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import { verifyListingByUrl } from "@/lib/crawler/sources/firecrawl";
import { isPriceableMarket } from "@/lib/markets/actionable";
import { listSeededZips } from "@/lib/buyer-median-store";
import { listArvSeededZips } from "@/lib/zip-arv-seed-store";
import { isOutreachFresh, DEFAULT_FRESHNESS_HOURS } from "@/lib/outreach-freshness";
import { judgeSpread, isSpreadWatchRecord } from "@/lib/contract-lifecycle/spread-watch";
import { judgeSubjectPrint } from "@/lib/pricing/subject-history";
import { getSubjectRecordedSale } from "@/lib/rentcast";
import { parkDeal } from "@/lib/conveyor/park";
import { isH2Eligible } from "@/lib/h2-outreach";
import { SOURCE_VERSION_V2 } from "@/lib/source-version";
import {
  isBumpReverifyCandidate,
  partitionReverifyBatch,
} from "@/lib/h2-outreach/bump-lane";
import type { Listing } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const DEFAULT_LIMIT = 15;
const MAX_LIMIT = 50;
const BUDGET_MS = 180_000;

export async function GET(req: Request) {
  const t0 = Date.now();

  const cookieHeader = req.headers.get("cookie");
  let authKind = "none";
  if (hasDashboardSession(cookieHeader)) authKind = "dashboard_session";
  else {
    const env = readAuthEnv();
    const headers = readAuthHeaders(req);
    const authRequired = kvConfigured() || env.cronSecret !== null || env.bearerDevToken !== null;
    if (authRequired) {
      const auth = await authenticate(headers, env, kvProd);
      if (!auth.ok) return NextResponse.json({ error: "unauthorized", reason: auth.reason }, { status: 401 });
      authKind = auth.kind;
    }
  }

  const url = new URL(req.url);
  const apply = url.searchParams.get("apply") === "1";
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Math.min(MAX_LIMIT, Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : DEFAULT_LIMIT);
  const maxAgeRaw = Number(url.searchParams.get("max_age_hours"));
  const maxAgeHours = Number.isFinite(maxAgeRaw) && maxAgeRaw > 0 ? maxAgeRaw : DEFAULT_FRESHNESS_HOURS;
  // Scope: ?zips=48227,48228 (comma list) and/or ?state=MI restrict the pass
  // to a market. Empty = whole actionable cohort.
  const zipScope = new Set(
    (url.searchParams.get("zips") ?? "")
      .split(",")
      .map((z) => z.trim())
      .filter((z) => /^\d{5}$/.test(z)),
  );
  const stateScope = (url.searchParams.get("state") ?? "").trim().toUpperCase();
  const now = new Date();

  // Pool (2026-06-11 fix, spine recZNzKlsgtzlCLkY): was getActiveListingsForBrief
  // — Outreach_Status-BEARING records only — which made the entire status-EMPTY
  // first-touch supply invisible to the keep-warm pass. The 174-record
  // five-ZIP cohort went verify_stale with this route unable to even see it.
  // The pool is now "every record whose freshness MATTERS": H2-eligible
  // first-touch supply (status empty + Active + Auto Proceed + phone + v2,
  // via the same isH2Eligible the cron selects with — one gate, no drift)
  // plus the reply-bearing negotiation statuses the old pool carried.
  // 2026-07-09 budget fix: "Texted"/"Emailed" REMOVED from the keep-warm set.
  // They are not reply-bearing — they're one-and-done first touches whose
  // freshness serves nothing (they can't first-touch again; no bump lane
  // yet), and as the OLDEST stale records they consumed the entire daily
  // limit ahead of sendable supply: Mark Twain-class June records were
  // re-verified every 48h while the July first-touch cohort stranded at
  // depth 3 (7/08 probe: 41 verify_stale). Live threads stay warm; dead
  // air does not.
  // 2026-07-11 bump-lane re-admission (#33, spine recFYBbF5H9YU1GWm ruled
  // "re-admit THEN, budget-partitioned, not before" — the bump lane now
  // exists): Texted records regain a freshness consumer, but ONLY the
  // bump-waiting subset (silent v2 threads with bumps remaining whose next
  // bump lands inside the freshness window — isBumpReverifyCandidate), and
  // only at a MINORITY SHARE of each batch (partitionReverifyBatch): the
  // core pool (first-touch supply + live threads + liveness-unknown) keeps
  // ≥60% of the slots whenever it needs them. Exhausted/replied/DNT Texted
  // records stay out — dead air stays cold.
  const REPLY_BEARING = new Set(["Negotiating", "Response Received", "Counter Received", "Offer Accepted"]);
  let active: Listing[];
  let seededZips: Set<string>;
  try {
    let all: Listing[];
    // 2026-07-10 autopsy fix (the 43-stale cohort): this route filtered
    // markets against the LEGACY buyer-median store (10 Detroit ZIPs), so
    // every stale record outside Detroit was skipped as "non-priceable" by
    // EVERY freshness pass — the same wrong-store bug fixed in the send
    // path (PR #80). Priceability = the ARV seed store, unioned with the
    // legacy set.
    let arvZips: Set<string>;
    let medianZips: Set<string>;
    [all, arvZips, medianZips] = await Promise.all([getListings(), listArvSeededZips(), listSeededZips()]);
    seededZips = new Set<string>([...arvZips, ...medianZips]);
    // Third cohort (2026-07-09): untouched records whose Live_Status was
    // never stamped (6/30 Indy class) are invisible to isH2Eligible until
    // a verify pass writes Live_Status — which is exactly what THIS route
    // does. Admit them so they graduate into the sendable pool.
    // 2026-07-11 (#38 Forward Ruling): v2-era only — an unstamped LEGACY
    // row is a fenced ghost, and a verify credit spent on it buys nothing
    // the send path can ever use.
    const livenessUnknown = (l: Listing) =>
      (l.liveStatus ?? "").trim() === "" &&
      (l.outreachStatus ?? "").trim() === "" &&
      l.sourceVersion === SOURCE_VERSION_V2;
    active = all.filter(
      (l) =>
        isH2Eligible(l) ||
        REPLY_BEARING.has(l.outreachStatus ?? "") ||
        livenessUnknown(l) ||
        isBumpReverifyCandidate(l, now),
    );
  } catch (err) {
    return NextResponse.json({ error: "active_fetch_failed", message: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }

  // Candidate set: in the requested zip/state scope, has a cached URL, in a
  // PRICEABLE market (sourced arv_pct_max + seeded buyer-median — never spend
  // Firecrawl on a market we can't make an MAO-checked offer in), and NOT
  // currently outreach-fresh (stale or never re-verified).
  const skippedNonActionable: Array<{ recordId: string; reason: string }> = [];
  let outOfScope = 0;
  const candidates = active.filter((l) => {
    const zip = (l.zip ?? "").trim();
    if (zipScope.size > 0 && !zipScope.has(zip)) { outOfScope++; return false; }
    if (stateScope && (l.state ?? "").trim().toUpperCase() !== stateScope) { outOfScope++; return false; }
    if (!(l.verificationUrl && l.verificationUrl.trim() !== "")) return false;
    // DEAL-PROTECT EXEMPTION (2026-08-01, the Sunbeam receipt): the priceable-
    // market gate exists to not spend Firecrawl where we cannot SEND — but a
    // record we are negotiating or have under contract is not a send-candidate,
    // it is a live deal. Houston is not a sendable market, and that is exactly
    // why a $60K cut on a record UNDER CONTRACT went invisible for 17 days.
    // Protecting a live spread is worth a credit in any market on the map.
    if (!isSpreadWatchRecord(l)) {
      const market = isPriceableMarket({ state: l.state, city: l.city, zip: l.zip }, seededZips);
      if (!market.actionable) {
        skippedNonActionable.push({ recordId: l.id, reason: market.reason ?? "non_priceable" });
        return false;
      }
    }
    return !isOutreachFresh({ lastVerified: l.lastVerified, liveStatus: l.liveStatus }, now, maxAgeHours).fresh;
  });

  // Oldest-first (never-verified = oldest).
  candidates.sort((a, b) => {
    const ta = a.lastVerified ? Date.parse(a.lastVerified) : -Infinity;
    const tb = b.lastVerified ? Date.parse(b.lastVerified) : -Infinity;
    return ta - tb;
  });
  // Budget partition (#33): bump-waiting Texted records take at most a
  // minority share of the batch; core supply (first-touch + live threads +
  // liveness-unknown) keeps priority. Spare core slots backfill with bumps.
  const bumpPool = candidates.filter((l) => isBumpReverifyCandidate(l, now));
  const corePool = candidates.filter((l) => !isBumpReverifyCandidate(l, now));
  const partition = partitionReverifyBatch(corePool, bumpPool, limit);
  const batch = partition.batch;

  if (!apply) {
    return NextResponse.json({
      ok: true,
      mode: "dry_run",
      auth_kind: authKind,
      max_age_hours: maxAgeHours,
      scope: { zips: [...zipScope], state: stateScope || null, out_of_scope: outOfScope },
      seeded_zips: [...seededZips],
      active_total: active.length,
      due_total: candidates.length,
      bump_partition: {
        bump_due: bumpPool.length,
        core_due: corePool.length,
        core_taken: partition.coreTaken,
        bump_taken: partition.bumpTaken,
      },
      skipped_non_priceable: skippedNonActionable.length,
      batch: batch.map((l) => ({ recordId: l.id, address: l.address, state: l.state, zip: l.zip, lastVerified: l.lastVerified ?? null, url: l.verificationUrl })),
      duration_ms: Date.now() - t0,
    });
  }

  // ── Apply: 1-credit known-URL re-scrape per record ────────────────
  const results: Array<{ recordId: string; address: string | null; stillActive: boolean | null; credits: number; newLiveStatus: string | null; error: string | null }> = [];
  const spreadWatch = { watched: 0, alerts: 0 };
  const subjectPrint = { checked: 0, alerts: 0, skipped_flagged: 0, unchecked: 0 };
  let creditsUsed = 0;
  let paymentRequired = false;
  for (const l of batch) {
    if (Date.now() - t0 > BUDGET_MS) break;
    const iso = new Date().toISOString();
    try {
      const fc = await verifyListingByUrl(l.verificationUrl, l.address);
      creditsUsed += fc.creditsUsed;
      if (fc.paymentRequired) { paymentRequired = true; results.push({ recordId: l.id, address: l.address, stillActive: null, credits: fc.creditsUsed, newLiveStatus: null, error: "firecrawl_payment_required" }); break; }
      if (!fc.resolved) {
        // Couldn't re-scrape the page → leave as-is, just record (do NOT
        // mark off-market on an infra miss).
        results.push({ recordId: l.id, address: l.address, stillActive: null, credits: fc.creditsUsed, newLiveStatus: null, error: fc.error ?? "unresolved" });
        continue;
      }
      const newLive = fc.stillActive ? "Active" : "Off Market";
      // ── RENOVATED-LISTING VETO (operator 2026-07-25, 914 Dan St / 529 Bina) ──
      // verifyListingByUrl ALREADY reads the page and computes
      // hasRenovatedLanguage — this route used to throw that verdict away and
      // stamp the record outreach-fresh anyway, so the RentCast lane (which has
      // no listing text at intake) texted distress openers at turnkey houses.
      // Persist the verdict: renovated language WITHOUT distress language =
      // veto (the crawler's own tier doctrine — distress copy like "investor
      // special, recently updated" still overrides). Cleared automatically when
      // a later scrape finds distress copy, so price-cut re-engagement stays
      // possible. Enforced in lib/h2-outreach outreachReadyReason + bump lane.
      const renovatedVeto = fc.hasRenovatedLanguage && !fc.hasConditionSignal;
      await updateListingRecord(l.id, {
        Live_Status: newLive,
        Last_Verified: iso,
        Renovated_Language: renovatedVeto,
      });

      // ── ENGAGED-RECORD SPREAD WATCH (operator-mandated 2026-07-30) ──────
      // The Sunbeam/8th Ct watcher: judge the fresh scrape against the deal
      // we are protecting. Alert verdicts mint a spread_threat park (renders
      // as a HIGH underwater_review decision card) + a CRITICAL-grade audit,
      // and the fresh ask is STAMPED onto the record (List_Price truth was
      // 17 days stale on Sunbeam; Prev_List_Price preserves the evidence
      // trail the 7/30 session worried about losing). Best-effort — a watch
      // failure never fails the verify pass that carried it.
      if (isSpreadWatchRecord(l)) {
        try {
          const verdict = judgeSpread({
            protectPriceUsd: l.contractOfferPrice ?? l.outreachOfferPrice ?? l.roughOpenerAmount ?? null,
            storedListUsd: l.listPrice ?? null,
            scrapedListUsd: fc.scrapedPrice ?? null,
            stillActive: fc.stillActive,
            inactiveMarkers: fc.matchedInactiveMarkers,
          });
          spreadWatch.watched++;
          if (verdict.freshAskUsd != null && l.listPrice != null && verdict.freshAskUsd !== l.listPrice) {
            await updateListingRecord(l.id, {
              Prev_List_Price: l.listPrice,
              List_Price: verdict.freshAskUsd,
            });
          }
          if (verdict.alert) {
            spreadWatch.alerts++;
            await parkDeal({
              recordId: l.id,
              address: l.address ?? l.id,
              reason: "spread_threat",
              priority: "HIGH",
              reasoning: verdict.detail,
              payload: {
                verdict: verdict.kind,
                fresh_ask: verdict.freshAskUsd,
                stored_list: l.listPrice ?? null,
                protect_price: l.contractOfferPrice ?? l.outreachOfferPrice ?? l.roughOpenerAmount ?? null,
              },
            });
            await audit({
              agent: "sentinel",
              event: "engaged_spread_alert",
              status: "confirmed_success",
              recordId: l.id,
              inputSummary: { address: l.address, status: l.outreachStatus, under_contract: Boolean(l.contractExecutedAt) },
              outputSummary: { verdict: verdict.kind, fresh_ask: verdict.freshAskUsd, detail: verdict.detail.slice(0, 200) },
              decision: verdict.kind,
            });
          }
        } catch (err) {
          console.error("[freshness-reverify] spread watch failed:", err);
        }

        // ── SUBJECT-PRINT GATE (2026-08-02, the 9360 Cheyenne receipt) ──
        // Once per engaged record (90-day KV flag, acquired BEFORE the paid
        // call so retries can't double-bill): pull the subject's own deed
        // print from RentCast /properties — the field the comp pull was
        // already paying for and discarding — and judge our protect price
        // against it. Cheyenne's accepted $42,499 sat at 94% of its
        // February $45,000 public-record sale for three weeks while the
        // operator negotiated on modeled ARV; he found the print on Redfin
        // by hand. Cost: engaged records only, one credit per record per
        // 90 days. No KV → skip (never meter-blind spend), visibly counted.
        try {
          if (!kvConfigured()) {
            subjectPrint.unchecked++;
          } else {
            const flagKey = `subject-print:v1:${l.id}`;
            const acquired = await kvProd.setNx(flagKey, iso, 90 * 86_400);
            if (!acquired) {
              subjectPrint.skipped_flagged++;
            } else if (!l.address || !l.city || !l.state || !l.zip) {
              subjectPrint.unchecked++;
            } else {
              const protect = l.contractOfferPrice ?? l.outreachOfferPrice ?? l.roughOpenerAmount ?? null;
              const deed = await getSubjectRecordedSale(
                { address: l.address, city: l.city, state: l.state, zip: l.zip },
                l.id,
              );
              if (!deed.checked) {
                // Infra failure ≠ "no history". Release the flag so the
                // next pass retries instead of silently never checking.
                subjectPrint.unchecked++;
                await kvProd.del(flagKey).catch(() => {});
              } else {
                subjectPrint.checked++;
                const verdict = judgeSubjectPrint({
                  offerUsd: protect,
                  listUsd: fc.scrapedPrice ?? l.listPrice ?? null,
                  saleUsd: deed.sale?.price ?? null,
                  saleDateIso: deed.sale?.date ?? null,
                  asOfIso: iso,
                });
                if (verdict.alert) {
                  subjectPrint.alerts++;
                  await parkDeal({
                    recordId: l.id,
                    address: l.address ?? l.id,
                    reason: "recent_print_conflict",
                    priority: verdict.kind === "recent_print_conflict" ? "HIGH" : "MEDIUM",
                    reasoning: verdict.detail,
                    payload: {
                      verdict: verdict.kind,
                      subject_sale: verdict.saleUsd,
                      subject_sale_date: verdict.saleDateIso,
                      protect_price: protect,
                      list_price: fc.scrapedPrice ?? l.listPrice ?? null,
                    },
                  });
                }
                await audit({
                  agent: "sentinel",
                  event: "subject_print_check",
                  status: "confirmed_success",
                  recordId: l.id,
                  inputSummary: { address: l.address, protect_price: protect },
                  outputSummary: {
                    verdict: verdict.kind,
                    subject_sale: verdict.saleUsd,
                    subject_sale_date: verdict.saleDateIso,
                    detail: verdict.detail.slice(0, 200),
                  },
                  decision: verdict.kind,
                });
              }
            }
          }
        } catch (err) {
          console.error("[freshness-reverify] subject-print gate failed:", err);
        }
      }
      results.push({ recordId: l.id, address: l.address, stillActive: fc.stillActive, credits: fc.creditsUsed, newLiveStatus: newLive, error: null });
      await audit({
        agent: "scout",
        event: "freshness_reverify",
        status: "confirmed_success",
        recordId: l.id,
        ms: 0,
        inputSummary: { url: l.verificationUrl, prior_last_verified: l.lastVerified ?? null },
        outputSummary: { still_active: fc.stillActive, new_live_status: newLive, renovated_language_veto: renovatedVeto, matched_renovation_keywords: fc.matchedKeywords.slice(0, 5), credits: fc.creditsUsed },
        decision: fc.stillActive ? (renovatedVeto ? "reconfirmed_active_renovated_veto" : "reconfirmed_active") : "marked_off_market",
      });
    } catch (err) {
      results.push({ recordId: l.id, address: l.address, stillActive: null, credits: 0, newLiveStatus: null, error: String(err).slice(0, 160) });
    }
  }

  return NextResponse.json({
    ok: true,
    mode: "apply",
    auth_kind: authKind,
    summary: {
      attempted: results.length,
      reconfirmed_active: results.filter((r) => r.stillActive === true).length,
      marked_off_market: results.filter((r) => r.stillActive === false).length,
      unresolved: results.filter((r) => r.error && r.stillActive === null).length,
      credits_used: creditsUsed,
      payment_required: paymentRequired,
      // Engaged-record spread watch (2026-08-01). watched counts records the
      // deal-protect class carried through this batch; alerts are minted
      // spread_threat cards. 0/0 on a batch with engaged records due means
      // they lost the budget race — check the partition, not the watcher.
      spread_watch: spreadWatch,
      // Subject-print gate (2026-08-02). checked bills a credit; skipped_flagged
      // is the 90-day KV dedupe working; unchecked = missing KV/address or an
      // infra miss (retried next pass) — a persistent unchecked count is a gap
      // to investigate, not a quiet success.
      subject_print: subjectPrint,
      bump_partition: {
        bump_due: bumpPool.length,
        core_due: corePool.length,
        core_taken: partition.coreTaken,
        bump_taken: partition.bumpTaken,
      },
    },
    results,
    duration_ms: Date.now() - t0,
  });
}
