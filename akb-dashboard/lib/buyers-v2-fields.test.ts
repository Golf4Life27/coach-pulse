// Parity test: every physical field name BUYER_V2_FIELDS points at must
// actually exist on the Buyers table (tbl4Rr07vq0mTftZB), or reads come back
// null and writes 422 — exactly the bug this file exists to catch a repeat
// of (2026-09-18 field-name-mismatch hunt: BUYER_V2_FIELDS used names that
// were never on the table, so the buy-box drip cron found 0 eligible buyers
// and /api/buyers/intake failed every write).
//
// PHYSICAL_BUYER_FIELDS below is the Buyers table schema as VERIFIED on
// 2026-09-18 (both the fields that already existed and the ones created that
// night to match what the code expected). It is a checked-in snapshot, not a
// live schema fetch — when a field is added or renamed on the physical
// Airtable table, update this list by hand, or this test will pass while
// drifting silently out of sync with reality again.

import { describe, it, expect } from "vitest";
import { BUYER_V2_FIELDS } from "./buyers-v2";

/** Buyers table (tbl4Rr07vq0mTftZB) field names, verified 2026-09-18. */
export const PHYSICAL_BUYER_FIELDS = [
  // Existing before tonight.
  "buyer_name",
  "buyer_email",
  "buyer_phone",
  "Company_Name",
  "Buyer_Status",
  "Preferred_Cities",
  "Preferred_States",
  "Preferred_Zip_Codes",
  "Preferred_Property_Types",
  "Min_Price",
  "Max_Price",
  "Min_Beds",
  "Min_Baths",
  "Min_SqFt",
  "Max_Rehab",
  "Min_Assignment_Fee_Target",
  "Min_Deal_Spread",
  "Strategy_Type",
  "Preferred_Condition",
  "Cash_Buyer",
  "Proof_of_Funds_On_File",
  "POF_Expiry_Date",
  "Buying_Entity_Name",
  "Last_Contacted_At",
  "Last_Response_At",
  "Buyer_Notes",
  "Response_Speed",
  "Buyer_Rating",
  "Deals",
  "Record_ID",
  "Buyer_Last_Deal_Closed",
  "Buyer_Active_Flag",
  "SMS_Consent",
  "SMS_Consent_Date",
  "SMS_Consent_Source",
  "SMS_Last_Sent_Date",
  "SMS_Sent_Count",
  "SMS_Response_Count",
  "Opt-IN to Texts",
  "Dispo_Blast_Thread_Id",
  "Dispo_Blast_Listing_Id",
  "Box_Drip_Step",
  "Box_Drip_Last_At",
  "Box_Drip_Thread_Id",
  // Created 2026-09-18 to match what the code already expected.
  "Form_Completed_At",
  "Email_Sent_At",
  "Email_Opened_At",
  "Last_Engagement_At",
  "Source",
  "Buyer_Type",
  "Buyer_Volume_Tier",
  "Warmth_Score",
  "Linked_Deal_Count",
  "Last_Purchase_Date",
  "Last_Purchase_Price",
  "Last_Purchase_Address",
  "Phone_Secondary",
  "Status",
] as const;

describe("BUYER_V2_FIELDS parity with the physical Buyers table", () => {
  it("points every key at a field name that exists on the physical table", () => {
    const physical = new Set<string>(PHYSICAL_BUYER_FIELDS);
    const unknown = Object.entries(BUYER_V2_FIELDS).filter(([, fieldName]) => !physical.has(fieldName));
    expect(unknown).toEqual([]);
  });
});
