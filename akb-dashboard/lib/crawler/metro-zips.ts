// The stops on the hunter's circuit.
// @agent: scout
//
// Drawn from the ZIPs the send lane already covers (h2-outreach send_cap
// coveredZips), minus every market the pricer cannot price. TX ZIPs are
// deliberately absent: Texas is a non-disclosure state, openerArvPctMax
// returns null there, and every listing found is rejected market_not_priceable
// before it can be priced or sent — 3 of 11 crawls on 2026-08-04 went to
// Houston for 262 raw listings and zero accepted.
//
// Metro labels match lib/buy-box TIER_BANDS so a ZIP's ask ceiling resolves
// from the same place the circuit schedules it.

export interface MetroZips {
  metro: string;
  state: string;
  zips: string[];
}

export const METRO_ZIPS: readonly MetroZips[] = [
  {
    metro: "Detroit",
    state: "MI",
    zips: [
      "48201", "48202", "48203", "48204", "48205", "48206", "48207", "48208",
      "48209", "48210", "48211", "48212", "48213", "48214", "48215", "48216",
      "48217", "48218", "48219", "48220", "48221", "48223", "48224", "48225",
      "48227", "48228", "48234", "48235", "48236", "48238", "48240", "48089",
    ],
  },
  {
    metro: "Cleveland",
    state: "OH",
    zips: ["44102", "44105", "44109", "44110", "44111", "44112", "44119", "44125", "44127", "44128"],
  },
  {
    metro: "Akron",
    state: "OH",
    zips: ["44301", "44305", "44307", "44310", "44314"],
  },
  {
    metro: "Youngstown",
    state: "OH",
    zips: ["44502", "44504", "44505", "44506", "44510", "44511"],
  },
  {
    metro: "Dayton",
    state: "OH",
    zips: ["45402", "45403", "45405", "45406", "45410", "45414", "45417", "45426"],
  },
  {
    metro: "Toledo",
    state: "OH",
    zips: ["43607", "43609", "43610", "43611"],
  },
  {
    metro: "Atlanta",
    state: "GA",
    zips: ["30310", "30311", "30314", "30315", "30316", "30318", "30331", "30344", "30354"],
  },
  {
    metro: "Indianapolis",
    state: "IN",
    zips: ["46201", "46203", "46208", "46218", "46219", "46222", "46224", "46226", "46227", "46235"],
  },
  {
    metro: "Birmingham",
    state: "AL",
    zips: ["35204", "35206", "35208", "35211", "35212", "35214", "35215", "35217", "35218", "35224"],
  },
  {
    metro: "Memphis",
    state: "TN",
    zips: ["38109", "38114", "38116", "38118", "38127", "38128"],
  },
];

/** Every ZIP on the circuit, for coverage checks. */
export const ALL_CIRCUIT_ZIPS: readonly string[] = METRO_ZIPS.flatMap((m) => m.zips);
