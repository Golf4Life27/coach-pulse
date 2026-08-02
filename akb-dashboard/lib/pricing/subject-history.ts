// Subject-print gate — the 9360 Cheyenne receipt (2026-08-02).
// @agent: appraiser
//
// THE PROVEN COST: Cheyenne's own deed history said everything — sold
// $45,000 on 2026-02-05 (public record), relisted $59,999 seven weeks
// later, cut to $49,999, then 130 days of market rejection. Our accepted
// $42,499 sat at 94% of the freshest as-is print, which means the
// assignment spread could not exist: the end buyer we needed at ~$47.5k
// was above BOTH real clearings. Nothing in the pipeline ever looked.
// The RentCast comp pull even carried an impeached $64,000 print for the
// subject (recorded $17k ABOVE the listing's own ask at the time) and
// missed the February sale entirely. The operator caught it by reading
// the Redfin price-history tab — the one tab a human checks first and
// the system never did. (Spine recrLkv1bRvWUyXFb.)
//
// THE RULE THIS ENFORCES: the subject's own recent recorded sale is the
// strongest as-is value evidence that exists — a raw fact traced to a
// county deed, exactly what pricing doctrine privileges over every
// derived field. An offer at ≥85% of a fresh print presumptively has no
// wholesale spread and must surface to the operator, never proceed on
// modeled ARV alone.
//
// Pure. No I/O. Callers fetch the deed print (lib/rentcast
// getSubjectRecordedSale — the /properties response we were ALREADY
// paying for and discarding) and feed it here.

export type SubjectPrintVerdictKind =
  | "recent_print_conflict" // offer ≥ guard% of a fresh subject print — spread presumptively dead
  | "seller_underwater"     // public ask below the seller's own recent basis — failing-flip seller
  | "ok"
  | "no_history";           // no recorded deed print — say so, never pretend we checked

export interface SubjectPrintInput {
  /** The number we are protecting: contract price, sticky offer, or the
   *  derived opener about to be queued. Null = nothing to judge. */
  offerUsd: number | null;
  /** Current public ask (freshest known). Used for the underwater read. */
  listUsd: number | null;
  /** Subject's most recent recorded sale price (deed data). */
  saleUsd: number | null;
  /** Deed date of that sale (ISO). */
  saleDateIso: string | null;
  /** Judgment time (ISO) — passed in so the judge stays pure/replayable. */
  asOfIso: string;
}

export interface SubjectPrintVerdict {
  kind: SubjectPrintVerdictKind;
  /** True → surface an operator decision (park + audit). */
  alert: boolean;
  /** Operator-readable one-liner. */
  detail: string;
  saleUsd: number | null;
  saleDateIso: string | null;
}

/** How far back a subject print stays binding evidence. Detroit's tape
 *  moves slowly; 18 months keeps a post-crash-era print from binding. */
export const SUBJECT_PRINT_WINDOW_MONTHS = (() => {
  const raw = Number(process.env.SUBJECT_PRINT_WINDOW_MONTHS);
  return Number.isFinite(raw) && raw > 0 && raw <= 60 ? raw : 18;
})();

/** Offer ÷ recent print at or above this = presumptively no spread. At
 *  0.85, a $45,000 print guards everything from $38,250 up — Cheyenne's
 *  $42,499 (0.944) trips it with room to spare. */
export const SUBJECT_PRINT_GUARD_PCT = (() => {
  const raw = Number(process.env.SUBJECT_PRINT_GUARD_PCT);
  return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : 0.85;
})();

const AVG_DAYS_PER_MONTH = 30.44;

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/** Pure: judge an offer/opener against the subject's own recorded sale.
 *  Cheyenne replay: offer 42,499 vs sale 45,000 (2026-02-05, judged
 *  2026-07-12) → recent_print_conflict. */
export function judgeSubjectPrint(input: SubjectPrintInput): SubjectPrintVerdict {
  const sale = pos(input.saleUsd);
  const saleDate = input.saleDateIso ? Date.parse(input.saleDateIso) : NaN;
  const asOf = Date.parse(input.asOfIso);

  if (sale == null || !Number.isFinite(saleDate) || !Number.isFinite(asOf)) {
    return {
      kind: "no_history",
      alert: false,
      detail: "No recorded deed print for the subject — print check unverified this pass.",
      saleUsd: null,
      saleDateIso: null,
    };
  }

  const monthsAgo = (asOf - saleDate) / (86_400_000 * AVG_DAYS_PER_MONTH);
  if (monthsAgo > SUBJECT_PRINT_WINDOW_MONTHS) {
    return {
      kind: "ok",
      alert: false,
      detail: `Last deed print ${usd(sale)} is ${Math.round(monthsAgo)} months old — outside the ${SUBJECT_PRINT_WINDOW_MONTHS}-month window.`,
      saleUsd: sale,
      saleDateIso: input.saleDateIso,
    };
  }

  const offer = pos(input.offerUsd);
  if (offer != null && offer >= sale * SUBJECT_PRINT_GUARD_PCT) {
    const pct = Math.round((offer / sale) * 100);
    return {
      kind: "recent_print_conflict",
      alert: true,
      detail:
        `RECENT PRINT CONFLICT: our ${usd(offer)} is ${pct}% of the subject's own ${usd(sale)} deed print ` +
        `(${input.saleDateIso?.slice(0, 10)}, ${Math.round(monthsAgo)}mo ago) — an end buyer must beat the freshest as-is ` +
        `clearing for any spread to exist. Verify dispo before this number stands (the 9360 Cheyenne class).`,
      saleUsd: sale,
      saleDateIso: input.saleDateIso,
    };
  }

  const list = pos(input.listUsd);
  if (list != null && list < sale) {
    return {
      kind: "seller_underwater",
      alert: true,
      detail:
        `Seller asking ${usd(list)} BELOW their own ${usd(sale)} basis from ${input.saleDateIso?.slice(0, 10)} — ` +
        `a failing exit (motivation signal), and the ask is capitulation pricing, not value evidence.`,
      saleUsd: sale,
      saleDateIso: input.saleDateIso,
    };
  }

  return {
    kind: "ok",
    alert: false,
    detail: `Offer clears the ${usd(sale)} print with margin.`,
    saleUsd: sale,
    saleDateIso: input.saleDateIso,
  };
}

function pos(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}
