// MLS-date backfill — projection helper (operator 2026-06-19).
// @agent: appraiser / scout
//
// Replicates the LIVE Airtable formula chain in code so the backfill can run a
// DRY projection (what would Stage_Calc / routing become if MLS_Date_Raw were
// populated) WITHOUT writing. Faithful to the schema read 2026-06-19:
//
//   DOM_Calc_V2     = DATETIME_DIFF(TODAY, LEFT(MLS_Date_Raw,10), 'days')
//   Distress_Score  = IF(AND(DOM, drops>=0), ROUND(DOM/30 + drops*2 + max(0,List-MAO)/10000, 2))
//   Distress_Bucket = <3 Low | <6 Moderate | <9 High | else Extreme  (BLANK if score BLANK)
//   distress gate   = bucket in {Moderate,High,Extreme}
//   Stage_Calc_V2   = Has_MLS_Date? -> price-floor -> sqft -> SFR -> retail/liquidity
//                     -> distress -> offer-math -> "Passed: Ready for Offer"
//   routing         = "Data Issue"* -> Manual Review;
//                     else (not Flagged & Passed & opener>0) -> Auto Proceed;
//                     else Passed -> Manual Review; else Reject
//
// PURE. No I/O.

export type DistressBucket = "Low" | "Moderate" | "High" | "Extreme";
export type Routing = "Auto Proceed" | "Manual Review" | "Reject";

export interface MlsProjectionInput {
  /** Re-fetched RentCast listing date (ISO) — null when not found in the re-pull. */
  listedDate: string | null;
  now: Date;
  listPrice: number | null;
  /** The operative MAO/opener (Underwritten_MAO): spread, math gate, retail gate, routing opener. */
  mao: number | null;
  /** Price_Drop_Count. */
  priceDrops: number | null;
  hasAgentPhone: boolean;
  /** Non-date gates — defaulted from the inputs / the cohort's verified-passing
   *  state, but parameterized so the helper is faithful for any record. */
  sizeOk?: boolean; // sqft >= 600 (cohort: all true)
  sfrOk?: boolean; // Property_Type contains "Single" (cohort: all true)
  liquidityOver?: boolean; // over the liquidity ceiling (cohort: all false)
  flagged?: boolean; // risk-flag (cohort: all "Clear")
}

export interface MlsProjection {
  hasMlsDate: boolean;
  dom: number | null;
  distressScore: number | null;
  distressBucket: DistressBucket | null;
  distressPass: boolean;
  stageCalc: string;
  routing: Routing;
  /** routing === "Auto Proceed" AND has an agent phone (i.e. actually sendable). */
  autoProceedSendable: boolean;
}

const DAY_MS = 86_400_000;

export function projectMlsRouting(i: MlsProjectionInput): MlsProjection {
  const hasMlsDate = !!i.listedDate;

  let dom: number | null = null;
  if (i.listedDate) {
    const t = Date.parse(i.listedDate.slice(0, 10)); // LEFT(MLS_Date_Raw, 10)
    if (Number.isFinite(t)) dom = Math.floor((i.now.getTime() - t) / DAY_MS);
  }

  const drops = i.priceDrops ?? 0;
  const spread = i.listPrice != null && i.mao != null ? i.listPrice - i.mao : 0;
  let distressScore: number | null = null;
  if (dom != null && drops >= 0) {
    distressScore = Math.round((dom / 30 + drops * 2 + Math.max(0, spread) / 10000) * 100) / 100;
  }
  const distressBucket: DistressBucket | null =
    distressScore == null ? null
      : distressScore < 3 ? "Low"
        : distressScore < 6 ? "Moderate"
          : distressScore < 9 ? "High"
            : "Extreme";
  const distressPass = distressBucket === "Moderate" || distressBucket === "High" || distressBucket === "Extreme";

  const priceFloorOk = i.listPrice != null && i.listPrice >= 10000;
  const sizeOk = i.sizeOk ?? true;
  const sfrOk = i.sfrOk ?? true;
  const retail = i.mao == null; // fldER5IGrBnHeYcTA: retail-reject only when MAO absent
  const liquidityOver = i.liquidityOver ?? false;
  const mathOk = i.mao != null && i.mao > 0;

  let stageCalc: string;
  if (!hasMlsDate) stageCalc = "Data Issue: Missing MLS Date";
  else if (!priceFloorOk) stageCalc = "Rejected: Price Floor";
  else if (!sizeOk) stageCalc = "Rejected: Too Small";
  else if (!sfrOk) stageCalc = "Rejected: Not SFR";
  else if (retail || liquidityOver) stageCalc = "Rejected: Retail or Liquidity";
  else if (!distressPass) stageCalc = "Rejected: No Distress";
  else if (!mathOk) stageCalc = "Rejected: Offer Math";
  else stageCalc = "Passed: Ready for Offer";

  const openerPositive = (i.mao ?? 0) > 0;
  let routing: Routing;
  if (stageCalc.startsWith("Data Issue")) routing = "Manual Review";
  else if (!i.flagged && stageCalc === "Passed: Ready for Offer" && openerPositive) routing = "Auto Proceed";
  else if (stageCalc === "Passed: Ready for Offer") routing = "Manual Review";
  else routing = "Reject";

  return {
    hasMlsDate,
    dom,
    distressScore,
    distressBucket,
    distressPass,
    stageCalc,
    routing,
    autoProceedSendable: routing === "Auto Proceed" && i.hasAgentPhone,
  };
}
