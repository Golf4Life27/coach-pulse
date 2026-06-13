import { Listing, Deal, Buyer, ProspectiveBuyer } from "./types";
import { auditWriteDrift, type FieldDrift } from "./airtable-verify";
import { audit } from "./audit-log";
import { SOURCE_VERSION_FIELD_ID, SOURCE_VERSION_V2 } from "./source-version";

const AIRTABLE_PAT = process.env.AIRTABLE_PAT!;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";

const LISTINGS_TABLE = "tbldMjKBgPiq45Jjs";
const DEALS_TABLE = "tblKDYhaghKe6dToW";
const BUYERS_TABLE = "tbl4Rr07vq0mTftZB";
const PROSPECTIVE_BUYERS_TABLE = "tblyPAkwRyrlPIP59";

// Field IDs (used for list endpoints with returnFieldsByFieldId=true)
const LISTING_FIELDS: Record<string, string> = {
  fldwvp72hKTfiHHjj: "address",
  fldjbiNuHXzPzVWFk: "city",
  fld9PTaKkgBNtvWbB: "zip",
  fld9J3Vi9fTq3zzMU: "listPrice",
  flduPNI7iLK8Yj07E: "mao",
  fldfsGAAae2mGXzvC: "dom",
  fldyOByFmw33i17I2: "offerTier",
  fldCKnC1nnXEnTUKL: "liveStatus",
  fldOrWvqKcc1g6Lka: "executionPath",
  fldGIgqwyCJg4uFyv: "outreachStatus",
  fldbRrOW3IEoLtnFE: "lastOutreachDate",
  fld69oB0no6tfguom: "agentName",
  fldee9MOstjNDKjnm: "agentPhone",
  fldzdck2fhd6DZ3Oq: "agentEmail",
  fldXrW8CWUphUfKgJ: "verificationUrl",
  fldwKGxZly6O8qyPu: "notes",
  fldwSjhdhEKVzpVRQ: "distressScore",
  fldpFHAXujnz9x72x: "distressBucket",
  fld5GBaHtwvLY3sq8: "bedrooms",
  fldvZ8hU1aREVg3Gs: "bathrooms",
  fld5bKGJLlN7GmiE9: "buildingSqFt",
  fldXf7Xhw5sBqNRWk: "yearBuilt",
  fldWePZv07Xy5oQ3H: "portfolioDetected",
  fldA8B9zOCneF0rjp: "stageCalc",
  fldbYzkL24aQ1Y1xz: "approvedForOutreach",
  fldyiFT48fudbF34k: "flipScore",
  fldytROucQFdlPGLm: "offMarketOverride",
  fldapf2ZXpIWTZfSX: "restrictionText",
  fldZVZT98A6cEmJB3: "ddChecklist",
  fldoXlPt9s6a1oopo: "doNotText",
  fldSlDQvgCyr0J8tI: "state",
  [SOURCE_VERSION_FIELD_ID]: "sourceVersion",
  fldkYeP8onCHil0pd: "actionHoldUntil",
  fldiNKFpIBUYgg7el: "actionCardState",
  fld3IhR1DXzcVuq6F: "lastInboundAt",
  fldaK4lR5UNvycg11: "lastOutboundAt",
  // Phase 11.2 (5/18) — email-attributable outbound send timestamp.
  // Crier staleness math takes max() across this + lastOutreachDate
  // (SMS) + lastInboundAt + lastOutboundAt so active email negotiations
  // no longer surface as false-stale. Written by lib/gmail.ts sendEmail
  // when a listing recordId is in scope.
  fld4Jzjs8etKact6g: "lastEmailOutreachDate",
  // Phase 5.4 (5/18) — DocuSign envelope attribution. Single-line text
  // (envelope GUID). Written by the "Track in Scribe" affordance on
  // the deal-detail page; read by components/ScribeDealCommentary.tsx
  // to surface envelope status from briefing.external_signals.docusign.
  fldKPVG9qmbzxW5lK: "envelopeId",
  // ── Pre-Outreach Gate (orchestrator Gate 1) inputs
  fldif6WwcJeXZtJcX: "mlsStatus",
  fldrlbePeS9glaFQu: "propertyType",
  fldg1j5wHJzoGJB0I: "priceDropCount",
  fld2eUkKaC4pMjIdd: "lastVerified",
  fldJt2pSCHiXqBxwj: "pipelineStage",
  // ── Pre-Send Gate (orchestrator Gate 2) inputs
  fld3lxWDerPs3rSNM: "rehabConfidenceScore",
  fld0fWZGiFS73PPB7: "agentPriorOutreachCount",
  // ── Pre-Negotiation Gate (orchestrator Gate 3) inputs
  fldmup8SvMky9eyag: "estRehab",
  // ── D3 Phase 0b math-filter inputs (formula fields read-only by design)
  flduzFLSaFBfIl9Rn: "prevListPrice",
  fldyDCVwvn9jfdiES: "estRehabMid",
  // Phase 4B.1 — Appraiser rehab endpoint writes these:
  fldRU4ITbMM4ZjaaK: "rehabEstimatedAt",
  fldi3i6bnyzt2lKsu: "rehabLineItemsJson",
  fldeLFgCV7jaf4Wn3: "rehabRedFlags",
  // INV-005 — Rehab_Source provenance (vision | manual_operator | manual_partner).
  // Auxiliary to rehabConfidenceScore (numeric). Per Constitution Rule 3,
  // manual values are fallback-only — vision must fail first.
  fldhn2vxQipa3PVsX: "rehabSource",
  // INV-029 — Pre-EMD Gate operator-verify flags (checkboxes).
  fldoNZxSZqQsCLIW6: "realArvMedian",
  // Phase 4C.1 — RentCast AVM rent estimate, drives landlord-track MAO.
  fldrFB0owY6BnQewr: "estimatedMonthlyRent",
  // Phase 4A.1 — Appraiser ARV endpoint writes these fields (existing
  // pricing route writes Real_ARV_* but leaves comp count + avg + JSON
  // unwritten). New /api/agents/appraiser/arv/[recordId] fills them.
  fldDcIiUajkvi8Wz3: "arvConfidence",
  fldyukQHGzGdxoDGf: "arvCompCount",
  fld9uJ3xRjkHGYruM: "arvCompAvgPrSqFt",
  fldIrL7bFboOEr9vj: "arvCompDetailsJson",
  // V2.1 floor inputs the new endpoint reads (defaults Bible v3 §9):
  //   wholesaleFeeTarget default 15000, buyerProfitTarget default 30000
  fldSPxo0LRdGDBxcv: "wholesaleFeeTarget",
  fldpmMwfqbXx6d58N: "buyerProfitTarget",
  // ── ECONOMICS QUARANTINE (2026-06-05) ────────────────────────────────
  // Investor_MAO / Your_MAO (flds Hh.. / fE..) are LEGACY FORMULA fields:
  //   Your_MAO = ARV − rehab − ARV*0.13 − IF(profit,_,30000) − IF(fee,_,15000)
  // i.e. ARV-driven (banned AVM basis) with the legacy $30k/$15k constants
  // (empty record → −45,000). They are READ-ONLY via API and must NOT be
  // treated as economic truth. We map the JS props `investorMao`/`yourMao`
  // to the CLEAN, writable V2.1 fields instead, so every reader gets the
  // V2.1 value (null → HOLD until the triage worker computes it). The
  // legacy formula fields are intentionally NOT mapped (renamed legacy_*
  // in Airtable); nothing reads them for decisions.
  fldAtudyUDNgoPWLR: "investorMao", // Investor_MAO_V21 (clean)
  fldd8EndI5IrBtETD: "yourMao",     // Your_MAO_V21 (clean)
  // ── Tax confirmed-override (2026-06-06). Confirmed values are
  // operator/CAD-sourced and survive the V2.1 cron's re-runs (the
  // structural anti-regression — Spine-only Bexar fact regressed
  // Callaghan to $555 RentCast tax). When confirmedTaxes is present,
  // the cron USES it and NEVER writes Annual_Taxes_Confirmed.
  fld5XgHjw4vohVVKa: "confirmedTaxes",
  fldm8UB2wT9jkWvNs: "confirmedTaxesSource",
  fldAvk2aIBU1Lh3Dz: "autoApproveV2",
  fldvHDqtftWehMJR7: "arvValidatedAt",
  // ── D3 cadence inputs
  fldzqlBceCXhQ9Vlq: "followUpCount",
  fldoG27mxF1FQSRr9: "lastStatusCheckSentAt",
  // Phase 20.2 v1.3 amendment (5/18) — Stored_Offer_Price renamed to
  // Outreach_Offer_Price. Field id preserved; existing data carried.
  // Semantic split: outreachOfferPrice = sticky 65% set at outreach;
  // contractOfferPrice = set at negotiation/DD; sellerMotivationScore
  // = 1-5 rubric. See Listing type in lib/types.ts for full notes.
  fldBFnL0HQJWahRov: "outreachOfferPrice",
  fldfJWuEIHqaRuWq3: "contractOfferPrice",
  fldfEVJijfPOBulpc: "sellerMotivationScore",
  fldusUTeJQ2ALX37U: "listPriceAtSend",
  // Underwritten_MAO (operator 2026-06-09): the COMPUTED MAO ceiling the
  // opener guard reads at send time. Distinct from contractOfferPrice
  // (V2.1-reserved for the DD-time contract number set by the INV-023 gate
  // after CMA + rehab — that field MUST stay empty until DD).
  fldTSadqhYKeyKd89: "underwrittenMao",
  fldFuePOkTlAl3NUT: "underwrittenMaoTrack",
  // Your_MAO formula field — operator brief 2026-06-13 (spine
  // recZ6tBZRmfFOLwqo): the per-record penciling ceiling that drives
  // the autonomous opener. Maverick hand-checked 26 fully-populated
  // Detroit records 6/12 against this formula; it's correct. Formula
  // is read-only; the autonomous send refuses on null/≤0 (hard gate).
  fldfE06eS402RcPCN: "yourMaoFormula",
  // Underwritten_Property_MAO (keystone rewrite 2026-06-12, adjudication
  // recXJrM7EYK3pEFmF item 5): the ONLY field that authorizes Tier-C
  // autonomous property-up pricing. Underwritten_MAO above is demoted to
  // informational the same commit — it never authorizes a send again.
  fldJZpyn5uqYfP0Oc: "underwrittenPropertyMao",
};

