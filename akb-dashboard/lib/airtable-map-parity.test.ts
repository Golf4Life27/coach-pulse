// TWO-MAP RULE parity check (2026-07-14, the Mayfield counter miss).
//
// lib/airtable.ts historically held two independently-maintained Listing
// field maps: the fld-ID map (bulk reads — getListings /
// getActiveListingsForBrief, i.e. EVERY cron) and the name map (single-record
// getListing). A field added to only one was silently null on the other read
// path — which dropped Mayfield's $27k counter from the decision math and
// disabled the crons' draft idempotency.
//
// The maps are now BOTH mechanically derived from a single
// LISTING_FIELD_REGISTRY (see lib/airtable.ts), so divergence between the
// two derived maps is structurally impossible for any two-sided entry —
// there is nowhere for them to diverge from, they come from the same source
// array. This test:
//   1. Pins the exact derived-map contents against a characterization
//      snapshot taken of the pre-refactor maps (zero behavior change).
//   2. Guards the registry itself: no duplicate prop/fieldId/name, and every
//      entry declares at least one of fieldId/name.
//   3. Keeps the BOTH_PATH_PROPS pin for the historically-bitten fields as a
//      readable regression list (now redundant with #1/#2, kept for the
//      narrative trail).

import { describe, it, expect } from "vitest";
import {
  __TEST_LISTING_MAPS,
  __TEST_LISTING_NAME_MAP,
  __TEST_LISTING_FIELD_REGISTRY,
} from "./airtable";

/** Props that crons AND single-record consumers both depend on. Add every
 *  new machine-managed field here when you add it to the registry. */
const BOTH_PATH_PROPS = [
  "draftReplyText",
  "draftReplyMeta",
  "ddVolleyState",
  "buyerCeiling",
  "dealSpread",
  "allInPctArv",
  "decisionVerdict",
  "decisionReason",
  "decisionComputedAt",
  "decisionInputsHash",
  "underwriteConfidence",
  "latestCounterUsd",
  "openerBasis",
  "roughOpenerAmount",
  "contractOfferPrice",
  "lastInboundAt",
  "visionQueueState",
  "replyClassification",
  "replyClassifiedAt",
  "replyDecisionKind",
  "lastOutboundAt",
  // Back-half contract lifecycle (2026-07-14, the 3123 Sunbeam blind spot).
  "contractExecutedAt",
  "emdDueAt",
  "emdReceived",
  "optionDeadline",
  "closeDate",
  // Pre-contract gate (2026-07-16).
  "exitStrategy",
  "preContractWaivers",
  "suggestedExit",
];

