// GUARD: every outbound SMS template builder must stay in the GSM-7
// alphabet at the SOURCE (before normalizeForGsm7 ever runs at the
// lib/quo.ts choke point). This is what stops a stray em-dash/curly-quote/
// ellipsis from being reintroduced into a template later — the choke point
// would silently absorb it (protecting the wire), but the source would
// again lie about what actually ships, and the template would silently
// re-inflate its segment cost.
//
// Covers the 8 template functions fixed for GSM-7 honesty:
//   lib/h2-outreach.ts                buildH2Message (soft + non-soft)
//   lib/pricing/bounded-ratio-opener.ts agentInventoryAsk
//   lib/h2-outreach/bump-lane.ts      buildBumpMessage (attempt 1 + 2)
//   lib/creative/terms-opener.ts      renderTermsOpener
//   lib/reply-triage/auto-answer.ts   composeSellerCosts, composeOfferFormat
//   lib/dispo/option-tripwire.ts      composeTripwireSms (t5/t2/lapsed)
//   lib/escalation.ts                 composeEscalationSms, composeDigestSms
//   lib/reply-alert.ts                alertAction (every classification)

import { describe, it, expect } from "vitest";
import { estimateSmsSegments } from "@/lib/sms/gsm7";
import { buildH2Message } from "@/lib/h2-outreach";
import { agentInventoryAsk } from "@/lib/pricing/bounded-ratio-opener";
import { buildBumpMessage } from "@/lib/h2-outreach/bump-lane";
import { renderTermsOpener } from "@/lib/creative/terms-opener";
import type { SellerFinanceOffer } from "@/lib/creative/seller-finance";
import { composeSellerCosts, composeOfferFormat } from "@/lib/reply-triage/auto-answer";
import { composeTripwireSms } from "@/lib/dispo/option-tripwire";
import type { Listing } from "@/lib/types";
import { composeEscalationSms, composeDigestSms } from "@/lib/escalation";
import type { ConveyorItem } from "@/lib/conveyor/model";
import { alertAction } from "@/lib/reply-alert";
import type { ReplyClassification } from "@/lib/reply-triage";

function expectGsm7(body: string, label: string) {
  const r = estimateSmsSegments(body);
  expect(r.encoding, `${label} must be GSM-7 — body was: ${JSON.stringify(body)}`).toBe("gsm7");
}