// Reverse map: field name -> prop name (for single-record GET which returns field names)
const LISTING_NAME_MAP: Record<string, string> = {
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
  "State": "state",
  "Source_Version": "sourceVersion",
  "Action_Hold_Until": "actionHoldUntil",
  "Action_Card_State": "actionCardState",
  "Last_Inbound_At": "lastInboundAt",
  "Last_Outbound_At": "lastOutboundAt",
  "Last_Email_Outreach_Date": "lastEmailOutreachDate",
  "Envelope_ID": "envelopeId",
  // ── Pre-Outreach Gate (orchestrator Gate 1)
  "MLS_Status": "mlsStatus",
  "Property_Type": "propertyType",
  "Price_Drop_Count": "priceDropCount",
  "Last_Verified": "lastVerified",
  "Pipeline_Stage": "pipelineStage",
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
  // ── Phase 3: photo analysis / rehab ──────────────────────────────────────
  // Field-name audit 2026-06-04 (Spine recd9RNKGWOWjjDzz): canonical
  // schema uses Rehab_Est_Low / Rehab_Est_High (prefix-swapped from
  // the older Est_Rehab_Low/High names). The 8 fields below the rehab
  // block (Photo_Confidence / Line_Items_JSON / Red_Flags /
  // Photo_Analyzed_At / Visual_Verified / Visual_Source /
  // Pre_Offer_Screen_* / DD_Volley_Text_*) DO NOT EXIST in the
  // Listings_V1 schema and their mappings were removed — they always
  // read null, so any consumer that gated on them was effectively
  // dead code. Flagged for operator: see audit report.
  // Schema field names are Rehab_Est_Low / Rehab_Est_High; the JS prop
  // names retain the legacy Est_Rehab_Low / Est_Rehab_High shape to
  // avoid a ripple-rename across consumers (3+ readers in pipeline,
  // appraiser-panel, etc.). Translation lives here.
  "Rehab_Est_Low": "estRehabLow",
  "Est_Rehab_Mid": "estRehabMid",
  "Rehab_Est_High": "estRehabHigh",
  "Rehab_Estimated_At": "rehabEstimatedAt",
  "Rehab_Line_Items_JSON": "rehabLineItemsJson",
  "Rehab_Red_Flags": "rehabRedFlags",
  "Rehab_Source": "rehabSource",
  // ── Phase 3: ARV validation ──────────────────────────────────────────────
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
  // Economics quarantine (see ID-map note): map to the clean V2.1 fields,
  // NOT the legacy ARV-driven formula fields (legacy_Investor_MAO /
  // legacy_Your_MAO in Airtable). null → HOLD until V2.1 computes.
  "Investor_MAO_V21": "investorMao",
  "Your_MAO_V21": "yourMao",
  "legacy_Your_MAO": "yourMaoFormula",
  "Annual_Taxes_Confirmed": "confirmedTaxes",
  "Annual_Taxes_Source": "confirmedTaxesSource",
  "Auto_Approve_v2": "autoApproveV2",
  "ARV_Validated_At": "arvValidatedAt",
};

