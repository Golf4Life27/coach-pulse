import { describe, it, expect } from "vitest";
import { resolveDisplayOffer, resolveDisplayCeiling } from "./deal-numbers";

describe("resolveDisplayOffer — the P1.1 fix", () => {
  it("REGRESSION Cheyenne: a value-anchored deal shows Rough_Opener_Amount, not 'no price'", () => {
    // Cheyenne recdHLqAQl3xv4aHs: Rough_Opener_Amount=42499, both legacy
    // offer fields empty. The old serializer read the empty fields → null.
    const o = resolveDisplayOffer({ contractOfferPrice: null, roughOpenerAmount: 42499, outreachOfferPrice: null });
    expect(o.amount).toBe(42499);
    expect(o.source).toBe("rough_opener_amount");
  });

  it("REGRESSION Sunbeam: the delivery-stamped/backfilled contract number wins", () => {
    const o = resolveDisplayOffer({ contractOfferPrice: 113750, roughOpenerAmount: null, outreachOfferPrice: null });
    expect(o.amount).toBe(113750);
    expect(o.source).toBe("contract_offer_price");
  });

  it("priority: delivery stamp > contract > rough opener > outreach", () => {
    expect(resolveDisplayOffer({ contractOfferPrice: 2, roughOpenerAmount: 3, outreachOfferPrice: 4 }, 1).source).toBe("delivery_stamp");
    expect(resolveDisplayOffer({ contractOfferPrice: 2, roughOpenerAmount: 3, outreachOfferPrice: 4 }).source).toBe("contract_offer_price");
    expect(resolveDisplayOffer({ roughOpenerAmount: 3, outreachOfferPrice: 4 }).source).toBe("rough_opener_amount");
    expect(resolveDisplayOffer({ outreachOfferPrice: 4 }).source).toBe("outreach_offer_price");
  });

  it("a deal with NO real offer resolves null — the 65% formula is never consulted", () => {
    // The resolver has no access to MAO_V1 by construction; passing only the
    // real fields empty yields null (never the List×0.65 number).
    const o = resolveDisplayOffer({ contractOfferPrice: null, roughOpenerAmount: null, outreachOfferPrice: null });
    expect(o.amount).toBeNull();
    expect(o.source).toBe("none");
  });

  it("zero and negative field values are treated as unset", () => {
    expect(resolveDisplayOffer({ contractOfferPrice: 0, roughOpenerAmount: 42499 }).amount).toBe(42499);
    expect(resolveDisplayOffer({ roughOpenerAmount: -5 }).amount).toBeNull();
  });
});

describe("resolveDisplayCeiling — value-anchored MAO only", () => {
  it("returns Underwritten_MAO when set", () => {
    expect(resolveDisplayCeiling({ underwrittenMao: 137800 })).toBe(137800);
  });
  it("falls back to Underwritten_Property_MAO", () => {
    expect(resolveDisplayCeiling({ underwrittenMao: null, underwrittenPropertyMao: 140000 })).toBe(140000);
  });
  it("un-underwritten legacy deal → null (NEVER the 65% MAO_V1 number)", () => {
    // Sunbeam pre-P1.2: no underwrite. Old code fell back to `?? listing.mao`
    // = MAO_V1 = List×0.65 = 113750, mislabeling a list-anchored number as
    // "your ceiling." The resolver returns null → the UI shows "—".
    expect(resolveDisplayCeiling({ underwrittenMao: null, underwrittenPropertyMao: null })).toBeNull();
    expect(resolveDisplayCeiling({ underwrittenMao: null })).toBeNull();
  });
});
