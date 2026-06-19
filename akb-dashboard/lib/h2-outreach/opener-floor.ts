// Cheap per-ZIP opener floor — basis A (operator 2026-06-19). @agent: crier
//
// Caps the autonomous door-opener at a per-ZIP MAO proxy read from the
// already-seeded Buyer_Median_ZIP store ($0/property — a cached Airtable read,
// no per-property ARV/comp spend):
//
//   floor_proxy   = Buyer_Median(track) − Wholesale_Fee     (basis A)
//   offer         = MIN(door_opener, floor_proxy)
//
// NO rehab term and NO ZIP_ARV_Seed: the track is chosen by defaultBuyerTrack
// (the distressed cohort → LANDLORD), and a landlord median is an AS-IS
// PURCHASE price, so `median − fee` is the coherent Your_MAO with no rehab to
// subtract (subtracting one would double-count). The flipper lane — where the
// median is a renovated-resale basis that DOES need a rehab subtraction — is
// deliberately out of scope here.
//
// FAIL-OPEN: a ZIP with no seeded median (or a thin one, n < minN) yields a
// null floor → the door-opener passes through UNCAPPED. The floor only ever
// LOWERS an offer; it never blocks the text (that is the whole point of the
// 2026-06-19 model — the opener fires, the contract gate owns the money).
//
// PURE. No I/O — the caller reads the median (cached) and supplies it.

export interface OpenerFloorInput {
  /** The door-opener the floor caps — round(anchor × rough list-fraction
   *  ceiling), i.e. the ~65%-of-list number. */
  baseOpener: number;
  /** Seeded Buyer_Median for the chosen track, or null when the ZIP/track
   *  has no row. */
  buyerMedian: number | null;
  /** Comp count behind the median (the min-n quality gate input). */
  medianN: number | null;
  /** Wholesale fee subtracted from the median (the spread we keep). */
  wholesaleFee: number;
  /** Minimum comp count to trust a median as a floor (mirrors DD-3). */
  minN: number;
}

export interface OpenerFloorResult {
  /** Buyer_Median − fee, or null when no usable (present, positive, n≥minN)
   *  median exists → no floor (fail-open). */
  floorProxy: number | null;
  /** MIN(baseOpener, floorProxy) when the floor binds; else baseOpener. This
   *  is the would-be floored number REGARDLESS of any live flag — the caller
   *  decides whether to apply it. */
  flooredOpener: number;
  /** True when the floor caps the opener below the door-opener (the "floor
   *  bit"). */
  floorBit: boolean;
}

const positive = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;

/** Pure: compute the basis-A opener floor. Never throws; fail-open to the
 *  door-opener when the median is missing or thin. */
export function computeOpenerFloor(i: OpenerFloorInput): OpenerFloorResult {
  const usable = positive(i.buyerMedian) && (i.medianN ?? 0) >= i.minN;
  const floorProxy = usable ? Math.max(0, Math.round((i.buyerMedian as number) - i.wholesaleFee)) : null;
  const floorBit = floorProxy != null && floorProxy > 0 && floorProxy < i.baseOpener;
  const flooredOpener = floorBit ? (floorProxy as number) : i.baseOpener;
  return { floorProxy, flooredOpener, floorBit };
}