const DEAL_FIELDS: Record<string, string> = {
  fld2AaqbSahBMY62j: "propertyAddress",
  fldoVbMXZxZV08sqG: "city",
  fldfGiKZL970cvftH: "state",
  fldGZO10DHc9evl0L: "contractPrice",
  fldnxxzcMRzL1j1hJ: "offerPrice",
  flddXvwvKdx47Xa9X: "assignmentFee",
  flddrZGXOxRn2BqNA: "estimatedRepairs",
  fld00Ag0rvgtUu48R: "arv",
  fldned9bMeMSKWruL: "status",
  fldTvNokAK5AEqz9z: "closingStatus",
  fldIPt7nba0nRom66: "assignmentExecutedAt",
  fldetLaT9GjdOFFKE: "closingScheduledDate",
  fld7KTawggpBzGwzh: "dispoReady",
  fldACzlhQcnEfy4D4: "propertyImageUrl",
  fldxsnwsG1wExkW96: "beds",
  fldPSZKOxGvU7sLY8: "baths",
  fldExcij4rL2mmYdb: "sqft",
  fldWIL8UzG6y2zjY0: "buyerBlastStatus",
  fldi7i3WinAohQ3aS: "actionCardState",
  fldDmZjkunw6iZujf: "actionHoldUntil",
  // INV-023 Pre-EMD DD gate (2026-06-10) — see lib/types.ts Deal notes.
  fldCEhZ0mrTuWpT1N: "preEmdCmaValidated",
  fldFBxhUHiL4Ubwly: "preEmdCmaValidatedAt",
  flduHcfAaVwuc9OF0: "preEmdArvConfirmed",
  fldvjGx7ZWQCqGJD1: "preEmdPhotosValidated",
  fldBAUjTY2f7tFoVz: "preEmdPhotosValidatedAt",
  fld2cRlf7QqBFP1ul: "preEmdAssignmentClauseVerified",
  fldYkXU9LH7dvjtEP: "preEmdOperatorSignoff",
  fldWWyYkYKHHCyN0x: "preEmdOperatorSignoffBy",
  fldpIDLp5OJiRCcVY: "preEmdOperatorSignoffAt",
  fld0jGPvjhu8D9WxA: "preEmdMathGate",
  fld9aWL701m6iA208: "preEmdVerdict",
  flddHJgP946flv88F: "preEmdLastEvaluatedAt",
  fldWMw8y7FFBdGYOn: "preEmdHoldReasons",
};

