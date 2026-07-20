import { describe, it, expect } from "vitest";
import { attomProfileToSellerBasis } from "./attom-ownership";

const NOW = "2026-07-20T20:00:00.000Z";

describe("attomProfileToSellerBasis — the Canfield 'double it' decoder", () => {
  // The shape that would have decoded Canfield before bump one: corporate
  // owner, $145k basis, $108,750 bridge note. (CMA-verified 2026-07-20.)
  const canfieldish = {
    owner: { owner1: { fullname: "117 PROPERTIES INC" }, corporateindicator: "Y" },
    sale: { amount: { saleamt: 145_000 }, salesearchdate: "2024-03-22" },
    assessment: {
      mortgage: {
        FirstConcurrent: { amount: 108_750, lendercompanyname: "PARK PLACE FINANCE LLC", date: "2024-03-26" },
      },
    },
  };

  it("maps owner + basis + open loan", () => {
    const b = attomProfileToSellerBasis(canfieldish, NOW)!;
    expect(b.ownerName).toBe("117 PROPERTIES INC");
    expect(b.corporateOwner).toBe(true);
    expect(b.lastSalePrice).toBe(145_000);
    expect(b.lastSaleDate).toBe("2024-03-22");
    expect(b.loanAmount).toBe(108_750);
    expect(b.lender).toBe("PARK PLACE FINANCE LLC");
    expect(b.loanDate).toBe("2024-03-26");
    expect(b.fetchedAt).toBe(NOW);
  });

  it("entity markers classify corporate when the indicator is absent; people stay people", () => {
    const llc = attomProfileToSellerBasis(
      { owner: { owner1: { fullname: "AEY PROJECTS LLC" } } },
      NOW,
    )!;
    expect(llc.corporateOwner).toBe(true);
    const person = attomProfileToSellerBasis(
      { owner: { owner1: { firstnameandmi: "DENISE", lastname: "STUBBS" } } },
      NOW,
    )!;
    expect(person.ownerName).toBe("DENISE STUBBS");
    expect(person.corporateOwner).toBe(false);
  });

  it("stringified amounts (tier variance) still map", () => {
    const b = attomProfileToSellerBasis(
      { mortgage: { amount: "75000", lenderlastname: "QUICKEN" }, sale: { saleAmt: "60000" } },
      NOW,
    )!;
    expect(b.loanAmount).toBe(75_000);
    expect(b.lastSalePrice).toBe(60_000);
    expect(b.lender).toBe("QUICKEN");
  });

  it("nothing usable → null, never a fabricated basis", () => {
    expect(attomProfileToSellerBasis({}, NOW)).toBeNull();
    expect(attomProfileToSellerBasis(undefined, NOW)).toBeNull();
    expect(attomProfileToSellerBasis({ building: { size: { universalsize: 1000 } } }, NOW)).toBeNull();
  });
});
