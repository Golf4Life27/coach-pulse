// Engaged-record spread watch — the operator-MANDATED watcher (2026-07-30).
// @agent: sentinel
//
// TWO PROVEN-COST RECEIPTS, same day:
//   · 3123 Sunbeam (spine rec9xEWDRoMChPugU): seller cut list $175K→$115K on
//     7/13 — ONE DAY after signing our $113,750 contract — putting the public
//     ask $1,250 above our contract price and vaporizing the assignment
//     spread. The cut sat invisible for 17 days; the operator learned it from
//     Zillow with his own eyes. price-drop-fastlane watches only the
//     empty-status first-touch pool; nothing watched a record UNDER CONTRACT.
//   · 716 8th Ct (spine recOx27aKmMHpwD2A): the listing went contingent with
//     another buyer — a STATUS transition, not a price — and was equally
//     invisible. The mandate is explicit: diff status, not just price.
//
// THE ECONOMICS this watches: a wholesale assignment fee exists only while
// the contract price sits meaningfully BELOW what a buyer would otherwise
// pay. The moment the seller's public ask falls to ~contract + fee, any end
// buyer can simply buy at list and the fee is gone. That is a same-day
// walk/renegotiate decision, not a close-week discovery.
//
// Pure. No I/O. The freshness-reverify route feeds it the scrape.

import { DEFAULT_WHOLESALE_FEE } from "@/lib/pre-contract-math";

export type SpreadVerdictKind =
  | "spread_dead"        // public ask ≤ protect price + fee — the arbitrage is gone
  | "price_cut_material" // ask fell hard but spread survives — renegotiation window
  | "status_inactive"    // page shows pending/contingent/sold — the 8th Ct class
  | "ok"
  | "unwatchable";       // no price basis on either side — say so, never guess

export interface SpreadWatchInput {
  /** Contract_Offer_Price when under contract, else the delivery-stamped
   *  sticky offer. NEVER a freshly computed number (INVARIANTS §3). */
  protectPriceUsd: number | null;
  /** List_Price as stored on the record (may be stale — that's the point). */
  storedListUsd: number | null;
  /** Price stated on the freshly scraped page. Null = page stated none. */
  scrapedListUsd: number | null;
  /** Scrape liveness — false = the page shows sold/pending/off-market. */
  stillActive: boolean;
  /** Inactive markers matched by the scrape, for the alert prose. */
  inactiveMarkers?: string[];
}

export interface SpreadVerdict {
  kind: SpreadVerdictKind;
  /** True → surface an operator decision (conveyor card + audit). */
  alert: boolean;
  /** Operator-readable one-liner; the card renders nothing longer. */
  detail: string;
  /** The fresh ask the verdict was judged against, when one existed. */
  freshAskUsd: number | null;
}

/** Material-cut threshold: a ≥5% drop on an ENGAGED record always matters —
 *  the seller is publicly repricing while negotiating with us. */
export const ENGAGED_CUT_ALERT_PCT = (() => {
  const raw = Number(process.env.ENGAGED_CUT_ALERT_PCT);
  return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : 0.05;
})();

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/** Pure: judge one engaged/under-contract record against its fresh scrape.
 *
 *  Order: liveness first (a sold/pending page makes the price moot — the
 *  8th Ct class), then spread-death, then the material-cut warning. The
 *  spread margin is the wholesale fee: an ask inside contract+fee means the
 *  fee has no room to exist. Sunbeam: 115,000 ≤ 113,750 + 15,000 → dead. */
export function judgeSpread(input: SpreadWatchInput): SpreadVerdict {
  if (!input.stillActive) {
    const markers = (input.inactiveMarkers ?? []).slice(0, 3).join(", ");
    return {
      kind: "status_inactive",
      alert: true,
      detail: `Listing no longer active${markers ? ` (${markers})` : ""} while we are engaged — the 716 8th Ct class. Verify with the agent: under contract elsewhere, or withdrawn?`,
      freshAskUsd: input.scrapedListUsd,
    };
  }

  const fresh = pos(input.scrapedListUsd);
  const stored = pos(input.storedListUsd);
  const protect = pos(input.protectPriceUsd);

  if (fresh == null) {
    // Page stated no price. Not an alert by itself — but never pretend we
    // checked. The caller records "unwatchable" so a silent gap stays visible.
    return {
      kind: "unwatchable",
      alert: false,
      detail: "Scrape found no stated price — spread unverified this pass.",
      freshAskUsd: null,
    };
  }

  if (protect != null && fresh <= protect + DEFAULT_WHOLESALE_FEE) {
    return {
      kind: "spread_dead",
      alert: true,
      detail:
        `SPREAD DEAD: public ask ${usd(fresh)} ≤ our ${usd(protect)} + ${usd(DEFAULT_WHOLESALE_FEE)} fee — ` +
        `any buyer can buy at list; the assignment fee has no room to exist. Walk or renegotiate TODAY (the Sunbeam class).`,
      freshAskUsd: fresh,
    };
  }

  if (stored != null && fresh < stored * (1 - ENGAGED_CUT_ALERT_PCT)) {
    const dropPct = Math.round(((stored - fresh) / stored) * 100);
    return {
      kind: "price_cut_material",
      alert: true,
      detail:
        `Seller cut the public ask ${usd(stored)} → ${usd(fresh)} (−${dropPct}%) while engaged with us. ` +
        `Spread survives${protect != null ? ` (our ${usd(protect)})` : ""} — but the seller is capitulating publicly; renegotiation window open.`,
      freshAskUsd: fresh,
    };
  }

  return { kind: "ok", alert: false, detail: `Ask ${usd(fresh)} unchanged within tolerance.`, freshAskUsd: fresh };
}

/** Statuses this watch protects. Mirrors the reverify's REPLY_BEARING set
 *  plus the contract stamp — which outranks any status field (a dead-status
 *  record with a live contract is still a deal; Sunbeam's status wobbled
 *  while the contract was the fact). */
export const SPREAD_WATCH_STATUSES: ReadonlySet<string> = new Set([
  "Negotiating",
  "Counter Received",
  "Offer Accepted",
]);

export function isSpreadWatchRecord(l: {
  outreachStatus?: string | null;
  contractExecutedAt?: string | null;
}): boolean {
  if (l.contractExecutedAt) return true;
  return SPREAD_WATCH_STATUSES.has((l.outreachStatus ?? "").trim());
}

function pos(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}