const BUYER_FIELDS: Record<string, string> = {
  fldN8egymEy2rQTrt: "buyerName",
  fld7ImZoouFS2Zok2: "buyerEmail",
  fldGGjLc0DUeHVsK7: "buyerStatus",
  fld0ASNdbqufj8e0Y: "preferredCities",
  fldzL2ooNWPZbxJOa: "cashBuyer",
  fldgjfPuBQkfRoebT: "proofOfFundsOnFile",
  fldhZbgY7oTHbuFTO: "buyerActiveFlag",
};

const PROSPECTIVE_BUYER_FIELDS: Record<string, string> = {
  fldOrnnfmI3huae9a: "fullName",
  fld40Mhlket7Rvr8a: "company",
  fld9b74PzwutvTKH2: "email",
  fldSwN77Rwehkd5Ng: "phone",
  fldfBtfELGGVm5eOW: "propertyPurchased",
  fldbfuK1wvXgLkOFL: "city",
  fldImgIVFblhQLLUy: "zip",
  fldzEtrD7OrWZLdjz: "source",
  fld3mac8sg2dWtX0z: "outreachStatus",
  fldRCclcXWtMSg1i5: "lastContacted",
  fldoTwSEJX4ulN3tz: "notes",
};

// Simple in-memory cache
const cache: Record<string, { data: unknown; timestamp: number }> = {};
const CACHE_TTL = 60_000; // 60 seconds

function getCached<T>(key: string): T | null {
  const entry = cache[key];
  if (entry && Date.now() - entry.timestamp < CACHE_TTL) {
    return entry.data as T;
  }
  return null;
}

function setCache(key: string, data: unknown): void {
  cache[key] = { data, timestamp: Date.now() };
}

async function fetchAllRecords(
  tableId: string,
  fieldIds: string[]
): Promise<Record<string, unknown>[]> {
  return fetchRecords(tableId, fieldIds);
}

interface FetchRecordsOptions {
  filterByFormula?: string;
  maxRecords?: number;
  // Sort with field NAMES (not ids) — applies after the filter.
  sort?: Array<{ field: string; direction?: "asc" | "desc" }>;
}

