import { describe, it, expect } from "vitest";
import {
  investorBaseCsvToImportRows,
  normalizeBuyerType,
  normalizePropertyType,
} from "./buyers-import";
import { normalizePhone } from "@/lib/buyers-v2";

// Real header from the 2026-07-20 Canfield export.
const HEADER =
  "Entity Name,First Name,Last Name,Buyer Type,Property Type,Wireless 1,Wireless 2,Landline 1,Address,City,State,Zip,Bedrooms,Bathrooms,Sqft,Smart Match,Status,Most Recent Sale Date,Most Recent Sale Price,Prior Sale Date,Prior Sale Price,Buyer Transaction Count (On This Search),LinkedDeal count,Registered Owner Name,Registered Seller Name,Beta: Possible Email,Buyer Mailing Address,Buyer Mailing City,Buyer Mailing State,Buyer Mailing Zip";

function row(cols: Partial<Record<string, string>>): string {
  const order = HEADER.split(",");
  return order.map((h) => cols[h] ?? "").join(",");
}

describe("investorBaseCsvToImportRows — the dispo-list accumulation parse", () => {
  it("keeps a phone-only buyer (no email) — dispo identity rule", () => {
    const csv = [
      HEADER,
      row({ "Entity Name": "Aey Projects Llc", "First Name": "Lucas", "Last Name": "Musgrave", "Buyer Type": "landlord", "Wireless 1": "8312398658", City: "Detroit", State: "MI", "Most Recent Sale Price": "105000", "LinkedDeal count": "22" }),
    ].join("\n");
    const { rows, skipped } = investorBaseCsvToImportRows(csv);
    expect(rows).toHaveLength(1);
    expect(skipped).toBe(0);
    expect(rows[0].email).toBeNull();
    expect(rows[0].phone).toBe("8312398658");
    expect(rows[0].fields["Buyer_Type"]).toBe("landlord");
    expect(rows[0].fields["Markets"]).toEqual(["Detroit"]);
    expect(rows[0].fields["Buyer_Volume_Tier"]).toBe("B"); // 22 linked deals
    expect(rows[0].fields["Source"]).toBe("InvestorBase");
  });

  it("skips a row with NO contact channel (no email, no phone)", () => {
    const csv = [
      HEADER,
      row({ "Entity Name": "Ghost Holdings Llc", "Buyer Type": "flipper", City: "Detroit", State: "MI", "Most Recent Sale Price": "50000" }),
    ].join("\n");
    const { rows, skipped } = investorBaseCsvToImportRows(csv);
    expect(rows).toHaveLength(0);
    expect(skipped).toBe(1);
  });

  it("collapses in-file duplicates (same email) — last wins, idempotent re-drop", () => {
    const csv = [
      HEADER,
      row({ "Entity Name": "1701 Homes Llc", "Buyer Type": "flipper", "Wireless 1": "3132827530", "Beta: Possible Email": "bkunka1@msn.com", City: "Detroit", State: "MI", "Most Recent Sale Price": "260000", "LinkedDeal count": "1" }),
      row({ "Entity Name": "1701 Homes Llc", "Buyer Type": "flipper", "Wireless 1": "3132827530", "Beta: Possible Email": "BKUNKA1@MSN.COM", City: "Detroit", State: "MI", "Most Recent Sale Price": "260000", "LinkedDeal count": "127" }),
    ].join("\n");
    const { rows, skipped } = investorBaseCsvToImportRows(csv);
    expect(rows).toHaveLength(1);
    expect(skipped).toBe(1);
    // Last wins → the 127-deal (Tier A) version survives.
    expect(rows[0].fields["Buyer_Volume_Tier"]).toBe("A");
    expect(rows[0].email).toBe("bkunka1@msn.com");
  });

  it("infers market Atlanta and maps the buyer type/property type", () => {
    const csv = [
      HEADER,
      row({ "Entity Name": "Peach Capital Llc", "Buyer Type": "landlord", "Property Type": "Single Family Residence", "Wireless 1": "4045551234", City: "Atlanta", State: "GA", "Most Recent Sale Price": "133000" }),
    ].join("\n");
    const { rows } = investorBaseCsvToImportRows(csv);
    expect(rows[0].fields["Markets"]).toEqual(["Atlanta"]);
    expect(rows[0].fields["Property_Type_Preference"]).toEqual(["Single Family"]);
  });

  it("reports raw count independent of skips/dedup", () => {
    const csv = [
      HEADER,
      row({ "Entity Name": "A", "Buyer Type": "flipper", "Wireless 1": "3130000001", City: "Detroit", State: "MI" }),
      row({ "Entity Name": "B (no contact)", "Buyer Type": "flipper", City: "Detroit", State: "MI" }),
    ].join("\n");
    const { rawCount, rows, skipped } = investorBaseCsvToImportRows(csv);
    expect(rawCount).toBe(2);
    expect(rows).toHaveLength(1);
    expect(skipped).toBe(1);
  });
});

describe("normalizePhone — the no-email dedup key", () => {
  it("keeps 10-digit numbers, strips country code, rejects junk", () => {
    expect(normalizePhone("8312398658")).toBe("8312398658");
    expect(normalizePhone("1-831-239-8658")).toBe("8312398658");
    expect(normalizePhone("(831) 239-8658")).toBe("8312398658");
    expect(normalizePhone("831")).toBeNull();
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });
});

describe("normalizeBuyerType / normalizePropertyType", () => {
  it("normalizes the common InvestorBase labels", () => {
    expect(normalizeBuyerType("flipper")).toBe("flipper");
    expect(normalizeBuyerType("Buy and Hold")).toBe("landlord");
    expect(normalizeBuyerType("")).toBe("unknown");
    expect(normalizePropertyType("Multi Family Residence")).toEqual(["Multi Family"]);
    expect(normalizePropertyType("Single Family Residence")).toEqual(["Single Family"]);
  });
});
