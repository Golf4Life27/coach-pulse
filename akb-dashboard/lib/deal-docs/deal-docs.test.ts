import { describe, it, expect } from "vitest";
import {
  parseInvestorBaseCsv,
  looksLikeInvestorBaseCsv,
} from "./investorbase-csv";
import { parseCmaText, looksLikeCmaPdf } from "./cma-pdf";

const NOW = Date.parse("2026-07-20T20:00:00Z");

const HEADER =
  "Entity Name,First Name,Last Name,Buyer Type,Property Type,Wireless 1,Wireless 2,Landline 1,Address,City,State,Zip,Bedrooms,Bathrooms,Sqft,Smart Match,Status,Most Recent Sale Date,Most Recent Sale Price,Prior Sale Date,Prior Sale Price,Buyer Transaction Count (On This Search),LinkedDeal count,Registered Owner Name,Registered Seller Name,Beta: Possible Email,Buyer Mailing Address,Buyer Mailing City,Buyer Mailing State,Buyer Mailing Zip";

// Real row shapes from the 2026-07-20 Canfield export.
const CSV = [
  HEADER,
  'Max Performance Llc,Markus,Irving,flipper,Single Family Residence,3133332469,,,4475 Field St,Detroit,MI,48214,4,1,1471,true,New,2026-04-06,45000,2025-10-16,29200,2,0,,Max Performance Llc,shawn@x.com,2911 Iroquois St,Detroit,MI,48214',
  'Fdcgg Ventures Llc,Franklin,Duff,flipper,Single Family Residence,7344741485,,,3486 Belvidere St,Detroit,MI,48214,3,1,1104,true,New,2026-02-10,30000,2025-10-16,13200,3,6,,Fdcgg Ventures Llc,p.duff@x.com,16750 Horseshoe DR,Northville,MI,48168',
  'Dani Zuko Usa Llc,Carlos,Garbesi,landlord,Single Family Residence,3053106113,,,2533 Seyburn St,Detroit,MI,48214,3,1,1482,false,New,2026-03-26,75000,,0,1,0,Dani Zuko Usa Llc,,cg@x.com,2200 Hunt St,Detroit,MI,48207',
  // Nominal transfer — below the $10k evidence floor, excluded.
  'Jonathan D Koller,Jonathan,Koller,landlord,Single Family Residence,3144887132,,,4141 Mcdougall St,Detroit,MI,48207,3,2,2100,false,New,2025-11-13,5100,,0,3,11,Jonathan D Koller,,nk@x.com,4405 Grandy St,Detroit,MI,48207',
  // Renovated-exit price — above the $250k cap, excluded from evidence.
  'Sandra Willis,Sandra,Willis,flipper,Single Family Residence,8034049886,,,3104 Woods Cir,Detroit,MI,48207,4,2,1744,false,New,2026-01-12,264000,2025-02-25,150000,1,1,,Sandra Willis,sw@x.com,406 Alice Dr,Camden,SC,29020',
  // Stale — outside the 18-month window, excluded.
  'Flinch Inc,Justin,Galan,landlord,Single Family Residence,5599035929,,,6400 Seminole St,Detroit,MI,48213,4,3,3240,false,New,2021-07-08,300000,,0,1,175,Flinch Inc,,jg@x.com,6117 N Rolinda Ave,Fresno,CA,93723',
].join("\n");

describe("parseInvestorBaseCsv — per-track as-is acquisition evidence, never blended", () => {
  it("sniffs the export format", () => {
    expect(looksLikeInvestorBaseCsv(HEADER)).toBe(true);
    expect(looksLikeInvestorBaseCsv("Address,Price,Beds")).toBe(false);
  });

  it("computes flipper and landlord evidence separately with the window applied", () => {
    const p = parseInvestorBaseCsv(CSV, NOW);
    expect(p.totalRows).toBe(6);
    expect(p.flipperCount).toBe(3);
    expect(p.landlordCount).toBe(3);
    const flipper = p.evidence.find((e) => e.track === "flipper")!;
    // 45k + 30k qualify; 264k (renovated exit) excluded.
    expect(flipper.n).toBe(2);
    expect(flipper.median).toBe(37_500);
    const landlord = p.evidence.find((e) => e.track === "landlord")!;
    // 75k qualifies; $5.1k nominal + 2021 stale excluded.
    expect(landlord.n).toBe(1);
    expect(landlord.median).toBe(75_000);
    expect(p.evidenceRows).toBe(3);
  });

  it("maps buyer contact fields for the dispo lane", () => {
    const p = parseInvestorBaseCsv(CSV, NOW);
    const max = p.buyers.find((b) => b.entityName === "Max Performance Llc")!;
    expect(max.phone).toBe("3133332469");
    expect(max.email).toBe("shawn@x.com");
    expect(max.buyerType).toBe("flipper");
  });
});

// Text shape lifted from the real 2026-07-20 Canfield PropStream CMA.
const CMA_TEXT = `Comparative Market Analysis
7714 E Canfield St, Detroit, MI 48214
Owner Name: 117 PROPERTIES INC
Mailing Address: 27 BALIZA RD
Estimated Value: $160,000
Comparables
Properties: 27
Avg. Sale Price: $55,906
Days on Market: 106
Estimated Equity: $54,027
Mortgage Balance: $105,973
Monthly Rent: $1,432
Sale Date: 03/22/2024
Sale Price: $145,000`;

describe("parseCmaText — the decision-bearing numbers from a PropStream CMA", () => {
  it("sniffs and extracts the summary block", () => {
    expect(looksLikeCmaPdf(CMA_TEXT)).toBe(true);
    const c = parseCmaText(CMA_TEXT);
    expect(c.avgSalePrice).toBe(55_906);
    expect(c.compCount).toBe(27);
    expect(c.estimatedValue).toBe(160_000);
    expect(c.mortgageBalance).toBe(105_973);
    expect(c.estimatedEquity).toBe(54_027);
    expect(c.lastSalePrice).toBe(145_000);
    expect(c.lastSaleDate).toBe("03/22/2024");
    expect(c.ownerName).toBe("117 PROPERTIES INC");
    expect(c.monthlyRent).toBe(1_432);
    expect(c.extracted.length).toBeGreaterThanOrEqual(8);
  });

  it("missing labels map to null — partial extraction, never fabrication", () => {
    const c = parseCmaText("Comparative Market Analysis\nProperties: 12");
    expect(c.compCount).toBe(12);
    expect(c.mortgageBalance).toBeNull();
    expect(c.avgSalePrice).toBeNull();
  });
});
