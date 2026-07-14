// TWO-MAP RULE parity check (2026-07-14, the Mayfield counter miss).
//
// lib/airtable.ts holds two Listing field maps: the fld-ID map (bulk reads —
// getListings / getActiveListingsForBrief, i.e. EVERY cron) and the name map
// (single-record getListing). A field added to only one is silently null on
// the other read path — which dropped Mayfield's $27k counter from the
// decision math and disabled the crons' draft idempotency. This test pins
// the props that MUST be readable from both paths.

import { describe, it, expect } from "vitest";
import { __TEST_LISTING_MAPS, __TEST_LISTING_NAME_MAP } from "./airtable";

/** Props that crons AND single-record consumers both depend on. Add every
 *  new machine-managed field here when you add it to the maps. */
const BOTH_PATH_PROPS = [
  "draftReplyText",
  "draftReplyMeta",
  "ddVolleyState",
  "buyerCeiling",
  "dealSpread",
  "allInPctArv",
  "decisionVerdict",
  "decisionReason",
  "decisionComputedAt",
  "decisionInputsHash",
  "underwriteConfidence",
  "latestCounterUsd",
  "openerBasis",
  "roughOpenerAmount",
  "contractOfferPrice",
  "lastInboundAt",
  "lastOutboundAt",
];

describe("two-map rule: bulk (fld-ID) and single (name) reads see the same surface", () => {
  const idProps = new Set(Object.values(__TEST_LISTING_MAPS.byId));
  const nameProps = new Set(Object.values(__TEST_LISTING_NAME_MAP));

  for (const prop of BOTH_PATH_PROPS) {
    it(`"${prop}" is readable on BOTH paths`, () => {
      expect(idProps.has(prop), `missing from fld-ID map (bulk/cron reads)`).toBe(true);
      expect(nameProps.has(prop), `missing from name map (getListing)`).toBe(true);
    });
  }
});