async function fetchRecords(
  tableId: string,
  fieldIds: string[],
  opts: FetchRecordsOptions = {}
): Promise<Record<string, unknown>[]> {
  const allRecords: Record<string, unknown>[] = [];
  let offset: string | undefined;
  let collected = 0;

  do {
    const params = new URLSearchParams();
    fieldIds.forEach((f) => params.append("fields[]", f));
    params.set("returnFieldsByFieldId", "true");
    if (opts.filterByFormula) params.set("filterByFormula", opts.filterByFormula);
    if (opts.sort) {
      opts.sort.forEach((s, i) => {
        params.append(`sort[${i}][field]`, s.field);
        if (s.direction) params.append(`sort[${i}][direction]`, s.direction);
      });
    }
    if (opts.maxRecords) {
      const remaining = Math.min(100, opts.maxRecords - collected);
      params.set("pageSize", String(remaining));
    }
    if (offset) params.set("offset", offset);

    const url = `https://api.airtable.com/v0/${BASE_ID}/${tableId}?${params.toString()}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${AIRTABLE_PAT}` },
      cache: "no-store",
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Airtable error ${res.status}: ${errText}`);
    }

    const data = await res.json();
    for (const rec of data.records) {
      allRecords.push(rec);
      collected += 1;
      if (opts.maxRecords && collected >= opts.maxRecords) return allRecords;
    }
    offset = data.offset;
  } while (offset);

  return allRecords;
}

function mapRecord<T>(
  record: Record<string, unknown>,
  fieldMap: Record<string, string>
): T {
  const fields = record.fields as Record<string, unknown>;
  const mapped: Record<string, unknown> = { id: record.id };

  for (const [fieldId, propName] of Object.entries(fieldMap)) {
    mapped[propName] = fields[fieldId] ?? null;
  }

  return mapped as T;
}

function mapRecordByName<T>(
  record: Record<string, unknown>,
  nameMap: Record<string, string>
): T {
  const fields = record.fields as Record<string, unknown>;
  const mapped: Record<string, unknown> = { id: record.id };

  // Map known field names to prop names
  for (const [fieldName, propName] of Object.entries(nameMap)) {
    mapped[propName] = fields[fieldName] ?? null;
  }

  // For any prop not yet set, try the prop name directly as a field name
  // (handles cases where Airtable field name matches our prop name)
  const mappedProps = new Set(Object.values(nameMap));
  for (const [fieldName, value] of Object.entries(fields)) {
    const camel = fieldName.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    if (!mappedProps.has(camel) && value !== undefined) {
      mapped[camel] = value;
    }
  }

  return mapped as T;
}

// Default returns the FULL base (v1 legacy + v2) — data-layer callers
// (dedupe, prior-contact counts, cleanup, reconcile) depend on seeing every
// record. Pass { includeLegacy: false } to get the v2 active surface only
// (INV-LEGACY-BACKSTOP); operator-facing display endpoints opt into that.
export async function getListings(opts: { includeLegacy?: boolean } = {}): Promise<Listing[]> {
  const cacheKey = "listings";
  let listings = getCached<Listing[]>(cacheKey);
  if (!listings) {
    const records = await fetchAllRecords(
      LISTINGS_TABLE,
      Object.keys(LISTING_FIELDS)
    );
    listings = records.map((r) => mapRecord<Listing>(r, LISTING_FIELDS));
    setCache(cacheKey, listings);
  }
  if (opts.includeLegacy === false) {
    return listings.filter((l) => l.sourceVersion === SOURCE_VERSION_V2);
  }
  return listings;
}

// Server-side-filtered active listings — only the records the brief care
// about. Used by /api/jarvis-brief Pass 1 to avoid pulling all ~1,200
// records into memory before filtering.
//
// Includes:
//   - Negotiating, Response Received, Counter Received, Offer Accepted
//     (always, regardless of recency)
//   - Texted, Emailed where Last_Outreach_Date is within recentDays
export async function getActiveListingsForBrief(opts: {
  recentDays?: number;
  cacheKey?: string;
} = {}): Promise<Listing[]> {
  const recentDays = opts.recentDays ?? 7;
  const cacheKey = opts.cacheKey ?? `listings:active:${recentDays}d`;
  const cached = getCached<Listing[]>(cacheKey);
  if (cached) return cached;

  const formula = `OR(
    {Outreach_Status}='Negotiating',
    {Outreach_Status}='Response Received',
    {Outreach_Status}='Counter Received',
    {Outreach_Status}='Offer Accepted',
    AND({Outreach_Status}='Texted', IS_AFTER({Last_Outreach_Date}, DATEADD(NOW(), -${recentDays}, 'days'))),
    AND({Outreach_Status}='Emailed', IS_AFTER({Last_Outreach_Date}, DATEADD(NOW(), -${recentDays}, 'days')))
  )`.replace(/\s+/g, " ");

  const records = await fetchRecords(LISTINGS_TABLE, Object.keys(LISTING_FIELDS), {
    filterByFormula: formula,
  });
  const listings = records.map((r) => mapRecord<Listing>(r, LISTING_FIELDS));
  setCache(cacheKey, listings);
  return listings;
}

// Resurrection candidate fetch — Dead-status records with a Last_Inbound_At
// within maxAgeDays, sorted newest-inbound-first, hard capped at `cap`.
//
// We intentionally filter on Last_Inbound_At (not the kill date) because
// resurrection requires a fresh inbound to even be possible — this is the
// sharpest filter that excludes long-dormant Dead records.
export async function getRecentlyDeadCandidates(opts: {
  maxAgeDays?: number;
  cap?: number;
} = {}): Promise<Listing[]> {
  const maxAgeDays = opts.maxAgeDays ?? 30;
  const cap = opts.cap ?? 50;
  const cacheKey = `listings:dead-recent:${maxAgeDays}d:${cap}`;
  const cached = getCached<Listing[]>(cacheKey);
  if (cached) return cached;

  const formula = `AND(
    OR({Outreach_Status}='Dead', {Outreach_Status}='Walked', {Outreach_Status}='Terminated', {Outreach_Status}='No Response'),
    {Last_Inbound_At},
    IS_AFTER({Last_Inbound_At}, DATEADD(NOW(), -${maxAgeDays}, 'days'))
  )`.replace(/\s+/g, " ");

  const records = await fetchRecords(LISTINGS_TABLE, Object.keys(LISTING_FIELDS), {
    filterByFormula: formula,
    sort: [{ field: "Last_Inbound_At", direction: "desc" }],
    maxRecords: cap,
  });
  const listings = records.map((r) => mapRecord<Listing>(r, LISTING_FIELDS));
  setCache(cacheKey, listings);
  return listings;
}

// Rehab-sweep candidate selection (2026-06-05). The appraiser backfill
// was crawling the brief's active set in lexicographic id order and
// burning calls on records with NO Verification_URL (Firecrawl can't
// fire → vision falls back to Street-View-only → preflight refusal).
// Sourcing reality from the base: ~1,751 active records HAVE a
// Verification_URL, ~396 don't (~82% coverage) — the pool isn't
// starved, the selection was just wrong.
//
// This fetcher selects the records that can ACTUALLY produce a
// vision-based rehab: Live_Status = "Active" AND Verification_URL is
// non-empty. Server-side filtered (filterByFormula) so we never pull
// the URL-less records into memory just to drop them. Sorted by id for
// a deterministic cursor (?after=) — order within the filtered set is
// irrelevant now that every record in it has a URL.
export async function getRehabSweepCandidates(opts: {
  maxRecords?: number;
} = {}): Promise<Listing[]> {
  // NOT({Verification_URL}='') excludes both empty-string and blank
  // (Airtable treats a never-set url field as "").
  const formula = `AND({Live_Status}='Active', NOT({Verification_URL}=''))`;
  const records = await fetchRecords(LISTINGS_TABLE, Object.keys(LISTING_FIELDS), {
    filterByFormula: formula,
    sort: [{ field: "Address", direction: "asc" }],
    maxRecords: opts.maxRecords,
  });
  return records.map((r) => mapRecord<Listing>(r, LISTING_FIELDS));
}

// Verification_URL coverage over the active population (2026-06-05).
// Surfaced as a Pulse metric so the URL-coverage gap (the thing that
// was starving the rehab sweep) stays visible after this cycle. One
// server-side-filtered pass over Live_Status=Active records pulling
// ONLY the Verification_URL field — counts non-empty vs total. Cheap
// (~22 page fetches for ~2.1k records, well within a Pulse scan's 60s).
export interface VerificationUrlCoverage {
  activeTotal: number;
  withUrl: number;
  withoutUrl: number;
  /** 0-100, rounded to 1 decimal. 0 when activeTotal is 0. */
  coveragePct: number;
}

// URL-less active candidates for the Firecrawl URL backfill (2026-06-05).
// Live_Status=Active AND Verification_URL empty — the ~396 records that
// can't be rehab-swept until a URL is resolved. Server-side filtered.
export async function getUrlLessActiveCandidates(opts: {
  maxRecords?: number;
} = {}): Promise<Listing[]> {
  // Exclude records the backfill already attempted and couldn't confirm
  // (Verification_Source='firecrawl_url_unresolved') so a static-path
  // cron advances through the full set instead of spinning on the
  // unconfirmable ones at the front of the id sort. Those stay URL-less
  // (correctly — no confirmed portal page) but drop out of the retry
  // pool; a future re-listing re-opens them via normal intake/verify.
  const formula = `AND({Live_Status}='Active', {Verification_URL}='', {Verification_Source}!='firecrawl_url_unresolved')`;
  const records = await fetchRecords(LISTINGS_TABLE, Object.keys(LISTING_FIELDS), {
    filterByFormula: formula,
    sort: [{ field: "Address", direction: "asc" }],
    maxRecords: opts.maxRecords,
  });
  return records.map((r) => mapRecord<Listing>(r, LISTING_FIELDS));
}

export async function getActiveVerificationUrlCoverage(): Promise<VerificationUrlCoverage> {
  const records = await fetchRecords(
    LISTINGS_TABLE,
    ["fldXrW8CWUphUfKgJ"], // Verification_URL only
    { filterByFormula: `{Live_Status}='Active'` },
  );
  const activeTotal = records.length;
  let withUrl = 0;
  for (const r of records) {
    const fields = (r.fields ?? {}) as Record<string, unknown>;
    const v = fields.fldXrW8CWUphUfKgJ;
    if (typeof v === "string" && v.trim() !== "") withUrl++;
  }
  const withoutUrl = activeTotal - withUrl;
  const coveragePct = activeTotal === 0 ? 0 : Math.round((withUrl / activeTotal) * 1000) / 10;
  return { activeTotal, withUrl, withoutUrl, coveragePct };
}

export async function getListing(id: string): Promise<Listing | null> {
  const cacheKey = `listing:${id}`;
  const cached = getCached<Listing>(cacheKey);
  if (cached) return cached;

  // Single-record GET without returnFieldsByFieldId (Airtable returns 422
  // with that param on single-record endpoints). Returns field names instead.
  const url = `https://api.airtable.com/v0/${BASE_ID}/${LISTINGS_TABLE}/${id}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${AIRTABLE_PAT}` },
    cache: "no-store",
  });

  if (res.status === 404) return null;
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Airtable error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const listing = mapRecordByName<Listing>(data, LISTING_NAME_MAP);
  setCache(cacheKey, listing);
  return listing;
}

