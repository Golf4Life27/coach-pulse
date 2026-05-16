// Phase 4C — Dual-Track Buyer Math.
//
// Two parallel buyer profiles compete for the same deal:
//
//   FLIPPER TRACK (cash investor renovating to resell)
//     InvestorMAO_F = ARV − Rehab − (ARV × closing_pct) − flipper_buyer_profit
//     YourMAO_F     = InvestorMAO_F − wholesale_fee
//
//   LANDLORD TRACK (buy-and-hold investor renting after rehab)
//     NOI            = (rent × 12) × (1 − vacancy) × (1 − opex_pct)
//     LandlordMaxOffer = NOI / cap_rate
//     YourMAO_L      = LandlordMaxOffer − Rehab − (LandlordMaxOffer × closing_pct)
//                      − landlord_buyer_profit − wholesale_fee
//
// The recommended track is whichever YourMAO is higher. When the landlord
// track exceeds the flipper track by more than the configured threshold,
// the deal is flagged for creative finance (seller-finance, sub-to, etc.)
// — that's the Sturtevant pattern in Bible v3.
//
// Pure functions, no I/O. Stateless endpoint and record-based wrapper
// both consume this.

import { capRateForZip, wholesaleFeeForZip, pricingRules } from "./config";

export type RecommendedTrack = "flipper" | "landlord" | "neither" | "tie";

export interface PricingMathInput {
  zip: string;
  arv_mid: number;
  rehab_mid: number;
  rent_monthly: number | null; // null = no rent data → landlord track skipped
}

export interface FlipperTrackResult {
  arv: number;
  rehab: number;
  closing_costs: number;
  buyer_profit: number;
  investor_mao: number;
  wholesale_fee: number;
  your_mao: number;
}

export interface LandlordTrackResult {
  rent_monthly: number;
  gross_annual: number;
  vacancy_loss: number;
  opex: number;
  noi: number;
  cap_rate: number;
  landlord_max_offer: number;
  rehab: number;
  closing_costs: number;
  buyer_profit: number;
  wholesale_fee: number;
  your_mao: number;
}

export interface PricingMathResult {
  zip: string;
  market: string;
  // Headline
  recommended_track: RecommendedTrack;
  creative_finance_flag: boolean;
  // Track breakdowns
  flipper: FlipperTrackResult | null;
  landlord: LandlordTrackResult | null;
  // Comparison
  your_mao_flipper: number | null;
  your_mao_landlord: number | null;
  delta_landlord_minus_flipper: number | null;
  // Transparency
  methodology_notes: string[];
  config_versions: {
    cap_rates: string;
    pricing_rules: string;
  };
  computed_at: string;
}

function computeFlipper(input: PricingMathInput, wholesaleFee: number): FlipperTrackResult {
  const arv = input.arv_mid;
  const rehab = input.rehab_mid;
  const closing = arv * pricingRules.closing_costs.pct_of_arv;
  const profit = pricingRules.flipper_track.buyer_profit_usd;
  const investor_mao = arv - rehab - closing - profit;
  const your_mao = investor_mao - wholesaleFee;
  return {
    arv,
    rehab,
    closing_costs: Math.round(closing),
    buyer_profit: profit,
    investor_mao: Math.round(investor_mao),
    wholesale_fee: wholesaleFee,
    your_mao: Math.round(your_mao),
  };
}

function computeLandlord(
  input: PricingMathInput,
  capRate: number,
  wholesaleFee: number,
): LandlordTrackResult | null {
  if (input.rent_monthly == null || input.rent_monthly <= 0) return null;
  const gross_annual = input.rent_monthly * 12;
  const vacancy_loss = gross_annual * pricingRules.landlord_track.vacancy_pct;
  const opex = (gross_annual - vacancy_loss) * pricingRules.landlord_track.opex_pct_of_gross_rent;
  const noi = gross_annual - vacancy_loss - opex;
  const landlord_max_offer = noi / capRate;
  const rehab = input.rehab_mid;
  const closing = landlord_max_offer * pricingRules.closing_costs.pct_of_arv;
  const profit = pricingRules.landlord_track.buyer_profit_usd;
  const your_mao = landlord_max_offer - rehab - closing - profit - wholesaleFee;
  return {
    rent_monthly: input.rent_monthly,
    gross_annual: Math.round(gross_annual),
    vacancy_loss: Math.round(vacancy_loss),
    opex: Math.round(opex),
    noi: Math.round(noi),
    cap_rate: capRate,
    landlord_max_offer: Math.round(landlord_max_offer),
    rehab,
    closing_costs: Math.round(closing),
    buyer_profit: profit,
    wholesale_fee: wholesaleFee,
    your_mao: Math.round(your_mao),
  };
}

export function computeDualTrackPricing(input: PricingMathInput): PricingMathResult {
  const notes: string[] = [];
  const { cap_rate, market } = capRateForZip(input.zip);
  const { floor_usd: wholesaleFee } = wholesaleFeeForZip(input.zip);

  notes.push(
    `Cap rate ${(cap_rate * 100).toFixed(2)}% (${market}) per cap_rates.json v${pricingRules.version}.`,
  );
  notes.push(
    `Wholesale fee floor $${wholesaleFee.toLocaleString()} per pricing_rules.json (Briefing §14 #6 default).`,
  );

  const flipper = computeFlipper(input, wholesaleFee);
  const landlord = computeLandlord(input, cap_rate, wholesaleFee);

  if (!landlord) {
    notes.push("No rent_monthly supplied — landlord track skipped. Recommended track defaults to flipper.");
  }

  const your_mao_flipper = flipper.your_mao;
  const your_mao_landlord = landlord?.your_mao ?? null;
  const delta = your_mao_landlord != null ? your_mao_landlord - your_mao_flipper : null;

  let recommended_track: RecommendedTrack;
  if (your_mao_landlord == null) {
    recommended_track = your_mao_flipper > 0 ? "flipper" : "neither";
  } else if (your_mao_flipper <= 0 && your_mao_landlord <= 0) {
    recommended_track = "neither";
    notes.push("Both tracks return negative YourMAO — no profitable offer exists at current inputs.");
  } else if (Math.abs(delta!) < 1000) {
    recommended_track = "tie";
  } else if (your_mao_landlord > your_mao_flipper) {
    recommended_track = "landlord";
  } else {
    recommended_track = "flipper";
  }

  const threshold = pricingRules.dual_track_decision.creative_finance_threshold_usd;
  const creative_finance_flag =
    delta != null && delta > threshold && recommended_track === "landlord";
  if (creative_finance_flag) {
    notes.push(
      `Landlord track exceeds flipper by $${delta!.toLocaleString()} (> $${threshold.toLocaleString()} threshold). Flag as creative-finance candidate (seller-finance, sub-to, etc.) — Sturtevant pattern.`,
    );
  }

  return {
    zip: input.zip,
    market,
    recommended_track,
    creative_finance_flag,
    flipper,
    landlord,
    your_mao_flipper,
    your_mao_landlord,
    delta_landlord_minus_flipper: delta,
    methodology_notes: notes,
    config_versions: {
      cap_rates: "v1 (2026-05-12)",
      pricing_rules: "v1 (2026-05-12)",
    },
    computed_at: new Date().toISOString(),
  };
}
