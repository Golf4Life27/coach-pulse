// @agent: maverick — accepted-offer silence watchdog (pure).
//
// Anchored on the incident: 1102 Montrose Ave went Offer Accepted 9/1 at
// $55,750, the agent chased 9/3, Maverick sent a holding reply, and then nine
// days passed with no executed contract and no text to the operator.

import { describe, it, expect } from "vitest";
import type { Listing } from "@/lib/types";
import { isAllowedCardAction } from "./decision-card";
import {
  findSilentAcceptedOffers,
  composeAcceptedSilenceCard,
  composeAcceptedSilenceHeadline,
  acceptedSilenceKey,
} from "./accepted-silence";
import { estimateSmsSegments, findNonGsm7Chars } from "@/lib/sms/gsm7";

const NOW = new Date("2026-09-12T15:00:00.000Z");

/** Only the fields this watchdog reads; the rest of Listing is irrelevant here. */
function listing(over: Partial<Listing> = {}): Listing {
  return {
    id: "recMONTROSE",
    address: "1102 Montrose Ave, Chicago, IL 60613",
    outreachStatus: "Offer Accepted",
    agentName: "Sarah Kim",
    contractOfferPrice: 55_750,
    lastOutboundAt: "2026-09-03T18:00:00.000Z",
    lastInboundAt: "2026-09-03T15:00:00.000Z",
    contractExecutedAt: null,
    actionCardState: null,
    actionHoldUntil: null,
    ...over,
  } as Listing;
}

describe("findSilentAcceptedOffers — the Montrose shape", () => {
  it("flags an accepted, unexecuted offer that has been quiet for nine days", () => {
    const scan = findSilentAcceptedOffers([listing()], NOW);
    expect(scan.due).toHaveLength(1);
    expect(scan.unmeasurable).toEqual([]);
    expect(scan.held).toEqual([]);
    const item = scan.due[0];
    expect(item.recordId).toBe("recMONTROSE");
    expect(item.acceptedPrice).toBe(55_750);
    expect(item.agentName).toBe("Sarah Kim");
    // Last touch is the NEWEST of the two timestamps (9/3 18:00, the outbound).
    expect(item.lastTouchIso).toBe("2026-09-03T18:00:00.000Z");
    expect(item.silentHours).toBe(213); // 9/3 18:00 -> 9/12 15:00
    expect(item.lastOutboundAt).toBe("2026-09-03T18:00:00.000Z");
    expect(item.lastInboundAt).toBe("2026-09-03T15:00:00.000Z");
  });

  it("~216h (nine days) when the last touch was 9/3 15:00", () => {
    const scan = findSilentAcceptedOffers([listing({ lastOutboundAt: null })], NOW);
    expect(scan.due[0].silentHours).toBe(216);
    expect(scan.due[0].lastTouchIso).toBe("2026-09-03T15:00:00.000Z");
  });

  it("prefers contractOfferPrice, falls back to the sticky opener, else null", () => {
    expect(
      findSilentAcceptedOffers([listing({ contractOfferPrice: 55_750, outreachOfferPrice: 48_000 })], NOW)
        .due[0].acceptedPrice,
    ).toBe(55_750);
    expect(
      findSilentAcceptedOffers([listing({ contractOfferPrice: null, outreachOfferPrice: 48_000 })], NOW)
        .due[0].acceptedPrice,
    ).toBe(48_000);
    expect(
      findSilentAcceptedOffers([listing({ contractOfferPrice: null, outreachOfferPrice: null })], NOW)
        .due[0].acceptedPrice,
    ).toBeNull();
  });
});