export async function getDeals(): Promise<Deal[]> {
  const cacheKey = "deals";
  const cached = getCached<Deal[]>(cacheKey);
  if (cached) return cached;

  const records = await fetchAllRecords(
    DEALS_TABLE,
    Object.keys(DEAL_FIELDS)
  );
  const deals = records.map((r) => mapRecord<Deal>(r, DEAL_FIELDS));
  setCache(cacheKey, deals);
  return deals;
}

export async function getBuyers(): Promise<Buyer[]> {
  const cacheKey = "buyers";
  const cached = getCached<Buyer[]>(cacheKey);
  if (cached) return cached;

  const records = await fetchAllRecords(
    BUYERS_TABLE,
    Object.keys(BUYER_FIELDS)
  );
  const buyers = records.map((r) => mapRecord<Buyer>(r, BUYER_FIELDS));
  setCache(cacheKey, buyers);
  return buyers;
}

export async function getProspectiveBuyers(): Promise<ProspectiveBuyer[]> {
  const cacheKey = "prospectiveBuyers";
  const cached = getCached<ProspectiveBuyer[]>(cacheKey);
  if (cached) return cached;

  const records = await fetchAllRecords(
    PROSPECTIVE_BUYERS_TABLE,
    Object.keys(PROSPECTIVE_BUYER_FIELDS)
  );
  const buyers = records.map((r) =>
    mapRecord<ProspectiveBuyer>(r, PROSPECTIVE_BUYER_FIELDS)
  );
  setCache(cacheKey, buyers);
  return buyers;
}