// Characterization snapshot of LISTING_FIELDS (fld-ID -> prop), captured
// from the pre-refactor hand-maintained map. The registry-derived map must
// deep-equal this exactly.
const EXPECTED_LISTING_FIELDS: Record<string, string> = {
  "fldwvp72hKTfiHHjj": "address",
  "fldjbiNuHXzPzVWFk": "city",
  "fld9PTaKkgBNtvWbB": "zip",
  "fld9J3Vi9fTq3zzMU": "listPrice",
  "flduPNI7iLK8Yj07E": "mao",
  "fldfsGAAae2mGXzvC": "dom",
  "fldyOByFmw33i17I2": "offerTier",
  "fldCKnC1nnXEnTUKL": "liveStatus",
  "fldOrWvqKcc1g6Lka": "executionPath",
  "fldGIgqwyCJg4uFyv": "outreachStatus",
  "fldbRrOW3IEoLtnFE": "lastOutreachDate",
  "fld69oB0no6tfguom": "agentName",
  "fldee9MOstjNDKjnm": "agentPhone",
  "fldzdck2fhd6DZ3Oq": "agentEmail",
  "fldXrW8CWUphUfKgJ": "verificationUrl",
  "fldwKGxZly6O8qyPu": "notes",
  "fldwSjhdhEKVzpVRQ": "distressScore",
  "fldpFHAXujnz9x72x": "distressBucket",
  "fldnNSji9OLcDPRu9": "renovatedLanguage",
  "fld5GBaHtwvLY3sq8": "bedrooms",
  "fldvZ8hU1aREVg3Gs": "bathrooms",
  "fld5bKGJLlN7GmiE9": "buildingSqFt",
  "fldXf7Xhw5sBqNRWk": "yearBuilt",
  "fldWePZv07Xy5oQ3H": "portfolioDetected",
  "fldA8B9zOCneF0rjp": "stageCalc",
  "fldbYzkL24aQ1Y1xz": "approvedForOutreach",
  "fldyiFT48fudbF34k": "flipScore",
  "fldytROucQFdlPGLm": "offMarketOverride",
  "fldapf2ZXpIWTZfSX": "restrictionText",
  "fldZVZT98A6cEmJB3": "ddChecklist",
  "fldoXlPt9s6a1oopo": "doNotText",
  // Operator kill field (2026-07-28) — deliberate snapshot update, same commit as the registry entry.
  "fld26h40a81qH7uYP": "blacklist",
  "fldSlDQvgCyr0J8tI": "state",
  "fldTaEgWfHMDmfgaV": "sourceVersion",
  "fldkYeP8onCHil0pd": "actionHoldUntil",
  "fldiNKFpIBUYgg7el": "actionCardState",
  "fld3IhR1DXzcVuq6F": "lastInboundAt",
  // Vision queue (2026-07-31) — see lib/pricing/vision-queue.ts.
  "fldqgrBDtoRceShP2": "visionQueueState",
  // Reply-funnel triple (2026-07-31) — two-sided, so both derived maps carry it.
  "fld7vLOMdLthqccoy": "replyClassification",
  "fldoTXHschuUDi2Hx": "replyClassifiedAt",
  "fld13azWnqSx2YyoJ": "replyDecisionKind",
  "fldaK4lR5UNvycg11": "lastOutboundAt",
  // 2026-07-26 backfill of the five formerly name-only fields (IDs pulled
  // from the live schema; they were NULL on bulk reads until then):
  "flduNZ2G332OdVnp8": "gmailThreadIds",
  "fld1I0vcWZbp56GKc": "estRehabLow",
  "fldAcdeYJQbEyYNU2": "estRehabHigh",
  "fldKAwIU8InM0ycfi": "realArvLow",
  "fldXXIIgVvz4lvjVD": "realArvHigh",
  "fld4r1a94Uv8tVy5k": "draftReplyText",
  "fldlRrtCUBppUbQam": "draftReplyMeta",
  "fldjO7rbGYkdhB7dM": "ddVolleyState",
  "fldczfQMESZEhEOR3": "buyerCeiling",
  "fldlhhMf4IBd3i9iD": "dealSpread",
  "fldliR5VFMDfvwKOs": "allInPctArv",
  "fldzmptnwPFIR5iaU": "decisionVerdict",
  "fldVvFRx9rjCZeG4d": "decisionReason",
  "fld2W8U9RckaGdAL9": "decisionComputedAt",
  "fldaa58hwu6AWUDYU": "decisionInputsHash",
  "fldw0zfap0NbzqsO5": "underwriteConfidence",
  "fldVEInwbGdWOlt5F": "latestCounterUsd",
  "fldCjwSV2vLeui8Mf": "openerBasis",
  "fld4Jzjs8etKact6g": "lastEmailOutreachDate",
  "fldKPVG9qmbzxW5lK": "envelopeId",
  "fldSnAeUAn8cahN6R": "contractExecutedAt",
  "fldRbQ7I6pn9Iezvh": "emdDueAt",
  "fldUBxg2UHqZ3wvDS": "emdReceived",
  "fldNzqz8j4jU0mUCA": "optionDeadline",
  "fldMnnYbM9ThA779k": "closeDate",
  "fldBi5e0X6lUs7YPd": "exitStrategy",
  "fldbLKV9zX4MQeCHH": "preContractWaivers",
  "fldC3VIsmBxBGQRMW": "suggestedExit",
  "fldif6WwcJeXZtJcX": "mlsStatus",
  "fldrlbePeS9glaFQu": "propertyType",
  "fldg1j5wHJzoGJB0I": "priceDropCount",
  "fld2eUkKaC4pMjIdd": "lastVerified",
  "fldJt2pSCHiXqBxwj": "pipelineStage",
  "fld3lxWDerPs3rSNM": "rehabConfidenceScore",
  "fld0fWZGiFS73PPB7": "agentPriorOutreachCount",
  "fldmup8SvMky9eyag": "estRehab",
  "flduzFLSaFBfIl9Rn": "prevListPrice",
  "fldyDCVwvn9jfdiES": "estRehabMid",
  "fldRU4ITbMM4ZjaaK": "rehabEstimatedAt",
  "fldi3i6bnyzt2lKsu": "rehabLineItemsJson",
  "fldeLFgCV7jaf4Wn3": "rehabRedFlags",
  "fldhn2vxQipa3PVsX": "rehabSource",
  "fldoNZxSZqQsCLIW6": "realArvMedian",
  "fldrFB0owY6BnQewr": "estimatedMonthlyRent",
  "fldDcIiUajkvi8Wz3": "arvConfidence",
  "fldyukQHGzGdxoDGf": "arvCompCount",
  "fld9uJ3xRjkHGYruM": "arvCompAvgPrSqFt",
  "fldIrL7bFboOEr9vj": "arvCompDetailsJson",
  "fldSPxo0LRdGDBxcv": "wholesaleFeeTarget",
  "fldpmMwfqbXx6d58N": "buyerProfitTarget",
  "fldAtudyUDNgoPWLR": "investorMao",
  "fldd8EndI5IrBtETD": "yourMao",
  "fld5XgHjw4vohVVKa": "confirmedTaxes",
  "fldm8UB2wT9jkWvNs": "confirmedTaxesSource",
  "fldAvk2aIBU1Lh3Dz": "autoApproveV2",
  "fldvHDqtftWehMJR7": "arvValidatedAt",
  "fldzqlBceCXhQ9Vlq": "followUpCount",
  "fldoG27mxF1FQSRr9": "lastStatusCheckSentAt",
  "fldBFnL0HQJWahRov": "outreachOfferPrice",
  "fldfJWuEIHqaRuWq3": "contractOfferPrice",
  "fldiOvLQZaLpK7lTD": "roughOpenerAmount",
  "fldfEVJijfPOBulpc": "sellerMotivationScore",
  "fldusUTeJQ2ALX37U": "listPriceAtSend",
  "fldTSadqhYKeyKd89": "underwrittenMao",
  "fldFuePOkTlAl3NUT": "underwrittenMaoTrack",
  "fldJZpyn5uqYfP0Oc": "underwrittenPropertyMao",
};

