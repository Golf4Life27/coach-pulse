import { describe, it, expect } from "vitest";
import {
  composeDispoBlastEmail,
  dealPageUrl,
  photoUrlsJson,
  selectBlastRecipients,
} from "./blast-email";
import type { ShortlistBuyer, ShortlistResult } from "./buyer-shortlist";

const base = {
  buyerName: "Jordan Cash Buyer",
  address: "815 Russell Ave",
  city: "Akron",
  state: "OH",
  zip: "44307",
  beds: 3,
  baths: 1,
  sqft: 1248,
  assignmentPrice: 67_750,
  optionDeadline: "2026-09-15",
  dealUrl: "https://coach-pulse-ten.vercel.app/d/rec123",
};

describe("composeDispoBlastEmail", () => {
  it("shows one number, the facts, the deadline and the deal link", () => {
    const e = composeDispoBlastEmail(base);
    expect(e.subject).toBe("Off-market: 815 Russell Ave, Akron — $67,750");
    expect(e.body).toContain("Hi Jordan,");
    expect(e.body).toContain("Assignment price: $67,750");
    expect(e.body).toContain("3 bed / 1 bath, 1,248 sq ft");
    expect(e.body).toContain("inspection window through Sep 15");
    expect(e.body).toContain(base.dealUrl);
    expect(e.body).toContain("(815) 556-9965");
  });

  it("degrades gracefully with missing facts and name", () => {
    const e = composeDispoBlastEmail({
      ...base, buyerName: null, beds: null, baths: null, sqft: null, optionDeadline: null, city: null, state: null, zip: null,
    });
    expect(e.body).toContain("Hi there,");
    expect(e.body).toContain("10-day inspection window");
    expect(e.body).not.toContain("bed");
    expect(e.subject).toBe("Off-market: 815 Russell Ave — $67,750");
  });

  it("never mentions contract, ARV, rehab, fee, or spread", () => {
    const e = composeDispoBlastEmail(base);
    for (const word of ["contract price", "ARV", "rehab", "fee", "spread", "seller", "agent"]) {
      expect(e.body.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });
});

describe("dealPageUrl", () => {
  it("joins without double slashes", () => {
    expect(dealPageUrl("https://x.app/", "recA")).toBe("https://x.app/d/recA");
    expect(dealPageUrl("https://x.app", "recA")).toBe("https://x.app/d/recA");
  });
});

function sb(over: Partial<ShortlistBuyer>): ShortlistBuyer {
  return {
    buyerId: "recB", name: "B", company: null, phone: null, email: "b@x.com", score: 10,
    geo: "state", price: "unknown", rating: null, cashBuyer: true, pofUsable: false,
    daysSinceContact: null, outsideStatedBox: false, reasons: ["state match"], ...over,
  };
}

describe("selectBlastRecipients", () => {
  it("takes only top-slice buyers with a usable email, deduped, capped", () => {
    const shortlist = {
      top: [
        sb({ buyerId: "r1", email: "A@X.com" }),
        sb({ buyerId: "r2", email: "a@x.com" }),
        sb({ buyerId: "r3", email: null }),
        sb({ buyerId: "r4", email: "not-an-email" }),
        sb({ buyerId: "r5", email: "c@x.com" }),
        sb({ buyerId: "r6", email: "d@x.com" }),
      ],
      rest: [sb({ buyerId: "r9", email: "z@x.com" })],
    } as unknown as ShortlistResult;
    const picked = selectBlastRecipients(shortlist, 2);
    expect(picked.map((p) => p.buyerId)).toEqual(["r1", "r5"]);
    expect(picked[0].email).toBe("a@x.com");
  });
});

describe("photoUrlsJson", () => {
  it("dedupes, drops empties, caps at 12, and round-trips as a JSON array", () => {
    const photos = Array.from({ length: 15 }, (_, i) => ({ url: `https://p/${i % 13}.jpg` })).concat([{ url: "" }]);
    const parsed = JSON.parse(photoUrlsJson(photos)) as string[];
    expect(parsed.length).toBe(12);
    expect(new Set(parsed).size).toBe(12);
  });
});