// Common write path. PATCH with typecast, parse the echo, compare each
// written field against what Airtable stored, audit drift as uncertain.
// Returns drift so callers can decide to react (none currently do; this
// is intentionally non-breaking — the audit-log + morning brief is the
// surfacing channel).
async function patchAndVerify(opts: {
  tableId: string;
  tableName: string;
  recordId: string;
  fields: Record<string, unknown>;
}): Promise<FieldDrift[]> {
  // Airtable's single-record PATCH silently ignores
  // returnFieldsByFieldId=true (verified via drift-test 5/13 — the echo
  // came back keyed by name "Outreach_Status" even with the param set).
  // detectWriteDrift translates field-ID keys to names via the schema
  // cache from lib/airtable-verify when looking up echoed values.
  const url = `https://api.airtable.com/v0/${BASE_ID}/${opts.tableId}/${opts.recordId}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${AIRTABLE_PAT}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields: opts.fields, typecast: true }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`[Airtable] PATCH ${url} failed: ${res.status} ${errText}`);

    // Detect formula-field write attempts. Airtable returns:
    //   422 INVALID_VALUE_FOR_COLUMN
    //   "Field \"X\" cannot accept a value because the field is computed"
    // for any write to formula/rollup/lookup/count fields. PATCH is
    // atomic, so a single formula field in the request kills the entire
    // batch — including legitimate writes to other fields. Audit the
    // failure mode explicitly so future occurrences are durable in KV
    // (was silently swallowed by call-site try/catch pre-5/13).
    const isFormulaWriteBlocked =
      res.status === 422 &&
      /INVALID_VALUE_FOR_COLUMN/.test(errText) &&
      /computed/i.test(errText);
    if (isFormulaWriteBlocked) {
      // Extract offending field name from Airtable's JSON payload.
      // Parse the body — direct regex on errText fails because the
      // outer JSON keeps " as \" (verified in audit log 5/13:
      // `offending_field: "unknown"`).
      let offendingField = "unknown";
      try {
        const parsed = JSON.parse(errText) as { error?: { message?: string } };
        const msg = parsed.error?.message ?? "";
        const fieldMatch = msg.match(/Field "([^"]+)" cannot accept/);
        if (fieldMatch) offendingField = fieldMatch[1];
      } catch {
        // Body wasn't JSON; leave as "unknown"
      }
      await audit({
        agent: "airtable-write",
        event: "formula_field_write_blocked",
        status: "confirmed_failure",
        recordId: opts.recordId,
        inputSummary: {
          table: opts.tableName,
          fields_written: Object.keys(opts.fields),
          offending_field: offendingField,
        },
        outputSummary: {
          http: res.status,
          error_type: "INVALID_VALUE_FOR_COLUMN",
          all_fields_in_patch_lost: Object.keys(opts.fields),
        },
        decision: "atomic_patch_rejected",
        error: errText,
      });
    } else {
      // General PATCH failure — also durable so we don't lose visibility
      // when call sites swallow the throw.
      await audit({
        agent: "airtable-write",
        event: "patch_failed",
        status: "confirmed_failure",
        recordId: opts.recordId,
        inputSummary: {
          table: opts.tableName,
          fields_written: Object.keys(opts.fields),
        },
        outputSummary: { http: res.status },
        error: errText,
      });
    }
    throw new Error(`Airtable update error ${res.status}: ${errText}`);
  }

  // Parse the post-write echo. If Airtable somehow returns non-JSON or
  // a body without `fields`, treat that as a field-level data_missing —
  // we can't verify, but we don't throw (the write succeeded at HTTP).
  let echoed: Record<string, unknown> = {};
  try {
    const body = (await res.json()) as { fields?: Record<string, unknown> };
    echoed = body.fields ?? {};
  } catch (err) {
    console.error(`[Airtable] PATCH ${url} echo parse failed:`, err);
    // No echo to compare → log every written field as drift-unknown.
    return await auditWriteDrift({
      table: opts.tableName,
      tableId: opts.tableId,
      recordId: opts.recordId,
      written: opts.fields,
      echoed: {},
    });
  }

  return await auditWriteDrift({
    table: opts.tableName,
    tableId: opts.tableId,
    recordId: opts.recordId,
    written: opts.fields,
    echoed,
  });
}

export async function updateProspectiveBuyerRecord(
  recordId: string,
  fields: Record<string, unknown>
): Promise<FieldDrift[]> {
  const drift = await patchAndVerify({
    tableId: PROSPECTIVE_BUYERS_TABLE,
    tableName: "Prospective_Buyers",
    recordId,
    fields,
  });
  delete cache["prospectiveBuyers"];
  return drift;
}

export async function updateListingRecord(
  recordId: string,
  fields: Record<string, unknown>
): Promise<FieldDrift[]> {
  const drift = await patchAndVerify({
    tableId: LISTINGS_TABLE,
    tableName: "Listings_V1",
    recordId,
    fields,
  });
  delete cache["listings"];
  delete cache[`listing:${recordId}`];
  return drift;
}

export async function updateDealRecord(
  recordId: string,
  fields: Record<string, unknown>
): Promise<FieldDrift[]> {
  const drift = await patchAndVerify({
    tableId: DEALS_TABLE,
    tableName: "Deals",
    recordId,
    fields,
  });

  delete cache["deals"];
  return drift;
}

// Batched PATCH for Listings_V1. Airtable's batched-update endpoint
// caps at 10 records per request — do NOT raise this. Returns the
// Airtable PATCH response per record (which echoes the post-write
// state, sufficient for verification — same model patchAndVerify
// uses, without the wasted extra GET).
//
// All-or-nothing semantics from Airtable: if any record in the batch
// fails validation (e.g. formula-field write attempt), Airtable
// rejects the ENTIRE batch with 422 and no records get updated. The
// caller is expected to scope batches narrowly enough that this is
// rare; on batch failure we audit + throw so the caller can decide
// whether to retry individually.
//
// Pattern is reusable for future bulk admin operations per Alex's
// 5/14 scale punch-list directive.
const AIRTABLE_BATCH_LIMIT = 10;

export interface BatchUpdateRequest {
  recordId: string;
  fields: Record<string, unknown>;
}

export interface BatchUpdateOutcome {
  recordId: string;
  echoed: Record<string, unknown> | null;
  error: string | null;
}

export async function patchListingsBatch(
  records: BatchUpdateRequest[],
): Promise<BatchUpdateOutcome[]> {
  if (records.length === 0) return [];
  if (records.length > AIRTABLE_BATCH_LIMIT) {
    throw new Error(
      `patchListingsBatch: ${records.length} exceeds Airtable's ${AIRTABLE_BATCH_LIMIT}-records-per-PATCH cap. Caller must chunk upstream.`,
    );
  }

  const url = `https://api.airtable.com/v0/${BASE_ID}/${LISTINGS_TABLE}`;
  const body = {
    records: records.map((r) => ({ id: r.recordId, fields: r.fields })),
    typecast: true,
  };

  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${AIRTABLE_PAT}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    await audit({
      agent: "airtable-write",
      event: "batch_patch_failed",
      status: "confirmed_failure",
      inputSummary: {
        table: "Listings_V1",
        record_ids: records.map((r) => r.recordId),
        fields_per_record: records.map((r) => Object.keys(r.fields)),
      },
      outputSummary: { http: res.status, batch_size: records.length },
      error: errText,
    });
    throw new Error(
      `Airtable batch PATCH error ${res.status}: ${errText}`,
    );
  }

  const parsed = (await res.json().catch(() => null)) as
    | { records?: Array<{ id: string; fields: Record<string, unknown> }> }
    | null;

  // Echo each record's post-write state. The success of the HTTP call
  // is itself confirmation Airtable accepted the writes; the echo is
  // the schema-level verification source.
  const echoByRecordId = new Map<string, Record<string, unknown>>();
  for (const rec of parsed?.records ?? []) {
    if (rec && typeof rec.id === "string") {
      echoByRecordId.set(rec.id, rec.fields ?? {});
    }
  }

  // Invalidate the in-memory listings cache — any of these records
  // could now have stale data in cache.
  delete cache["listings"];
  for (const r of records) delete cache[`listing:${r.recordId}`];

  return records.map((r) => ({
    recordId: r.recordId,
    echoed: echoByRecordId.get(r.recordId) ?? null,
    error: echoByRecordId.has(r.recordId)
      ? null
      : "absent from Airtable PATCH response",
  }));
}