describe("findSilentAcceptedOffers — exclusions", () => {
  it("ignores every status but 'Offer Accepted'", () => {
    for (const status of ["Texted", "Negotiating", "Counter Received", "Dead", null, ""]) {
      const scan = findSilentAcceptedOffers([listing({ outreachStatus: status })], NOW);
      expect(scan.due, String(status)).toHaveLength(0);
      expect(scan.unmeasurable, String(status)).toHaveLength(0);
    }
  });

  it("EXCLUDES a record with an executed contract — the back-half watchers own it", () => {
    const scan = findSilentAcceptedOffers([listing({ contractExecutedAt: "2026-09-05" })], NOW);
    expect(scan.due).toHaveLength(0);
    expect(scan.unmeasurable).toHaveLength(0);
    expect(scan.held).toHaveLength(0);
  });

  it("EXCLUDES a record held until today or later — a Pause tap must actually pause", () => {
    const future = findSilentAcceptedOffers(
      [listing({ actionCardState: "Held", actionHoldUntil: "2026-09-20" })],
      NOW,
    );
    expect(future.due).toHaveLength(0);
    expect(future.held).toEqual([
      { recordId: "recMONTROSE", address: "1102 Montrose Ave, Chicago, IL 60613", holdUntil: "2026-09-20" },
    ]);

    const today = findSilentAcceptedOffers(
      [listing({ actionCardState: "Held", actionHoldUntil: "2026-09-12" })],
      NOW,
    );
    expect(today.due).toHaveLength(0);
    expect(today.held).toHaveLength(1);
  });

  it("a LAPSED hold pages again — the pause expired, the silence did not", () => {
    const scan = findSilentAcceptedOffers(
      [listing({ actionCardState: "Held", actionHoldUntil: "2026-09-11" })],
      NOW,
    );
    expect(scan.due).toHaveLength(1);
    expect(scan.held).toHaveLength(0);
  });

  it("Held with no hold-until date is not a pause — it pages", () => {
    const scan = findSilentAcceptedOffers([listing({ actionCardState: "Held", actionHoldUntil: null })], NOW);
    expect(scan.due).toHaveLength(1);
  });

  it("both timestamps null: UNMEASURABLE, never silent — no clock was ever started", () => {
    const scan = findSilentAcceptedOffers(
      [listing({ lastOutboundAt: null, lastInboundAt: null })],
      NOW,
    );
    expect(scan.due).toHaveLength(0);
    expect(scan.unmeasurable).toEqual([
      { recordId: "recMONTROSE", address: "1102 Montrose Ave, Chicago, IL 60613" },
    ]);
  });

  it("an unparseable timestamp counts as absent, not as 1970 (which would page instantly)", () => {
    const scan = findSilentAcceptedOffers(
      [listing({ lastOutboundAt: "not a date", lastInboundAt: null })],
      NOW,
    );
    expect(scan.due).toHaveLength(0);
    expect(scan.unmeasurable).toHaveLength(1);
  });
});

describe("findSilentAcceptedOffers — the silenceHours boundary", () => {
  const at = (hoursAgo: number) =>
    listing({
      lastOutboundAt: new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString(),
      lastInboundAt: null,
    });

  it("exactly 48h is NOT yet due; a minute past it is", () => {
    expect(findSilentAcceptedOffers([at(48)], NOW).due).toHaveLength(0);
    expect(findSilentAcceptedOffers([at(47.9)], NOW).due).toHaveLength(0);
    expect(findSilentAcceptedOffers([at(48.02)], NOW).due).toHaveLength(1);
  });

  it("honors a custom threshold", () => {
    expect(findSilentAcceptedOffers([at(30)], NOW, { silenceHours: 24 }).due).toHaveLength(1);
    expect(findSilentAcceptedOffers([at(30)], NOW, { silenceHours: 72 }).due).toHaveLength(0);
  });

  it("sorts oldest silence first, so a capped run pages the worst deals", () => {
    const scan = findSilentAcceptedOffers(
      [
        { ...at(60), id: "recB" } as Listing,
        { ...at(300), id: "recA" } as Listing,
        { ...at(100), id: "recC" } as Listing,
      ],
      NOW,
    );
    expect(scan.due.map((d) => d.recordId)).toEqual(["recA", "recC", "recB"]);
  });
});