// Characterization snapshot of LISTING_NAME_MAP (field NAME -> prop),
// captured from the pre-refactor hand-maintained map. The registry-derived
// map must deep-equal this exactly.
const EXPECTED_LISTING_NAME_MAP: Record<string, string> = {
  "Address": "address",
  "City": "city",
  "Zip": "zip",
  "List_Price": "listPrice",
  "MAO_V1": "mao",
  "DOM_Calc_V2": "dom",
  "Offer_Tier": "offerTier",
  "Live_Status": "liveStatus",
  "Execution_Path": "executionPath",
  "Outreach_Status": "outreachStatus",
  "Last_Outreach_Date": "lastOutreachDate",
  "Agent_Name": "agentName",
  "Agent_Phone": "agentPhone",
  "Agent_Email": "agentEmail",
  "Verification_URL": "verificationUrl",
  "Verification_Notes": "notes",
  "Distress_Score": "distressScore",
  "Distress_Bucket": "distressBucket",
  "Renovated_Language": "renovatedLanguage",
  "Bedrooms": "bedrooms",
  "Bathrooms": "bathrooms",
  "Building_SqFt": "buildingSqFt",
  "Year_Built": "yearBuilt",
  "Portfolio_Detected": "portfolioDetected",
  "Stage_Calc_V2": "stageCalc",
  "Approved_For_Outreach": "approvedForOutreach",
  "Flip_Score": "flipScore",
  "Off_Market_Override": "offMarketOverride",
  "Restriction_Text": "restrictionText",
  "DD_Checklist": "ddChecklist",
  "Do_Not_Text": "doNotText",
  "Blacklist": "blacklist",
  "State": "state",
  "Source_Version": "sourceVersion",
  "Action_Hold_Until": "actionHoldUntil",
  "Action_Card_State": "actionCardState",
  "Last_Inbound_At": "lastInboundAt",
  "Vision_Queue_State": "visionQueueState",
  "Reply_Classification": "replyClassification",
  "Reply_Classified_At": "replyClassifiedAt",
  "Reply_Decision_Kind": "replyDecisionKind",
  "Gmail_Thread_Ids": "gmailThreadIds",
  "Draft_Reply_Text": "draftReplyText",
  "Draft_Reply_Meta": "draftReplyMeta",
  "DD_Volley_State": "ddVolleyState",
  "Buyer_Ceiling": "buyerCeiling",
  "Deal_Spread": "dealSpread",
  "AllIn_Pct_ARV": "allInPctArv",
  "Decision_Verdict": "decisionVerdict",
  "Decision_Reason": "decisionReason",
  "Decision_Computed_At": "decisionComputedAt",
  "Decision_Inputs_Hash": "decisionInputsHash",
  "Underwrite_Confidence": "underwriteConfidence",
  "Latest_Counter_Usd": "latestCounterUsd",
  "Opener_Basis": "openerBasis",
  "Last_Outbound_At": "lastOutboundAt",
  "Last_Email_Outreach_Date": "lastEmailOutreachDate",
  "Envelope_ID": "envelopeId",
  "MLS_Status": "mlsStatus",
  "Property_Type": "propertyType",
  "Price_Drop_Count": "priceDropCount",
  "Last_Verified": "lastVerified",
  "Pipeline_Stage": "pipelineStage",
  "Contract_Executed_At": "contractExecutedAt",
  "EMD_Due_At": "emdDueAt",
  "EMD_Received": "emdReceived",
  "Option_Deadline": "optionDeadline",
  "Close_Date": "closeDate",
  "Exit_Strategy": "exitStrategy",
  "Pre_Contract_Waivers": "preContractWaivers",
  "Suggested_Exit": "suggestedExit",
  "Rehab_Confidence_Score": "rehabConfidenceScore",
  "Agent_Prior_Outreach_Count": "agentPriorOutreachCount",
  "Est_Rehab": "estRehab",
  "Prev_List_Price": "prevListPrice",
  "Follow_Up_Count": "followUpCount",
  "Last_Status_Check_Sent_At": "lastStatusCheckSentAt",
  "Outreach_Offer_Price": "outreachOfferPrice",
  "Contract_Offer_Price": "contractOfferPrice",
  "Underwritten_MAO": "underwrittenMao",
  "Underwritten_MAO_Track": "underwrittenMaoTrack",
  "Underwritten_Property_MAO": "underwrittenPropertyMao",
  "Seller_Motivation_Score": "sellerMotivationScore",
  "List_Price_At_Send": "listPriceAtSend",
  "Rehab_Est_Low": "estRehabLow",
  "Est_Rehab_Mid": "estRehabMid",
  "Rehab_Est_High": "estRehabHigh",
  "Rehab_Estimated_At": "rehabEstimatedAt",
  "Rehab_Line_Items_JSON": "rehabLineItemsJson",
  "Rehab_Red_Flags": "rehabRedFlags",
  "Rehab_Source": "rehabSource",
  "Real_ARV_Low": "realArvLow",
  "Real_ARV_High": "realArvHigh",
  "Real_ARV_Median": "realArvMedian",
  "Estimated_Monthly_Rent": "estimatedMonthlyRent",
  "ARV_Confidence": "arvConfidence",
  "ARV_Comp_Count": "arvCompCount",
  "ARV_Comp_Avg_PrSqFt": "arvCompAvgPrSqFt",
  "ARV_Comp_Details_JSON": "arvCompDetailsJson",
  "Wholesale_Fee_Target": "wholesaleFeeTarget",
  "Buyer_Profit_Target": "buyerProfitTarget",
  "Rough_Opener_Amount": "roughOpenerAmount",
  "Investor_MAO_V21": "investorMao",
  "Your_MAO_V21": "yourMao",
  "Annual_Taxes_Confirmed": "confirmedTaxes",
  "Annual_Taxes_Source": "confirmedTaxesSource",
  "Auto_Approve_v2": "autoApproveV2",
  "ARV_Validated_At": "arvValidatedAt",
};