const D3_MANUAL_FIX_QUEUE_TABLE = "tblV6OkNPDzOo6ubp";

// Create a row in D3_Manual_Fix_Queue. Reusable across Scenario A/B,
// D3 Phase 0a, L3, and manual triggers per Alex 5/13 directive.
// Returns the created record ID so the caller can link back if needed.
export async function createManualFixQueueRecord(fields: {
  Address: string;
  Source_Listing?: string[];
  Agent_First_Name?: string | null;
  Agent_Phone_Raw?: string | null;
  Issue_Category:
    | "invalid_phone_format"
    | "wrong_number_per_status_check"
    | "agent_changed"
    | "property_changed"
    | "other";
  Detected_Date: string; // ISO date "YYYY-MM-DD"
  Detected_By: "Scenario A" | "Scenario B" | "D3 Phase 0a" | "L3" | "manual";
  Resolution_Status?: "pending" | "fixed" | "dead";
  Notes?: string | null;
}): Promise<{ recordId: string }> {
  const url = `https://api.airtable.com/v0/${BASE_ID}/${D3_MANUAL_FIX_QUEUE_TABLE}`;
  const payload = {
    records: [
      {
        fields: {
          Address: fields.Address,
          ...(fields.Source_Listing ? { Source_Listing: fields.Source_Listing } : {}),
          ...(fields.Agent_First_Name != null
            ? { Agent_First_Name: fields.Agent_First_Name }
            : {}),
          ...(fields.Agent_Phone_Raw != null
            ? { Agent_Phone_Raw: fields.Agent_Phone_Raw }
            : {}),
          Issue_Category: fields.Issue_Category,
          Detected_Date: fields.Detected_Date,
          Detected_By: fields.Detected_By,
          Resolution_Status: fields.Resolution_Status ?? "pending",
          ...(fields.Notes != null ? { Notes: fields.Notes } : {}),
        },
      },
    ],
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${AIRTABLE_PAT}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const errText = await res.text();
    await audit({
      agent: "airtable-write",
      event: "manual_fix_queue_create_failed",
      status: "confirmed_failure",
      inputSummary: { address: fields.Address, issue: fields.Issue_Category },
      outputSummary: { http: res.status },
      error: errText,
    });
    throw new Error(`D3_Manual_Fix_Queue create error ${res.status}: ${errText}`);
  }
  const body = (await res.json()) as { records?: Array<{ id: string }> };
  const recordId = body.records?.[0]?.id;
  if (!recordId) {
    throw new Error("D3_Manual_Fix_Queue create returned no record id");
  }
  return { recordId };
}