describe("composeAcceptedSilenceCard", () => {
  const item = () => findSilentAcceptedOffers([listing({ lastOutboundAt: null })], NOW).due[0];
  const TODAY = "2026-09-12";

  it("titles the card with the address, the silence in days, and the missing contract", () => {
    expect(composeAcceptedSilenceCard(item(), TODAY).title).toBe(
      "1102 Montrose Ave: offer accepted, silent 9d, no executed contract",
    );
  });

  it("carries the money, the agent, both contact dates and the EMD cap as evidence", () => {
    expect(composeAcceptedSilenceCard(item(), TODAY).context).toEqual([
      "Accepted at $55,750.",
      "Agent: Sarah Kim.",
      "Last outbound: none recorded.",
      "Last inbound: 2026-09-03.",
      "Executed EMD cap is $3,000 across executed contracts.",
    ]);
  });

  it("omits the price line when the record has no number (never invents one)", () => {
    const noPrice = findSilentAcceptedOffers(
      [listing({ contractOfferPrice: null, outreachOfferPrice: null })],
      NOW,
    ).due[0];
    const ctx = composeAcceptedSilenceCard(noPrice, TODAY).context;
    expect(ctx.some((l) => l.includes("$55,750"))).toBe(false);
    expect(ctx[0]).toBe("Agent: Sarah Kim.");
    expect(ctx).toContain("Executed EMD cap is $3,000 across executed contracts.");
  });

  it("offers exactly three allowlisted taps with the operator-ruling note prefix", () => {
    const { options } = composeAcceptedSilenceCard(item(), TODAY);
    expect(options).toHaveLength(3);
    expect(options.map((o) => o.key)).toEqual(["nudge", "reopen", "walk"]);
    expect(options.map((o) => o.style)).toEqual(["primary", "secondary", "danger"]);
    for (const o of options) {
      expect(isAllowedCardAction(o.action.type), o.key).toBe(true);
      expect(o.action.recordId).toBe("recMONTROSE");
      expect(o.action.table).toBe("listings");
      expect(o.confirmation.length).toBeGreaterThan(0);
    }
    expect(options[0].action.note).toBe(
      "OPERATOR RULING via card 2026-09-12: NUDGE - send the agent a one-line status check on the accepted offer. Tier C cleared by operator tap.",
    );
    expect(options[1].action.note).toBe(
      "OPERATOR RULING via card 2026-09-12: RENEGOTIATE - Maverick drafts revised terms (EMD inside the $3,000 executed cap, inspection period) for operator review before anything is sent.",
    );
    expect(options[2].action.type).toBe("mark_dead");
    expect(options[2].action.note).toBeUndefined();
  });

  it("no tap can sign, send or move money — the allowlist is the whole trust boundary", () => {
    const types = composeAcceptedSilenceCard(item(), TODAY).options.map((o) => o.action.type);
    expect(types).toEqual(["append_note", "append_note", "mark_dead"]);
    expect(types).not.toContain("sign_contract");
    expect(types).not.toContain("send_buyer_blast");
  });
});

describe("composeAcceptedSilenceHeadline", () => {
  it("claims the days-since-acceptance only when the record carries that stamp", () => {
    const stamped = findSilentAcceptedOffers(
      [
        listing({
          lastOutboundAt: null,
          replyClassification: "acceptance",
          replyClassifiedAt: "2026-09-01T16:00:00.000Z",
        }),
      ],
      NOW,
    ).due[0];
    expect(composeAcceptedSilenceHeadline(stamped, NOW)).toBe(
      "STALLED: 1102 Montrose Ave. Offer accepted 11d ago at $55,750, silent 216h, no executed contract.",
    );
  });

  it("omits the 'Nd ago' clause when there is no acceptance stamp to source it from", () => {
    const item = findSilentAcceptedOffers([listing({ lastOutboundAt: null })], NOW).due[0];
    expect(composeAcceptedSilenceHeadline(item, NOW)).toBe(
      "STALLED: 1102 Montrose Ave. Offer accepted at $55,750, silent 216h, no executed contract.",
    );
  });

  it("omits the price when the record has none", () => {
    const item = findSilentAcceptedOffers(
      [listing({ lastOutboundAt: null, contractOfferPrice: null, outreachOfferPrice: null })],
      NOW,
    ).due[0];
    expect(composeAcceptedSilenceHeadline(item, NOW)).toBe(
      "STALLED: 1102 Montrose Ave. Offer accepted, silent 216h, no executed contract.",
    );
  });

  it("bills as GSM-7 — no smart characters reach the operator's phone", () => {
    const item = findSilentAcceptedOffers([listing()], NOW).due[0];
    const body = composeAcceptedSilenceHeadline(item, NOW);
    expect(findNonGsm7Chars(body)).toEqual([]);
    expect(estimateSmsSegments(body).encoding).toBe("gsm7");
  });
});

describe("acceptedSilenceKey", () => {
  it("is one page per record per UTC day", () => {
    expect(acceptedSilenceKey("2026-09-12", "recMONTROSE")).toBe(
      "accepted-silence:2026-09-12:recMONTROSE",
    );
    expect(acceptedSilenceKey("2026-09-13", "recMONTROSE")).not.toBe(
      acceptedSilenceKey("2026-09-12", "recMONTROSE"),
    );
  });
});