describe("two-map rule: bulk (fld-ID) and single (name) reads see the same surface", () => {
  const idProps = new Set(Object.values(__TEST_LISTING_MAPS.byId));
  const nameProps = new Set(Object.values(__TEST_LISTING_NAME_MAP));

  for (const prop of BOTH_PATH_PROPS) {
    it(`"${prop}" is readable on BOTH paths`, () => {
      expect(idProps.has(prop), `missing from fld-ID map (bulk/cron reads)`).toBe(true);
      expect(nameProps.has(prop), `missing from name map (getListing)`).toBe(true);
    });
  }
});

describe("registry-derived maps match the pre-refactor characterization snapshot", () => {
  it("LISTING_FIELDS (fld-ID map) is byte-for-byte the same as before the registry refactor", () => {
    expect(__TEST_LISTING_MAPS.byId).toEqual(EXPECTED_LISTING_FIELDS);
  });

  it("LISTING_NAME_MAP is byte-for-byte the same as before the registry refactor", () => {
    expect(__TEST_LISTING_NAME_MAP).toEqual(EXPECTED_LISTING_NAME_MAP);
  });
});

describe("LISTING_FIELD_REGISTRY structural guards", () => {
  it("has no duplicate prop across entries", () => {
    const props = __TEST_LISTING_FIELD_REGISTRY.map((e) => e.prop);
    expect(new Set(props).size).toBe(props.length);
  });

  it("has no duplicate fieldId across entries", () => {
    const fieldIds = __TEST_LISTING_FIELD_REGISTRY
      .map((e) => e.fieldId)
      .filter((v): v is string => Boolean(v));
    expect(new Set(fieldIds).size).toBe(fieldIds.length);
  });

  it("has no duplicate name across entries", () => {
    const names = __TEST_LISTING_FIELD_REGISTRY
      .map((e) => e.name)
      .filter((v): v is string => Boolean(v));
    expect(new Set(names).size).toBe(names.length);
  });

  it("every entry declares at least one of fieldId/name", () => {
    for (const entry of __TEST_LISTING_FIELD_REGISTRY) {
      expect(
        Boolean(entry.fieldId) || Boolean(entry.name),
        `registry entry for prop "${entry.prop}" has neither fieldId nor name`
      ).toBe(true);
    }
  });
});