describe("outbound SMS templates stay GSM-7 at the source", () => {
  it("buildH2Message (soft variant) is GSM-7", () => {
    const body = buildH2Message("Jane Smith", "123 Main St, Springfield", 65_000, "Springfield", { soft: true });
    expectGsm7(body, "buildH2Message soft");
  });

  it("buildH2Message (non-soft variant) is GSM-7", () => {
    const body = buildH2Message("Jane Smith", "123 Main St, Springfield", 65_000, "Springfield");
    expectGsm7(body, "buildH2Message non-soft");
  });

  it("agentInventoryAsk is GSM-7", () => {
    expectGsm7(agentInventoryAsk(), "agentInventoryAsk");
  });

  it("buildBumpMessage (attempt 1 and 2) is GSM-7", () => {
    expectGsm7(buildBumpMessage("Jane Smith", "123 Main St, Springfield", 65_000, 1), "buildBumpMessage attempt 1");
    expectGsm7(buildBumpMessage("Jane Smith", "123 Main St, Springfield", 65_000, 2), "buildBumpMessage attempt 2");
  });

  it("renderTermsOpener is GSM-7 (full-ask and value-capped variants)", () => {
    const baseOffer: SellerFinanceOffer = {
      verdict: "sendable_terms",
      price: 95_000,
      priceCappedToValue: false,
      downPayment: 9_500,
      monthlyPayment: 350,
      termMonths: 240,
      buyerCashOnCash: 0.12,
    } as SellerFinanceOffer;
    expectGsm7(
      renderTermsOpener({ agentName: "Erica Agent", address: "3470 Hadley Ave", listPrice: 95_000, offer: baseOffer }),
      "renderTermsOpener full-ask",
    );
    expectGsm7(
      renderTermsOpener({
        agentName: "Erica Agent",
        address: "3470 Hadley Ave",
        listPrice: 95_000,
        offer: { ...baseOffer, priceCappedToValue: true },
      }),
      "renderTermsOpener value-capped",
    );
  });

  it("composeSellerCosts and composeOfferFormat are GSM-7", () => {
    expectGsm7(composeSellerCosts({ street: "123 Main St" }), "composeSellerCosts");
    expectGsm7(composeSellerCosts({ street: null }), "composeSellerCosts (no street)");
    expectGsm7(composeOfferFormat({ stickyOfferUsd: 65_000, street: "123 Main St" }), "composeOfferFormat");
  });

  it("composeTripwireSms is GSM-7 for every stage", () => {
    const listing = { id: "recABC123", address: "123 Main St" } as Listing;
    expectGsm7(composeTripwireSms(listing, "t5", 5), "composeTripwireSms t5");
    expectGsm7(composeTripwireSms(listing, "t2", 1), "composeTripwireSms t2");
    expectGsm7(composeTripwireSms(listing, "lapsed", -3), "composeTripwireSms lapsed");
  });

  it("composeEscalationSms and composeDigestSms are GSM-7", () => {
    const item: ConveyorItem = {
      key: "priority:p1",
      source: "priority",
      type: "2B",
      title: "COGO letter batch",
      reasoning: "Unblocks 4 deals.",
      recordId: "recLIST000000001",
      href: "/pipeline/recLIST000000001",
      dollars: 28_000,
      deadlineAt: null,
      deadlineImplied: false,
      postedAt: "2026-07-11T06:00:00Z",
      verbatim: null,
      actions: [],
    };
    expectGsm7(composeEscalationSms(item, "https://coach-pulse-ten.vercel.app", 10), "composeEscalationSms");
    expectGsm7(
      composeDigestSms(
        [item],
        { intakeFreshness: "ok", sendFreshness: "ok", sentYesterday: 8, repliesYesterday: 2 },
        "https://coach-pulse-ten.vercel.app",
        { inWorks: 4, operatorActions: 2 },
      ),
      "composeDigestSms",
    );
  });

  it("alertAction is GSM-7 for every ReplyClassification", () => {
    const classifications: ReplyClassification[] = [
      "rejection", "soft_no", "interest", "counter", "acceptance",
      "hostile", "list_anchored", "flat_no",
      "identity_question", "agent_redirect", "auto_reply",
      "offer_format", "appointment", "seller_costs", "disclosure_step",
      "unknown",
    ];
    for (const c of classifications) {
      expectGsm7(alertAction(c), `alertAction(${c})`);
    }
  });
});

describe("H2 soft opener segment regression (the headline number this fix buys)", () => {
  it("bills 3 GSM-7 segments, down from the pre-fix 6-segment UCS-2 encoding", () => {
    const body = buildH2Message("Jane Smith", "123 Main St, Springfield", 65_000, "Springfield", { soft: true });
    const r = estimateSmsSegments(body);
    expect(r.encoding).toBe("gsm7");
    expect(r.segments).toBe(3);

    // Pin the pre-fix number too, so this test documents the regression it
    // guards against: the same body with its three em-dashes restored (the
    // exact smart characters this commit replaced) forces UCS-2 and bills
    // double the segments.
    const preFixBody = body
      .replace("Solutions - interested", "Solutions — interested")
      .replace("$65,000 - if", "$65,000 — if")
      .replace("Also - if", "Also — if");
    const preFix = estimateSmsSegments(preFixBody);
    expect(preFix.encoding).toBe("ucs2");
    expect(preFix.segments).toBe(6);
  });
});
