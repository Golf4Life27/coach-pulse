import { describe, it, expect } from "vitest";
import { cleanEmailBody, isEmptyAfterClean } from "./email-clean";

// Shaped after the real Sunbeam thread (19d9bb3906ab44db) that P1.3 targets:
// a short lead line, then a forwarded-message divider, then a deeply nested
// quoted history and the standard IABS / wire-fraud / consumer-protection
// boilerplate. We keep the sender's OWN words and cut everything from the
// first quoted-history / disclaimer marker on. No real message IDs embedded.
const SUNBEAM_FORWARD = `Good Morning Mary Kate,

Please see the cash offer from Alex below. LET'S GET THIS DONE!

Thanks,
Dayna

---------- Forwarded message ---------
From: Alex Balog <alex@akb-properties.com>
Date: Sat, Jul 12, 2026 at 8:53 AM
Subject: 3123 Sunbeam St — Cash Offer
To: Dayna <dayna@example.com>

Hi Dayna, attached is the signed TREC for $113,750 cash, close Aug 1.

> On Jul 11, 2026, Dayna wrote:
> Send it over and I'll forward to the executrix.

WIRE FRAUD IS REAL. Before wiring any funds, call the title company at a
known number to verify instructions.

Information About Brokerage Services
Texas Real Estate Commission — Consumer Protection Notice`;

describe("cleanEmailBody — Sunbeam forwarded thread", () => {
  it("keeps the sender's lead words", () => {
    const out = cleanEmailBody(SUNBEAM_FORWARD);
    expect(out).toContain("Good Morning Mary Kate");
    expect(out).toContain("LET'S GET THIS DONE!");
  });

  it("cuts at the forwarded-message divider (drops the whole quoted thread)", () => {
    const out = cleanEmailBody(SUNBEAM_FORWARD);
    expect(out).not.toContain("Forwarded message");
    expect(out).not.toContain("$113,750"); // that lived in the forwarded body
    expect(out).not.toContain("Send it over"); // nested quote
  });

  it("drops the IABS / wire-fraud / consumer-protection boilerplate", () => {
    const out = cleanEmailBody(SUNBEAM_FORWARD);
    expect(out).not.toContain("WIRE FRAUD");
    expect(out).not.toContain("Information About Brokerage Services");
    expect(out).not.toContain("Consumer Protection Notice");
  });
});

describe("cleanEmailBody — inline '>' quoting (On <date>… wrote:)", () => {
  const NESTED = `Yes, that works for us. Please proceed.

On Fri, Jul 11, 2026 at 4:20 PM Alex Balog <alex@akb-properties.com> wrote:
> Can you confirm the option period is 7 days?
> > On Jul 10, Dayna wrote:
> > Here is the counter.`;

  it("keeps the reply, cuts the 'On … wrote:' quote block", () => {
    const out = cleanEmailBody(NESTED);
    expect(out).toBe("Yes, that works for us. Please proceed.");
  });
});

describe("cleanEmailBody — plain SMS-style body passes through", () => {
  it("no quoting / no markers → unchanged (trimmed)", () => {
    expect(cleanEmailBody("Call me when you get this.")).toBe(
      "Call me when you get this.",
    );
  });

  it("collapses blank runs but preserves paragraph breaks", () => {
    expect(cleanEmailBody("Line one.\n\n\n\nLine two.")).toBe(
      "Line one.\n\nLine two.",
    );
  });
});

describe("cleanEmailBody — signature delimiters", () => {
  it("cuts a standard '-- ' signature block", () => {
    const out = cleanEmailBody("Sounds good.\n\n-- \nDayna Smith\nRealtor");
    expect(out).toBe("Sounds good.");
  });

  it("cuts a mobile 'Sent from my iPhone' signature", () => {
    const out = cleanEmailBody("On my way.\n\nSent from my iPhone");
    expect(out).toBe("On my way.");
  });
});

describe("isEmptyAfterClean", () => {
  it("true when the message was ONLY quoted history / boilerplate", () => {
    expect(
      isEmptyAfterClean("> On Jul 10, Dayna wrote:\n> Here is the counter."),
    ).toBe(true);
    expect(isEmptyAfterClean("")).toBe(true);
    expect(isEmptyAfterClean(null)).toBe(true);
  });

  it("false when there is real content", () => {
    expect(isEmptyAfterClean("Yes, proceed.")).toBe(false);
  });
});
