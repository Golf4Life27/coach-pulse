// SEED QUALITY — are this seed's "comps" real transactions or a model's
// guesses wearing a comp costume? @agent: appraiser
//
// THE FINDING (2026-08-08, Dallas 75216 vs Memphis 38116). Both seeds are
// marked STRONG with "clean" filter quality. Their comp PRICES tell two
// different stories:
//
//   Memphis 38116 (disclosure): 144,999 · 149,900 · 250,000 · 137,000 ·
//     199,900 · 185,000 · 236,500 ... — transaction-shaped. Humans price
//     houses at 900s, 500s, 000s and the occasional 999.
//   Dallas 75216 (non-disclosure): 410,970 · 323,203 · 283,290 · 297,265 ·
//     246,933 · 423,272 · 475,589 ... — arbitrary to the dollar. NOBODY
//     sells a house for $423,272. These are AVM estimates returned where the
//     vendor cannot see real sale prices, then stored as "comps".
//
// An ARV built on estimates-dressed-as-comps inherits the model's error and
// launders it into "STRONG, clean" confidence — the exact risk
// arv_source_verified was invented to gate, except nothing was measuring it.
// (San Antonio 78211's $3,459/sqft seed is the same failure at cartoon scale.)
//
// THE TEST is the price's last two digits. Real transactions overwhelmingly
// land on 00 / 50 / 90 / 95 / 99 (149,900 · 236,500 · 144,999). Model output
// is uniform over the last two digits, so ~95% of it misses that set. With
// >=4 comps, a seed where fewer than half the prices look transaction-shaped
// is called AVM-priced. Pure, no I/O; wired as an independent corroboration
// signal so a pricer bug cannot disable its own check.

export type SeedPriceVerdict = "transaction_priced" | "avm_priced" | "insufficient";

/** Last-two-digit endings a human-negotiated sale price lands on. */
const TRANSACTION_ENDINGS = new Set([0, 50, 90, 95, 99]);

/** Minimum comps before the share means anything. */
export const SEED_QUALITY_MIN_COMPS = 4;

/** Below this share of transaction-shaped prices, the receipts are called
 *  AVM output. 0.5 is generous: real comp sets run ~100%; uniform model
 *  output runs ~5%. Env-tunable. */
export const SEED_QUALITY_MIN_TRANSACTION_SHARE = (() => {
  const raw = Number(process.env.SEED_QUALITY_MIN_TRANSACTION_SHARE);
  return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : 0.5;
})();

export interface SeedQuality {
  verdict: SeedPriceVerdict;
  compCount: number;
  transactionShare: number | null;
  detail: string;
}

/** Pure: is a single price transaction-shaped? */
export function isTransactionShapedPrice(price: number): boolean {
  if (!Number.isFinite(price) || price <= 0) return false;
  return TRANSACTION_ENDINGS.has(Math.round(price) % 100);
}

/** Pure: judge a seed's receipts by the shape of its comp prices.
 *
 *  Fails to "insufficient" (never "avm_priced") on unreadable receipts or too
 *  few comps — this signal exists to catch confident fiction, not to punish
 *  thin data, which other guards already handle. */
export function assessSeedPriceShape(receiptsJson: string | null | undefined): SeedQuality {
  let prices: number[] = [];
  try {
    const parsed = receiptsJson ? (JSON.parse(receiptsJson) as { comps?: Array<{ price?: unknown }> }) : null;
    if (parsed && Array.isArray(parsed.comps)) {
      prices = parsed.comps
        .map((c) => (typeof c.price === "number" && Number.isFinite(c.price) && c.price > 0 ? c.price : null))
        .filter((p): p is number => p != null);
    }
  } catch {
    /* unreadable → insufficient below */
  }

  if (prices.length < SEED_QUALITY_MIN_COMPS) {
    return {
      verdict: "insufficient",
      compCount: prices.length,
      transactionShare: null,
      detail: `${prices.length} usable comp prices (need ${SEED_QUALITY_MIN_COMPS}) — price-shape test not run`,
    };
  }

  const shaped = prices.filter(isTransactionShapedPrice).length;
  const share = shaped / prices.length;
  const verdict: SeedPriceVerdict =
    share >= SEED_QUALITY_MIN_TRANSACTION_SHARE ? "transaction_priced" : "avm_priced";
  return {
    verdict,
    compCount: prices.length,
    transactionShare: Math.round(share * 100) / 100,
    detail:
      verdict === "transaction_priced"
        ? `${shaped}/${prices.length} comp prices are transaction-shaped — receipts look like real sales`
        : `only ${shaped}/${prices.length} comp prices are transaction-shaped (e.g. real sales end 00/50/900/999) — ` +
          `these read as model ESTIMATES stored as comps; the ARV inherits the model's error, not market evidence`,
  };
}
